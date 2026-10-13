// Sobriazar server: login, synced history, and the calls to Gemini and Claude.
// Keys live only here, as Cloudflare secrets. They never reach the browser.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, engine TEXT, content TEXT NOT NULL, files TEXT, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, created)`,
  `CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage (month TEXT NOT NULL, engine TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (month, engine))`,
  `CREATE TABLE IF NOT EXISTS gemini_daily (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, first INTEGER NOT NULL)`,
];

// Claude prices in dollars per million tokens (from Anthropic's pricing page, Oct 2026).
const CLAUDE_PRICES = {
  "claude-haiku-5-5": (inTok) => (inTok <= 100000 ? [0.1, 0.5] : [0.5, 2.5]),
  "claude-sonnet-5-5": () => [2, 10],
  "claude-opus-5-5": () => [4, 20],
};

const STYLE = `Answer directly and clearly. Use plain formatting: short paragraphs, simple bullet or numbered lists, bold for key terms, and a table only when it truly helps.
Do not mention being an AI, do not add disclaimers, and do not end with offers like "let me know if you need anything else".
When asked for classroom materials, write for middle and high school students unless told otherwise.`;

const SESSION_DAYS = 90;
let schemaReady = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (!schemaReady) {
        await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
        schemaReady = true;
      }
      return await route(request, env, url);
    } catch (err) {
      return json({ error: err.message || "Something went wrong on the server." }, err.status || 500);
    }
  },
};

/* ---------------- routing ---------------- */

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });

  if (!env.APP_PASSWORD) throw httpError(500, "The APP_PASSWORD secret isn't set in Cloudflare yet.");
  if (!(await validSession(request, env))) return json({ error: "Please sign in." }, 401);
  if (method !== "GET" && !(request.headers.get("content-type") || "").includes("application/json")) {
    throw httpError(415, "Requests must be JSON.");
  }

  if (path === "/api/state" && method === "GET") return state(env);
  if (path === "/api/ask" && method === "POST") return ask(request, env);
  if (path === "/api/settings" && method === "PUT") return saveSettings(request, env);

  let m;
  if ((m = path.match(/^\/api\/threads\/([\w-]+)$/))) {
    const id = m[1];
    if (method === "GET") return getThread(env, id);
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM messages WHERE thread_id = ?").bind(id),
        env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === "PATCH") {
      const body = await request.json();
      const title = String(body.title || "").trim().slice(0, 120);
      if (!title) throw httpError(400, "Title can't be empty.");
      await env.DB.prepare("UPDATE threads SET title = ? WHERE id = ?").bind(title, id).run();
      return json({ ok: true });
    }
  }

  if (path === "/api/todos" && method === "POST") {
    const body = await request.json();
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) throw httpError(400, "Type a task first.");
    const todo = { id: uid(), text, done: 0, created: Date.now() };
    await env.DB.prepare("INSERT INTO todos (id, text, done, created) VALUES (?, ?, 0, ?)").bind(todo.id, todo.text, todo.created).run();
    return json({ todo });
  }
  if ((m = path.match(/^\/api\/todos\/([\w-]+)$/))) {
    const id = m[1];
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (method === "PATCH") {
      const body = await request.json();
      if ("done" in body) await env.DB.prepare("UPDATE todos SET done = ? WHERE id = ?").bind(body.done ? 1 : 0, id).run();
      if ("text" in body) await env.DB.prepare("UPDATE todos SET text = ? WHERE id = ?").bind(String(body.text).slice(0, 500), id).run();
      return json({ ok: true });
    }
  }
  if (path === "/api/todos/clear-done" && method === "POST") {
    await env.DB.prepare("DELETE FROM todos WHERE done = 1").run();
    return json({ ok: true });
  }

  throw httpError(404, "Not found.");
}

/* ---------------- auth ---------------- */

