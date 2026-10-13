// Google accounts for Sobriazar: sign-in, token storage, and the Calendar / Gmail / Drive tools the assistant can use.
// Scopes are deliberately narrow: calendar read-only, Gmail read + compose (drafts only, never send), Drive "drive.file"
// (only files you pick in the Drive picker or files Sobriazar creates itself).

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
];

export const GOOGLE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS g_accounts (email TEXT PRIMARY KEY, refresh_enc TEXT NOT NULL, access TEXT, access_exp INTEGER, status TEXT NOT NULL DEFAULT 'ok', added INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_states (nonce TEXT PRIMARY KEY, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_library (file_id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, url TEXT, added INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_folders (email TEXT PRIMARY KEY, folder_id TEXT NOT NULL)`,
];

const FOLDER_NAME = "Sobriazar";

/* ---------------- small helpers ---------------- */

function gErr(status, message) { const e = new Error(message); e.status = status; return e; }
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeUtf8(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function tokenKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sobriazar-google-tokens:" + env.GOOGLE_CLIENT_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), new TextEncoder().encode(text)));
  return b64(iv) + "." + b64(ct);
}
async function decrypt(env, blob) {
  const [iv, ct] = blob.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await tokenKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("sobriazar-oauth-state:" + env.APP_PASSWORD + env.GOOGLE_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return b64(sig).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
}

export function googleReady(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
function redirectUri(url) { return `${url.origin}/api/google/callback`; }

/* ---------------- sign-in flow ---------------- */

export async function startConnect(env, url) {
  if (!googleReady(env)) throw gErr(400, "Google isn't set up yet. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing in Cloudflare.");
  const nonce = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM g_states WHERE created < ?").bind(Date.now() - 15 * 60 * 1000),
    env.DB.prepare("INSERT INTO g_states (nonce, created) VALUES (?, ?)").bind(nonce, Date.now()),
  ]);
  const state = `${nonce}.${await hmac(env, nonce)}`;
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
}

export async function finishConnect(env, url) {
  const back = (msg) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sobriazar</title>
<body style="background:#06070a;color:#e8eaf0;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>${msg.replace(/[<>&]/g, "")}</p><script>setTimeout(function(){location.replace("/?google=" + ${JSON.stringify(encodeURIComponent(msg))})},400)</script></body>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

  if (url.searchParams.get("error")) return back("Google sign-in was cancelled.");
  const code = url.searchParams.get("code");
  const [nonce, sig] = String(url.searchParams.get("state") || "").split(".");
  if (!code || !nonce || !sig || sig !== (await hmac(env, nonce))) return back("That sign-in link expired. Try Connect again.");
  const st = await env.DB.prepare("DELETE FROM g_states WHERE nonce = ? RETURNING created").bind(nonce).first();
  if (!st || Date.now() - st.created > 15 * 60 * 1000) return back("That sign-in link expired. Try Connect again.");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: "authorization_code" }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) return back("Google didn't finish the sign-in. Try Connect again.");
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } }).then((x) => x.json()).catch(() => ({}));
  const email = String(info.email || "").toLowerCase();
  if (!email) return back("Couldn't read the account's email. Try Connect again.");

  const granted = String(t.scope || "");
  const missing = ["calendar.readonly", "gmail.readonly", "gmail.compose", "drive.file"].filter((s) => !granted.includes(s));

  let refreshEnc;
  if (t.refresh_token) refreshEnc = await encrypt(env, t.refresh_token);
  else {
    const old = await env.DB.prepare("SELECT refresh_enc FROM g_accounts WHERE email = ?").bind(email).first();
    if (!old) return back("Google didn't give long-term access. Remove Sobriazar at myaccount.google.com/permissions, then connect again.");
    refreshEnc = old.refresh_enc;
  }
  await env.DB.prepare(`INSERT INTO g_accounts (email, refresh_enc, access, access_exp, status, added) VALUES (?, ?, ?, ?, 'ok', ?)
    ON CONFLICT(email) DO UPDATE SET refresh_enc = excluded.refresh_enc, access = excluded.access, access_exp = excluded.access_exp, status = 'ok'`)
    .bind(email, refreshEnc, t.access_token, Date.now() + (t.expires_in || 3000) * 1000, Date.now()).run();
  const note = missing.length ? ` Some boxes were left unchecked (${missing.join(", ")}), so those parts won't work until you reconnect and allow them.` : "";
  return back(`Connected ${email}.${note}`);
}

export async function listAccounts(env) {
  const { results } = await env.DB.prepare("SELECT email, status, added FROM g_accounts ORDER BY added ASC").all();
  return results;
}

export async function disconnect(env, email) {
  const row = await env.DB.prepare("SELECT refresh_enc FROM g_accounts WHERE email = ?").bind(email).first();
  if (row) {
    try {
      const rt = await decrypt(env, row.refresh_enc);
      await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: rt }) });
    } catch { /* revoke is best-effort */ }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM g_accounts WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM g_library WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM g_folders WHERE email = ?").bind(email),
  ]);
}

