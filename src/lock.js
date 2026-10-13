// Idle lock + passkeys (Face ID / fingerprint / Touch ID).
// Two cookies: sz_session (this device signed in, 90 days) and sz_awake (unlocked, slides 5 minutes on each real request).
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";

export const LOCK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pk_credentials (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT, name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pk_challenges (challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, created INTEGER NOT NULL)`,
];

export const AWAKE_MS = 5 * 60 * 1000;

const enc = new TextEncoder();
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function lockErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function sig(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode("sobriazar-awake:" + env.APP_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
}

export async function awakeCookie(env) {
  const exp = Date.now() + AWAKE_MS;
  return `sz_awake=${exp}.${await sig(env, String(exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(AWAKE_MS / 1000) + 60}`;
}
export const clearAwake = "sz_awake=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

export async function isAwake(request, env) {
  const raw = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sz_awake=([^;]+)/);
  if (!raw) return false;
  const [exp, s] = raw[1].split(".");
  if (!exp || !s || Number(exp) < Date.now()) return false;
  return s === (await sig(env, exp));
}

async function saveChallenge(env, challenge, kind) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pk_challenges WHERE created < ?").bind(Date.now() - 10 * 60 * 1000),
    env.DB.prepare("INSERT INTO pk_challenges (challenge, kind, created) VALUES (?, ?, ?)").bind(challenge, kind, Date.now()),
  ]);
}
function challengeCheck(env, kind) {
  return async (challenge) => {
    const row = await env.DB.prepare("DELETE FROM pk_challenges WHERE challenge = ? AND kind = ? RETURNING created").bind(challenge, kind).first();
    return Boolean(row && Date.now() - row.created < 10 * 60 * 1000);
  };
}

export async function listPasskeys(env) {
  const { results } = await env.DB.prepare("SELECT id, name, created, last_used FROM pk_credentials ORDER BY created DESC").all();
  return results;
}

export async function registerOptions(env, url) {
  const existing = await env.DB.prepare("SELECT id, transports FROM pk_credentials").all();
  const opts = await generateRegistrationOptions({
    rpName: "Sobriazar",
    rpID: url.hostname,
    userName: "Sobriazar owner",
    userID: enc.encode("sobriazar-owner"),
    attestationType: "none",
    excludeCredentials: existing.results.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
    preferredAuthenticatorType: "localDevice",
  });
  await saveChallenge(env, opts.challenge, "register");
  return opts;
}

export async function registerVerify(env, url, body) {
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challengeCheck(env, "register"),
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: true,
    });
  } catch (err) { throw lockErr(400, "Face ID setup didn't go through. Try again."); }
  if (!v.verified) throw lockErr(400, "Face ID setup didn't go through. Try again.");
  const c = v.registrationInfo.credential;
  const name = String(body.name || "This device").slice(0, 60);
  await env.DB.prepare("INSERT OR REPLACE INTO pk_credentials (id, public_key, counter, transports, name, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(c.id, b64(c.publicKey), c.counter || 0, JSON.stringify(c.transports || []), name, Date.now()).run();
  return { id: c.id, name };
}

export async function loginOptions(env, url) {
  const { results } = await env.DB.prepare("SELECT id, transports FROM pk_credentials").all();
  if (!results.length) throw lockErr(400, "No Face ID is set up yet. Use your password.");
  const opts = await generateAuthenticationOptions({
    rpID: url.hostname,
    allowCredentials: results.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    userVerification: "required",
  });
  await saveChallenge(env, opts.challenge, "login");
  return opts;
}

export async function loginVerify(env, url, body) {
  const id = String(body.response?.id || "");
  const row = await env.DB.prepare("SELECT id, public_key, counter, transports FROM pk_credentials WHERE id = ?").bind(id).first();
  if (!row) throw lockErr(400, "That Face ID isn't set up on Sobriazar anymore. Use your password.");
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challengeCheck(env, "login"),
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      credential: { id: row.id, publicKey: unb64(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
      requireUserVerification: true,
    });
  } catch { throw lockErr(401, "Face ID didn't match. Try again or use your password."); }
  if (!v.verified) throw lockErr(401, "Face ID didn't match. Try again or use your password.");
  await env.DB.prepare("UPDATE pk_credentials SET counter = ?, last_used = ? WHERE id = ?").bind(v.authenticationInfo.newCounter, Date.now(), row.id).run();
  return true;
}

export async function deletePasskey(env, id) {
  await env.DB.prepare("DELETE FROM pk_credentials WHERE id = ?").bind(id).run();
}