async function login(request, env) {
  if (!env.APP_PASSWORD) throw httpError(500, "The APP_PASSWORD secret isn't set in Cloudflare yet.");
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, first FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (row && now - row.first < 15 * 60 * 1000 && row.count >= 8) {
    throw httpError(429, "Too many wrong passwords. Wait 15 minutes and try again.");
  }
  const body = await request.json().catch(() => ({}));
  const ok = await safeEqual(String(body.password || ""), env.APP_PASSWORD);
  if (!ok) {
    if (!row || now - row.first >= 15 * 60 * 1000) {
      await env.DB.prepare("INSERT OR REPLACE INTO login_attempts (ip, count, first) VALUES (?, 1, ?)").bind(ip, now).run();
    } else {
      await env.DB.prepare("UPDATE login_attempts SET count = count + 1 WHERE ip = ?").bind(ip).run();
    }
    throw httpError(401, "That password isn't right.");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
  const exp = now + SESSION_DAYS * 864e5;
  const token = `${exp}.${await sign(env, String(exp))}`;
  return json({ ok: true }, 200, { "Set-Cookie": cookie(token, SESSION_DAYS * 86400) });
}

function cookie(value, maxAge) {
  return `sz_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function validSession(request, env) {
  const raw = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sz_session=([^;]+)/);
  if (!raw) return false;
  const [exp, sig] = raw[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env, exp));
}

async function hmacKey(env) {
  // Changing APP_PASSWORD signs every device out.
  const material = new TextEncoder().encode("sobriazar-session:" + env.APP_PASSWORD);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function sign(env, data) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ---------------- data ---------------- */

async function state(env) {
  const month = new Date().toISOString().slice(0, 7);
  const day = new Date().toISOString().slice(0, 10);
  const [threads, todos, settings, usage, gday] = await env.DB.batch([
    env.DB.prepare("SELECT id, title, updated FROM threads ORDER BY updated DESC LIMIT 200"),
    env.DB.prepare("SELECT id, text, done, created FROM todos ORDER BY done ASC, created DESC"),
    env.DB.prepare("SELECT key, value FROM settings"),
    env.DB.prepare("SELECT engine, requests, cost FROM usage WHERE month = ?").bind(month),
    env.DB.prepare("SELECT requests FROM gemini_daily WHERE day = ?").bind(day),
  ]);
  const s = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  const claude = usage.results.find((r) => r.engine === "claude") || { requests: 0, cost: 0 };
  const gemini = usage.results.find((r) => r.engine === "gemini") || { requests: 0, cost: 0 };
  return json({
    threads: threads.results,
    todos: todos.results,
    notes: s.notes || "",
    budget: Number(s.budget || 5),
    usage: {
      month,
      claudeCost: claude.cost,
      claudeRequests: claude.requests,
      geminiMonth: gemini.requests,
      geminiToday: gday.results[0]?.requests || 0,
    },
    keys: { gemini: Boolean(env.GEMINI_API_KEY), claude: Boolean(env.ANTHROPIC_API_KEY) },
  });
}

async function saveSettings(request, env) {
  const body = await request.json();
  const stmts = [];
  if ("notes" in body) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('notes', ?)").bind(String(body.notes).slice(0, 50000)));
  if ("budget" in body) {
    const b = Math.max(0, Math.min(1000, Number(body.budget) || 0));
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('budget', ?)").bind(String(b)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

async function getThread(env, id) {
  const thread = await env.DB.prepare("SELECT id, title, updated FROM threads WHERE id = ?").bind(id).first();
  if (!thread) throw httpError(404, "That conversation was deleted.");
  const { results } = await env.DB.prepare("SELECT id, role, engine, content, files, created FROM messages WHERE thread_id = ? ORDER BY created ASC").bind(id).all();
  return json({ thread, messages: results.map(parseFiles) });
}

function parseFiles(m) {
  return { ...m, files: m.files ? JSON.parse(m.files) : [] };
}

/* ---------------- asking ---------------- */

async function ask(request, env) {
  const body = await request.json();
  const text = String(body.text || "").trim();
  const files = Array.isArray(body.files) ? body.files.slice(0, 10) : [];
  const priv = Boolean(body.private);
  let mode = ["gemini", "claude", "best", "both"].includes(body.mode) ? body.mode : "gemini";
  if (priv && (mode === "gemini" || mode === "both")) mode = "claude";
  if (!text && !files.length) throw httpError(400, "Type something or attach a file.");

  const now = Date.now();
  let threadId = body.threadId;
  let history = [];
  if (threadId) {
    const exists = await env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first();
    if (!exists) threadId = null;
    else {
      const { results } = await env.DB.prepare("SELECT role, engine, content, files FROM messages WHERE thread_id = ? ORDER BY created DESC LIMIT 24").bind(threadId).all();
      history = results.reverse().map(parseFiles);
    }
  }
  if (!threadId) {
    threadId = uid();
    const title = (text || files.map((f) => f.name).join(", ")).replace(/\s+/g, " ").slice(0, 70);
    await env.DB.prepare("INSERT INTO threads (id, title, created, updated) VALUES (?, ?, ?, ?)").bind(threadId, title, now, now).run();
  }

  const fileNames = files.map((f) => ({ name: String(f.name || "file").slice(0, 120), type: String(f.type || "") }));
  const userMsg = { id: uid(), role: "user", engine: null, content: text, files: fileNames, created: now };
  await env.DB.prepare("INSERT INTO messages (id, thread_id, role, engine, content, files, created) VALUES (?, ?, 'user', NULL, ?, ?, ?)")
    .bind(userMsg.id, threadId, text, JSON.stringify(fileNames), now).run();

  const turn = { text, files };
  const jobs = [];
  if (mode === "gemini" || mode === "both") jobs.push(["gemini", () => callGemini(env, history, turn, "gemini")]);
  if (mode === "claude" || mode === "both") jobs.push(["claude", () => callClaude(env, history, turn, env.CLAUDE_FAST_MODEL || "claude-haiku-5-5", "claude")]);
  if (mode === "best") jobs.push(["best", () => bestAnswer(env, history, turn, priv)]);

  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const replies = [];
  const stmts = [];
  settled.forEach((r, i) => {
    const engine = jobs[i][0];
    const ok = r.status === "fulfilled";
    const content = ok ? r.value : `⚠ ${r.reason?.message || "No answer came back."}`;
    const msg = { id: uid(), role: ok ? "assistant" : "error", engine, content, files: [], created: Date.now() + i };
    replies.push(msg);
    stmts.push(env.DB.prepare("INSERT INTO messages (id, thread_id, role, engine, content, files, created) VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .bind(msg.id, threadId, msg.role, engine, content, msg.created));
  });
  stmts.push(env.DB.prepare("UPDATE threads SET updated = ? WHERE id = ?").bind(Date.now(), threadId));
  await env.DB.batch(stmts);

  return json({ threadId, user: userMsg, replies, mode });
}

async function bestAnswer(env, history, turn, priv) {
  const best = env.CLAUDE_BEST_MODEL || "claude-sonnet-5-5";
  if (priv || !env.GEMINI_API_KEY) return callClaude(env, history, turn, best, "best");
  let draft = "";
  try { draft = await callGemini(env, history, turn, "best"); } catch { /* fall back to Claude alone */ }
  if (!draft) return callClaude(env, history, turn, best, "best");
  const polishTurn = {
    files: turn.files,
    text: `${turn.text}\n\n---\nA first draft answer to the request above is below. Write the single best final answer: keep what is correct and useful, fix anything wrong or unclear, and fill gaps. Reply with only the final answer, not commentary about the draft.\n\nDRAFT:\n${draft}`,
  };
  return callClaude(env, history, polishTurn, best, "best");
}

function historyFor(history, engine) {
  // Keep the conversation readable for each engine: user turns, plus the answers that engine (or the best answer) gave.
  const out = [];
  history.forEach((m, idx) => {
    if (m.role === "user") {
      const note = m.files?.length ? `\n[Attached earlier: ${m.files.map((f) => f.name).join(", ")}]` : "";
      out.push({ role: "user", text: (m.content || "") + note || "(file)" });
    } else if (m.role === "assistant") {
      const prev = out[out.length - 1];
      const sameTurn = prev && prev.role === "assistant";
      const preferred = m.engine === engine || m.engine === "best";
      if (sameTurn) { if (preferred) prev.text = m.content; }
      else out.push({ role: "assistant", text: m.content });
    }
  });
  // Both APIs expect alternating roles, starting with the user.
  const clean = [];
  for (const m of out) {
    if (!m.text) continue;
    if (clean.length && clean[clean.length - 1].role === m.role) clean[clean.length - 1].text += "\n\n" + m.text;
    else clean.push({ ...m });
  }
  while (clean.length && clean[0].role !== "user") clean.shift();
  return clean;
}

async function callGemini(env, history, turn, label) {
  if (!env.GEMINI_API_KEY) throw httpError(400, "The Gemini key isn't set up yet.");
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const contents = historyFor(history, "gemini").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
  const parts = [];
  for (const f of turn.files) {
    if (f.kind === "text") parts.push({ text: `File "${f.name}":\n${f.text}` });
    else if (f.data) parts.push({ inline_data: { mime_type: f.type, data: f.data } });
  }
  parts.push({ text: turn.text || "Please look at the attached file." });
  contents.push({ role: "user", parts });

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: STYLE }] }, contents }),
  });
  const j = await r.json().catch(() => ({}));
  await recordGemini(env);
  if (!r.ok) {
    if (r.status === 429) throw new Error("G has hit today's free limit. It resets tomorrow — use C or Best for now.");
    throw new Error(j.error?.message || `G request failed (${r.status}).`);
  }
  const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("G didn't return an answer. Try rewording it.");
  return text;
}

async function callClaude(env, history, turn, model, label) {
  if (!env.ANTHROPIC_API_KEY) throw httpError(400, "The Claude key isn't set up yet.");
  const messages = historyFor(history, label === "best" ? "best" : "claude").map((m) => ({ role: m.role, content: m.text }));
  const content = [];
  for (const f of turn.files) {
    if (f.kind === "text") content.push({ type: "text", text: `File "${f.name}":\n${f.text}` });
    else if (f.type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    else if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) content.push({ type: "image", source: { type: "base64", media_type: f.type, data: f.data } });
  }
  content.push({ type: "text", text: turn.text || "Please look at the attached file." });
  messages.push({ role: "user", content });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8000, system: STYLE, messages }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `C request failed (${r.status}).`;
    if (/credit balance/i.test(msg)) throw new Error("C is out of credit. Add more in the Claude Console under Billing.");
    throw new Error(msg);
  }
  const inTok = j.usage?.input_tokens || 0, outTok = j.usage?.output_tokens || 0;
  const [pi, po] = (CLAUDE_PRICES[model] || CLAUDE_PRICES["claude-sonnet-5-5"])(inTok);
  await recordClaude(env, (inTok * pi + outTok * po) / 1e6);
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("C didn't return an answer. Try rewording it.");
  return text;
}

async function recordClaude(env, cost) {
  const month = new Date().toISOString().slice(0, 7);
  await env.DB.prepare("INSERT INTO usage (month, engine, requests, cost) VALUES (?, 'claude', 1, ?) ON CONFLICT(month, engine) DO UPDATE SET requests = requests + 1, cost = cost + excluded.cost")
    .bind(month, cost).run();
}
async function recordGemini(env) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO usage (month, engine, requests, cost) VALUES (?, 'gemini', 1, 0) ON CONFLICT(month, engine) DO UPDATE SET requests = requests + 1").bind(now.slice(0, 7)),
    env.DB.prepare("INSERT INTO gemini_daily (day, requests) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1").bind(now.slice(0, 10)),
  ]);
}

/* ---------------- helpers ---------------- */

function uid() {
  return crypto.randomUUID();
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