async function accessToken(env, email) {
  const row = await env.DB.prepare("SELECT refresh_enc, access, access_exp, status FROM g_accounts WHERE email = ?").bind(email).first();
  if (!row) throw gErr(400, `${email} isn't connected.`);
  if (row.access && row.access_exp > Date.now() + 60000) return row.access;
  const rt = await decrypt(env, row.refresh_enc);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) {
    await env.DB.prepare("UPDATE g_accounts SET status = 'reconnect' WHERE email = ?").bind(email).run();
    throw gErr(401, `Google signed ${email} out. Tap Reconnect next to it in Accounts.`);
  }
  await env.DB.prepare("UPDATE g_accounts SET access = ?, access_exp = ?, status = 'ok' WHERE email = ?").bind(t.access_token, Date.now() + (t.expires_in || 3000) * 1000, email).run();
  return t.access_token;
}

async function gfetch(env, email, url, opts = {}) {
  const token = await accessToken(env, email);
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${token}` } });
  if (opts.raw) {
    if (!r.ok) throw gErr(r.status, `Google returned an error (${r.status}).`);
    return r;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `Google returned an error (${r.status}).`;
    if (r.status === 403 && /insufficient|scope/i.test(msg)) throw gErr(403, `${email} didn't allow this. Reconnect it and leave all the boxes checked.`);
    throw gErr(r.status, msg);
  }
  return j;
}

export async function pickerConfig(env, email) {
  if (!env.GOOGLE_API_KEY || !env.GOOGLE_PROJECT_NUMBER) throw gErr(400, "The Drive picker isn't set up yet (GOOGLE_API_KEY / GOOGLE_PROJECT_NUMBER).");
  return { token: await accessToken(env, email), apiKey: env.GOOGLE_API_KEY, appId: env.GOOGLE_PROJECT_NUMBER };
}

/* ---------------- library ---------------- */

export async function listLibrary(env) {
  const { results } = await env.DB.prepare("SELECT file_id AS id, email, name, mime, url, added FROM g_library ORDER BY added DESC").all();
  return results;
}
export async function addToLibrary(env, email, files) {
  const now = Date.now();
  const stmts = files.slice(0, 50).map((f, i) =>
    env.DB.prepare("INSERT OR REPLACE INTO g_library (file_id, email, name, mime, url, added) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(String(f.id).slice(0, 200), email, String(f.name || "Untitled").slice(0, 200), String(f.mimeType || "").slice(0, 120), String(f.url || "").slice(0, 500), now + i));
  if (stmts.length) await env.DB.batch(stmts);
}
export async function removeFromLibrary(env, id) {
  await env.DB.prepare("DELETE FROM g_library WHERE file_id = ?").bind(id).run();
}

/* ---------------- time helpers ---------------- */

function tzOffsetMs(tz, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - at;
}
function localMidnight(dateStr, tz) {
  const guess = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(guess)) throw gErr(400, `Bad date: ${dateStr}`);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
}
function fmtWhen(iso, tz, allDay) {
  if (allDay) return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) + " (all day)";
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* ---------------- tools ---------------- */

export const TOOLS = [
  {
    name: "calendar_events",
    description: "List events from the user's connected Google calendars (all accounts, including calendars shared with them) between two dates, inclusive. Use for questions about their schedule, day, week, meetings or availability.",
    input_schema: { type: "object", properties: {
      start_date: { type: "string", description: "First day, YYYY-MM-DD, in the user's time zone." },
      end_date: { type: "string", description: "Last day, YYYY-MM-DD, inclusive." },
      account: { type: "string", description: "Optional: one account email to limit to." },
    }, required: ["start_date", "end_date"] },
  },
  {
    name: "gmail_search",
    description: "Search the user's Gmail using Gmail search syntax (e.g. 'is:unread newer_than:1d', 'from:principal', 'subject:schedule'). Returns sender, subject, date and a short snippet. Searches all connected accounts unless one is given.",
    input_schema: { type: "object", properties: {
      query: { type: "string" }, account: { type: "string" }, max_results: { type: "integer", description: "1-15, default 8" },
    }, required: ["query"] },
  },
  {
    name: "gmail_read",
    description: "Read the full text of one email found with gmail_search.",
    input_schema: { type: "object", properties: { account: { type: "string" }, id: { type: "string" } }, required: ["account", "id"] },
  },
  {
    name: "gmail_create_draft",
    description: "Create an email DRAFT in the user's Gmail. It is never sent; the user reviews and sends it themselves. Use reply_to_id to draft a reply to a message from gmail_search.",
    input_schema: { type: "object", properties: {
      account: { type: "string" }, to: { type: "string" }, subject: { type: "string" }, body: { type: "string", description: "Plain text body." }, reply_to_id: { type: "string" },
    }, required: ["account", "body"] },
  },
  {
    name: "drive_library",
    description: "List the files the user has added to their Sobriazar Drive library (the only Drive files Sobriazar can see), plus files Sobriazar saved.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "drive_read",
    description: "Read the text of a file from the Drive library (Google Docs, Sheets, Slides, PDFs, text files).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "drive_save_doc",
    description: "Save content as a new Google Doc in the user's 'Sobriazar' Drive folder. Use only when the user asks to save or create a document.",
    input_schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "Markdown content." }, account: { type: "string" } }, required: ["title", "content"] },
  },
  {
    name: "tasks_list",
    description: "List the user's Sobriazar tasks (to-dos) with done/open status.",
    input_schema: { type: "object", properties: {} },
  },
];

export const TOOL_LABELS = {
  calendar_events: "Calendar", gmail_search: "Gmail", gmail_read: "Gmail", gmail_create_draft: "Gmail draft",
  drive_library: "Drive", drive_read: "Drive", drive_save_doc: "Saved to Drive", tasks_list: "Tasks",
};

function pickAccounts(accounts, account) {
  if (!account) return accounts;
  const a = accounts.find((x) => x.email === String(account).toLowerCase());
  if (!a) throw gErr(400, `${account} isn't a connected account. Connected: ${accounts.map((x) => x.email).join(", ")}`);
  return [a];
}

export async function runTool(env, name, input, ctx) {
  const accounts = ctx.accounts;
  const tz = ctx.tz;
  switch (name) {
    case "calendar_events": {
      const timeMin = new Date(localMidnight(input.start_date, tz)).toISOString();
      const endNext = new Date(Date.parse(input.end_date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
      const timeMax = new Date(localMidnight(endNext, tz)).toISOString();
      const out = [];
      for (const a of pickAccounts(accounts, input.account)) {
        try {
          const list = await gfetch(env, a.email, "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=50");
          const cals = (list.items || []).filter((c) => c.selected !== false || c.primary);
          for (const cal of cals.slice(0, 15)) {
            const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "100", timeZone: tz });
            const ev = await gfetch(env, a.email, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`).catch(() => ({ items: [] }));
            for (const e of ev.items || []) {
              if (e.status === "cancelled") continue;
              const allDay = Boolean(e.start?.date);
              out.push({
                sort: allDay ? Date.parse(e.start.date + "T00:00:00Z") : Date.parse(e.start?.dateTime),
                when: fmtWhen(allDay ? e.start.date : e.start?.dateTime, tz, allDay),
                ends: allDay ? "" : new Date(e.end?.dateTime).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
                title: e.summary || "(no title)",
                where: e.location || "",
                calendar: cal.primary ? `${a.email} (primary)` : `${cal.summary} · ${a.email}`,
              });
            }
          }
        } catch (err) { out.push({ sort: 0, error: `${a.email}: ${err.message}` }); }
      }
      out.sort((x, y) => x.sort - y.sort);
      if (!out.length) return "No events in that range.";
      return out.map((e) => e.error ? `! ${e.error}` : `- ${e.when}${e.ends ? "–" + e.ends : ""} | ${e.title}${e.where ? " | " + e.where : ""} | ${e.calendar}`).join("\n");
    }

    case "gmail_search": {
      const max = Math.max(1, Math.min(15, Number(input.max_results) || 8));
      const lines = [];
      for (const a of pickAccounts(accounts, input.account)) {
        try {
          const list = await gfetch(env, a.email, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: input.query, maxResults: String(max) })}`);
          const msgs = await Promise.all((list.messages || []).map((m) =>
            gfetch(env, a.email, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
          for (const m of msgs) {
            const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
            const unread = (m.labelIds || []).includes("UNREAD") ? " [unread]" : "";
            lines.push(`- account=${a.email} id=${m.id}${unread}\n  From: ${h.from || ""}\n  Subject: ${h.subject || ""}\n  Date: ${h.date || ""}\n  Snippet: ${(m.snippet || "").slice(0, 220)}`);
          }
        } catch (err) { lines.push(`! ${a.email}: ${err.message}`); }
      }
      return lines.length ? lines.join("\n") : "No matching emails.";
    }

    case "gmail_read": {
      const [a] = pickAccounts(accounts, input.account);
      const m = await gfetch(env, a.email, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.id)}?format=full`);
      const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      let plain = "", html = "";
      (function walk(p) {
        if (!p) return;
        if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64urlDecodeUtf8(p.body.data);
        if (p.mimeType === "text/html" && p.body?.data && !html) html = b64urlDecodeUtf8(p.body.data);
        (p.parts || []).forEach(walk);
      })(m.payload);
      const text = plain || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n");
      return `From: ${h.from || ""}\nTo: ${h.to || ""}\nSubject: ${h.subject || ""}\nDate: ${h.date || ""}\n\n${text.trim().slice(0, 9000)}`;
    }

    case "gmail_create_draft": {
      const [a] = pickAccounts(accounts, input.account || accounts[0]?.email);
      let to = input.to || "", subject = input.subject || "", threadId, refs = "";
      if (input.reply_to_id) {
        const m = await gfetch(env, a.email, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.reply_to_id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Reply-To`);
        const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
        threadId = m.threadId;
        to = to || h["reply-to"] || h.from || "";
        subject = subject || (/^re:/i.test(h.subject || "") ? h.subject : `Re: ${h.subject || ""}`);
        if (h["message-id"]) refs = h["message-id"];
      }
      const encSubj = /[^\x20-\x7e]/.test(subject) ? `=?UTF-8?B?${b64urlEncodeUtf8(subject).replace(/-/g, "+").replace(/_/g, "/")}?=` : subject;
      const raw = [
        to ? `To: ${to}` : "", `Subject: ${encSubj}`, refs ? `In-Reply-To: ${refs}` : "", refs ? `References: ${refs}` : "",
        "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", String(input.body || ""),
      ].filter((l, i, arr) => l !== "" || i === arr.length - 2).join("\r\n");
      const d = await gfetch(env, a.email, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { raw: b64urlEncodeUtf8(raw), ...(threadId ? { threadId } : {}) } }),
      });
      return `Draft created in ${a.email} (not sent). Draft id ${d.id}. Open drafts: https://mail.google.com/mail/u/${encodeURIComponent(a.email)}/#drafts`;
    }

    case "drive_library": {
      const lib = await listLibrary(env);
      if (!lib.length) return "The Drive library is empty. The user can add files with 'Add from Drive' in Sobriazar's Library panel.";
      return lib.map((f) => `- id=${f.id} | ${f.name} | ${f.mime} | account=${f.email}`).join("\n");
    }

    case "drive_read": {
      const f = await env.DB.prepare("SELECT file_id, email, name, mime FROM g_library WHERE file_id = ?").bind(input.id).first();
      if (!f) return "That file isn't in the Sobriazar library, so it can't be read. Ask the user to add it with 'Add from Drive'.";
      return `${f.name}\n\n${(await readDriveText(env, f.email, f.file_id, f.mime)).slice(0, 30000)}`;
    }

    case "drive_save_doc": {
      const a = pickAccounts(accounts, input.account || accounts[0]?.email)[0];
      const doc = await saveDoc(env, a.email, input.title, input.content);
      return `Saved "${doc.name}" to the Sobriazar folder in ${a.email}'s Drive: ${doc.url}`;
    }

    case "tasks_list": {
      const { results } = await env.DB.prepare("SELECT text, done FROM todos ORDER BY done ASC, created DESC").all();
      return results.length ? results.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n") : "No tasks.";
    }
  }
  throw gErr(400, `Unknown tool ${name}`);
}

async function readDriveText(env, email, id, mime) {
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
  const exportAs = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv", "application/vnd.google-apps.presentation": "text/plain" }[mime];
  if (exportAs) return (await gfetch(env, email, `${base}/export?mimeType=${encodeURIComponent(exportAs)}`, { raw: true })).text();
  if (/^text\/|json|csv|markdown/.test(mime)) return (await gfetch(env, email, `${base}?alt=media`, { raw: true })).text();
  if (mime === "application/pdf" || /officedocument|msword/.test(mime)) {
    // Convert a temporary copy to a Google Doc (Google does the text extraction), read it, then remove the copy.
    const folder = await ensureFolder(env, email);
    const copy = await gfetch(env, email, `${base}/copy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sobriazar-temp-read", mimeType: "application/vnd.google-apps.document", parents: [folder] }),
    });
    try {
      return await (await gfetch(env, email, `https://www.googleapis.com/drive/v3/files/${copy.id}/export?mimeType=text%2Fplain`, { raw: true })).text();
    } finally {
      await gfetch(env, email, `https://www.googleapis.com/drive/v3/files/${copy.id}`, { method: "DELETE", raw: true }).catch(() => {});
    }
  }
  return `(Sobriazar can't read this file type yet: ${mime})`;
}

async function ensureFolder(env, email) {
  const row = await env.DB.prepare("SELECT folder_id FROM g_folders WHERE email = ?").bind(email).first();
  if (row) {
    const ok = await gfetch(env, email, `https://www.googleapis.com/drive/v3/files/${row.folder_id}?fields=id,trashed`).catch(() => null);
    if (ok && !ok.trashed) return row.folder_id;
  }
  const q = `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await gfetch(env, email, `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)" })}`);
  let id = found.files?.[0]?.id;
  if (!id) {
    const made = await gfetch(env, email, "https://www.googleapis.com/drive/v3/files", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    id = made.id;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO g_folders (email, folder_id) VALUES (?, ?)").bind(email, id).run();
  return id;
}

export async function saveDoc(env, email, title, markdown) {
  const folder = await ensureFolder(env, email);
  const boundary = "sobriazar" + crypto.randomUUID().replace(/-/g, "");
  const meta = { name: String(title || "Sobriazar note").slice(0, 150), mimeType: "application/vnd.google-apps.document", parents: [folder] };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${mdToHtml(markdown)}\r\n--${boundary}--`;
  const f = await gfetch(env, email, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
    method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body,
  });
  await addToLibrary(env, email, [{ id: f.id, name: f.name, mimeType: f.mimeType, url: f.webViewLink }]);
  return { id: f.id, name: f.name, url: f.webViewLink };
}

/* Markdown → simple HTML that Google Docs imports cleanly. */
function mdToHtml(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  let out = "", i = 0;
  const LIST = /^\s*([-*•]|\d+[.)])\s+/;
  while (i < lines.length) {
    const l = lines[i];
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      out += '<table border="1" style="border-collapse:collapse"><tr>' + cells(l).map((c) => `<th>${c}</th>`).join("") + "</tr>"; i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) out += "<tr>" + cells(lines[i++]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
      out += "</table>"; continue;
    }
    if (LIST.test(l)) {
      const tag = /^\s*\d/.test(l) ? "ol" : "ul"; out += `<${tag}>`;
      while (i < lines.length && LIST.test(lines[i])) out += `<li>${inline(lines[i++].replace(LIST, ""))}</li>`;
      out += `</${tag}>`; continue;
    }
    if (!l.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(l)) { i++; continue; }
    const p = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) p.push(lines[i++]);
    out += `<p>${p.map(inline).join("<br>")}</p>`;
  }
  return `<html><body>${out}</body></html>`;
}

/* ---------------- deciding when to use accounts ---------------- */

const ACCOUNT_WORDS = /\b(calendar|calendars|schedule|scheduled|agenda|meeting|meetings|event|events|appointment|appointments|free time|available|availability|my day|my week|today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|brief|email|emails|e-mail|inbox|gmail|mail|unread|draft|reply|respond|drive|google doc|doc|docs|document|file|files|folder|library|pacing guide|lesson plan|lesson plans|save (this|it)|my tasks|to-?dos?)\b/i;
export function wantsAccounts(text) {
  return ACCOUNT_WORDS.test(text || "");
}
