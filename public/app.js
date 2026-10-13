/* Sobriazar client. All AI calls go through /api on our own server, so no keys live here. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const local = {
    get(k, d) { try { const v = localStorage.getItem("sz_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("sz_" + k, JSON.stringify(v)); } catch {} },
  };

  const DEFAULT_SKILLS = [
    { id: "plan", name: "Plan today", prompt: "Help me plan my day as a simple time-blocked list. Here's what I have going on:" },
    { id: "simplify", name: "Simplify", prompt: "Rewrite this so a 7th grader can understand it. Keep the key ideas and vocabulary:" },
    { id: "exit", name: "Exit ticket", prompt: "Write a short R.A.C.E. exit ticket (one question plus a model answer showing Restate, Answer, Cite, Explain) based on this:" },
    { id: "summary", name: "Summarize", prompt: "Summarize this in 3–5 clear bullet points:" },
    { id: "quiz", name: "Quiz", prompt: "Write 5 multiple-choice questions with an answer key based on this:" },
    { id: "tiered", name: "Tiered", prompt: "Rewrite this at three levels — below grade level, on grade level, and above grade level:" },
    { id: "email", name: "Email", prompt: "Write a short, friendly, professional email about this:" },
    { id: "spanish", name: "Spanish", prompt: "Translate this into clear, natural Spanish:" },
  ];
  const LABELS = { gemini: ["G", "g", "Result · G"], claude: ["C", "c", "Result · C"], best: ["★", "best", "Best result"] };
  const MAX_BYTES = 18 * 1024 * 1024;

  const S = {
    threads: [], todos: [], currentId: null, messages: [], mode: local.get("mode", "gemini"),
    priv: local.get("priv", false), files: [],
    skills: local.get("skills", null) || DEFAULT_SKILLS, skillUses: local.get("skillUses", {}), skillSort: local.get("skillSort", "used"), busy: false, notesDirty: false, budget: 5, lastSync: 0,
  };

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    const r = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers: opts.body ? { "content-type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "/login") { showLogin(); throw new Error(j.error || "Please sign in."); }
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status}).`);
    return j;
  }

  /* ---------------- login ---------------- */
  function showLogin() {
    $("#app").hidden = true; $("#login").hidden = false;
    galaxyLogin.start(); galaxyMain.stop();
    setTimeout(() => $("#pw").focus(), 50);
  }
  function showApp() {
    $("#login").hidden = true; $("#app").hidden = false; requestAnimationFrame(grow);
    galaxyLogin.stop(); galaxyMain.start();
  }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginErr").textContent = "";
    try {
      await api("/login", { method: "POST", body: { password: $("#pw").value } });
      $("#pw").value = ""; showApp(); await sync(true);
    } catch (err) { $("#loginErr").textContent = err.message; }
  });
  $("#logout").onclick = async () => { try { await api("/logout", { method: "POST" }); } catch {} showLogin(); };

  /* ---------------- sync ---------------- */
  async function sync(first) {
    let st;
    try { st = await api("/state"); } catch (err) { setStatus("off", "OFFLINE"); return; }
    showApp();
    S.threads = st.threads; S.todos = st.todos; S.budget = st.budget; S.lastSync = Date.now();
    if (!S.notesDirty && document.activeElement !== $("#notes")) $("#notes").value = st.notes;
    if (!$("#skillDlg").open) {
      S.skills = st.skills || DEFAULT_SKILLS; S.skillUses = st.skillUses || {}; S.skillSort = st.skillSort || "used";
      local.set("skills", S.skills); local.set("skillUses", S.skillUses); local.set("skillSort", S.skillSort);
      renderSkills();
    }
    renderUsage(st.usage); renderHistory(); renderTodos();
    if (first) {
      const last = local.get("thread", null);
      if (last && S.threads.some((t) => t.id === last)) openThread(last, true);
    } else if (S.currentId && !S.busy) {
      const t = S.threads.find((x) => x.id === S.currentId);
      if (!t) newChat();
      else if (t.updated !== S.currentUpdated) openThread(S.currentId, true);
    }
    if (!S.busy) setStatus("", "IDLE");
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.lastSync > 5000) sync(); });
  window.addEventListener("focus", () => { if (Date.now() - S.lastSync > 5000) sync(); });
  setInterval(() => { if (!document.hidden && !$("#app").hidden) sync(); }, 45000);

  function setStatus(kind, word) {
    const el = $("#statusLine");
    el.className = "status-line" + (kind ? " " + kind : "");
    el.innerHTML = `<span class="pip"></span> CORE · ${word} <span class="sep">·</span> ${kind === "off" ? "NOT CONNECTED" : "SYNCED"}`;
    $("#coreState").textContent = kind === "busy" ? "Working" : kind === "off" ? "Offline" : "Ready";
  }

  /* ---------------- usage ---------------- */
  function renderUsage(u) {
    $("#cCost").textContent = "$" + (u.claudeCost || 0).toFixed(2);
    $("#budgetBtn").textContent = "$" + S.budget;
    const pct = S.budget > 0 ? Math.min(100, ((u.claudeCost || 0) / S.budget) * 100) : 0;
    $("#cBar").style.width = pct + "%";
    $("#gToday").textContent = u.geminiToday || 0;
    $("#cReq").textContent = `${u.claudeRequests || 0} C requests`;
  }
  $("#budgetBtn").onclick = () => { const f = $("#budgetForm"); f.hidden = !f.hidden; $("#budgetIn").value = S.budget; if (!f.hidden) $("#budgetIn").focus(); };
  $("#budgetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/settings", { method: "PUT", body: { budget: Number($("#budgetIn").value) } }); $("#budgetForm").hidden = true; sync(); } catch (err) { alertInline(err.message); }
  });

  /* ---------------- clock ---------------- */
  function tick() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    $("#clock .hm").textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
    $("#clock .s").textContent = `:${p(d.getSeconds())}`;
    $("#clock .date").textContent = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  tick(); setInterval(tick, 1000);

  /* ---------------- todos ---------------- */
  function renderTodos() {
    const ul = $("#todos"); ul.innerHTML = "";
    if (!S.todos.length) ul.innerHTML = `<li class="empty" style="display:block">Nothing yet. Add a task above.</li>`;
    S.todos.forEach((t) => {
      const li = document.createElement("li"); if (t.done) li.className = "done";
      li.innerHTML = `<input type="checkbox" aria-label="Done" ${t.done ? "checked" : ""}><span class="t"></span><button class="x" type="button" aria-label="Delete task">×</button>`;
      li.querySelector(".t").textContent = t.text;
      li.querySelector("input").onchange = async (e) => { t.done = e.target.checked ? 1 : 0; renderTodos(); try { await api(`/todos/${t.id}`, { method: "PATCH", body: { done: !!t.done } }); } catch (err) { alertInline(err.message); } };
      li.querySelector(".x").onclick = async () => { S.todos = S.todos.filter((x) => x !== t); renderTodos(); try { await api(`/todos/${t.id}`, { method: "DELETE" }); } catch (err) { alertInline(err.message); } };
      ul.appendChild(li);
    });
    const open = S.todos.filter((t) => !t.done).length;
    $("#taskCount").textContent = S.todos.length ? `${open} open` : "";
    $("#clearDone").hidden = !S.todos.some((t) => t.done);
  }
  $("#todoForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#todoIn").value.trim(); if (!text) return;
    $("#todoIn").value = "";
    try { const { todo } = await api("/todos", { method: "POST", body: { text } }); S.todos.unshift(todo); renderTodos(); } catch (err) { alertInline(err.message); }
  });
  $("#clearDone").onclick = async () => { S.todos = S.todos.filter((t) => !t.done); renderTodos(); try { await api("/todos/clear-done", { method: "POST", body: {} }); } catch {} };

  /* ---------------- notes ---------------- */
  let noteTimer;
  $("#notes").addEventListener("input", () => {
    S.notesDirty = true; $("#noteState").textContent = "saving…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      try { await api("/settings", { method: "PUT", body: { notes: $("#notes").value } }); S.notesDirty = false; $("#noteState").textContent = "synced"; }
      catch { $("#noteState").textContent = "not saved — retrying"; noteTimer = setTimeout(() => $("#notes").dispatchEvent(new Event("input")), 4000); }
    }, 700);
  });

  /* ---------------- skills ---------------- */
  function orderedSkills() {
    const list = S.skills.map((k, i) => ({ ...k, i }));
    if (S.skillSort === "used") list.sort((a, b) => (S.skillUses[b.id] || 0) - (S.skillUses[a.id] || 0) || a.i - b.i);
    return list;
  }
  function renderSkills() {
    const list = orderedSkills();
    [$("#skills"), $("#skillsStrip")].forEach((box) => {
      box.innerHTML = "";
      list.forEach((k) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "skill"; b.textContent = k.name;
        b.title = k.prompt;
        b.onclick = () => runSkill(k);
        box.appendChild(b);
      });
    });
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "skill edit"; edit.textContent = "Edit";
    edit.onclick = openSkillEditor; $("#skillsStrip").appendChild(edit);
  }
  function runSkill(k) {
    S.skillUses[k.id] = (S.skillUses[k.id] || 0) + 1; local.set("skillUses", S.skillUses);
    api("/skills/use", { method: "POST", body: { id: k.id } }).catch(() => {});
    const q = $("#q"); const text = q.value.trim();
    setView("ask");
    if (text || S.files.length) { q.value = k.prompt + "\n\n" + text; grow(); send(); }
    else { q.value = k.prompt + "\n\n"; grow(); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    // Re-sort after a short pause so the button doesn't jump out from under your finger.
    if (S.skillSort === "used") setTimeout(renderSkills, 1200);
  }

  /* shortcut editor */
  let draft = [], draftSort = "used";
  function openSkillEditor() {
    draft = S.skills.map((k) => ({ ...k })); draftSort = S.skillSort;
    $("#skillErr").textContent = "";
    renderDraft(); $("#skillDlg").showModal();
  }
  function renderDraft() {
    $$("#skillDlg [data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === draftSort)));
    const ol = $("#skillRows"); ol.innerHTML = "";
    draft.forEach((k, i) => {
      const li = document.createElement("li"); li.className = "skill-row";
      const n = S.skillUses[k.id] || 0;
      li.innerHTML = `<div class="fields">
          <label class="sr" for="sk-name-${i}">Button name</label>
          <input id="sk-name-${i}" maxlength="40" placeholder="Button name">
          <label class="sr" for="sk-prompt-${i}">Instruction</label>
          <textarea id="sk-prompt-${i}" maxlength="2000" rows="2" placeholder="What should it do? e.g. Rewrite this as a measurable IEP goal:"></textarea>
          <span class="uses">${n ? `Used ${n} time${n === 1 ? "" : "s"}` : "Not used yet"}</span>
        </div>
        <div class="tools">
          <button class="btn icon" type="button" data-a="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn icon" type="button" data-a="down" aria-label="Move down" ${i === draft.length - 1 ? "disabled" : ""}>↓</button>
          <button class="btn icon del" type="button" data-a="del" aria-label="Delete shortcut">×</button>
        </div>`;
      const [nameIn, promptIn] = [li.querySelector("input"), li.querySelector("textarea")];
      nameIn.value = k.name; promptIn.value = k.prompt;
      nameIn.oninput = () => (k.name = nameIn.value);
      promptIn.oninput = () => (k.prompt = promptIn.value);
      li.querySelector('[data-a="up"]').onclick = () => { [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; renderDraft(); };
      li.querySelector('[data-a="down"]').onclick = () => { [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; renderDraft(); };
      li.querySelector('[data-a="del"]').onclick = () => { draft.splice(i, 1); renderDraft(); };
      ol.appendChild(li);
    });
  }
  $$("#skillDlg [data-sort]").forEach((b) => (b.onclick = () => { draftSort = b.dataset.sort; renderDraft(); }));
  $("#addSkill").onclick = () => {
    draft.push({ id: "s" + Date.now().toString(36), name: "", prompt: "" }); renderDraft();
    const rows = $$("#skillRows .skill-row"); const last = rows[rows.length - 1];
    last.scrollIntoView({ block: "nearest" }); last.querySelector("input").focus();
  };
  $("#resetSkills").onclick = () => { draft = DEFAULT_SKILLS.map((k) => ({ ...k })); renderDraft(); };
  $("#saveSkills").onclick = async () => {
    const clean = draft.map((k) => ({ id: k.id, name: k.name.trim(), prompt: k.prompt.trim() }));
    const half = clean.find((k) => !k.name !== !k.prompt);
    if (half) { $("#skillErr").textContent = "Each shortcut needs both a button name and an instruction."; return; }
    const keep = clean.filter((k) => k.name && k.prompt);
    if (!keep.length) { $("#skillErr").textContent = "Keep at least one shortcut, or tap Reset."; return; }
    $("#saveSkills").disabled = true;
    try {
      await api("/settings", { method: "PUT", body: { skills: keep, skillSort: draftSort } });
      S.skills = keep; S.skillSort = draftSort; local.set("skills", keep); local.set("skillSort", draftSort);
      renderSkills(); $("#skillDlg").close();
    } catch (err) { $("#skillErr").textContent = err.message; }
    finally { $("#saveSkills").disabled = false; }
  };
  $$(".edit-skills").forEach((b) => (b.onclick = openSkillEditor));
  renderSkills();

  /* ---------------- history ---------------- */
  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function renderHistory() {
    const term = $("#histSearch").value.trim().toLowerCase();
    const list = S.threads.filter((t) => !term || t.title.toLowerCase().includes(term));
    const ul = $("#history"); ul.innerHTML = "";
    $("#histCount").textContent = S.threads.length ? `${S.threads.length} saved` : "";
    if (!list.length) { ul.innerHTML = `<li class="empty" style="display:block">${term ? "No matches." : "Your searches will show up here on every device."}</li>`; return; }
    list.forEach((t) => {
      const li = document.createElement("li"); if (t.id === S.currentId) li.className = "active";
      li.innerHTML = `<button class="open" type="button"><span class="h-title"></span><span class="h-time">${ago(t.updated)}</span></button><button class="x" type="button" aria-label="Delete">×</button>`;
      li.querySelector(".h-title").textContent = t.title || "Untitled";
      li.querySelector(".open").onclick = () => { openThread(t.id); setView("ask"); };
      const x = li.querySelector(".x");
      x.onclick = async () => {
        if (!x.classList.contains("confirm")) { x.classList.add("confirm"); x.textContent = "Delete?"; setTimeout(() => { x.classList.remove("confirm"); x.textContent = "×"; }, 3000); return; }
        S.threads = S.threads.filter((y) => y.id !== t.id);
        if (S.currentId === t.id) newChat();
        renderHistory();
        try { await api(`/threads/${t.id}`, { method: "DELETE" }); } catch (err) { alertInline(err.message); }
      };
      ul.appendChild(li);
    });
  }
  $("#histSearch").addEventListener("input", renderHistory);

  async function openThread(id, quiet) {
    try {
      const { thread, messages } = await api(`/threads/${id}`);
      S.currentId = id; S.currentUpdated = thread.updated; S.messages = messages; local.set("thread", id);
      renderConvo(!quiet); renderHistory();
    } catch (err) { if (!quiet) alertInline(err.message); }
  }
  function newChat() {
    S.currentId = null; S.messages = []; local.set("thread", null);
    renderConvo(); renderHistory(); setView("ask"); $("#q").focus();
  }
  $("#newChat").onclick = newChat;

  /* ---------------- conversation ---------------- */
  function groupTurns(msgs) {
    const turns = [];
    msgs.forEach((m) => {
      if (m.role === "user") turns.push({ user: m, replies: [] });
      else if (turns.length) turns[turns.length - 1].replies.push(m);
    });
    return turns;
  }
  function renderConvo(scrollEnd = true) {
    const box = $("#convo"); box.innerHTML = "";
    document.body.classList.toggle("chatting", S.messages.length > 0 || S.busy);
    groupTurns(S.messages).forEach((t) => box.appendChild(turnEl(t.user, t.replies)));
    if (scrollEnd) requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
    galaxyMain.resize();
  }
  function turnEl(user, replies, pendingEngines) {
    const wrap = document.createElement("div"); wrap.className = "turn";
    const ask = document.createElement("div"); ask.className = "ask"; ask.textContent = user.content || "";
    if (user.files?.length) {
      const att = document.createElement("div"); att.className = "att";
      user.files.forEach((f) => { const c = document.createElement("span"); c.className = "chip ro"; c.innerHTML = "<span></span>"; c.firstChild.textContent = f.name; att.appendChild(c); });
      ask.appendChild(att);
    }
    wrap.appendChild(ask);
    const answers = document.createElement("div"); answers.className = "answers";
    const items = pendingEngines ? pendingEngines.map((e) => ({ engine: e, pending: true })) : replies;
    if (items.length > 1) answers.classList.add("two");
    items.forEach((m) => answers.appendChild(answerEl(m)));
    wrap.appendChild(answers);
    return wrap;
  }
  function answerEl(m) {
    const [letter, cls, label] = LABELS[m.engine] || LABELS.gemini;
    const el = document.createElement("article");
    el.className = "answer" + (m.role === "error" ? " err" : "");
    el.innerHTML = `<div class="src"><span class="dot ${cls}">${letter}</span>${label}</div><div class="body"></div>`;
    const body = el.querySelector(".body");
    if (m.pending) { body.innerHTML = `<div class="skel"><i></i><i></i><i></i><i></i></div>`; return el; }
    if (m.role === "error") { body.textContent = m.content.replace(/^⚠\s*/, ""); return el; }
    body.innerHTML = md(m.content);
    const a = document.createElement("div"); a.className = "actions";
    a.innerHTML = `<button class="act" type="button">Copy</button><button class="act" type="button">Copy plain text</button>`;
    const [rich, plainBtn] = a.children;
    rich.onclick = () => copy(rich, m.content, true);
    plainBtn.onclick = () => copy(plainBtn, m.content, false);
    el.appendChild(a);
    return el;
  }

  /* ---------------- sending ---------------- */
  const q = $("#q");
  function grow() { if (!q.offsetParent) return; q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, window.innerHeight * 0.38) + "px"; }
  q.addEventListener("input", grow);
  q.addEventListener("keydown", (e) => {
    const touch = matchMedia("(hover: none)").matches;
    if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });

  function enginesFor(mode) { return mode === "both" ? ["gemini", "claude"] : [mode]; }

  async function send() {
    const text = q.value.trim();
    if (S.busy || (!text && !S.files.length)) return;
    const mode = S.priv && (S.mode === "gemini" || S.mode === "both") ? "claude" : S.mode;
    const files = S.files.map((f) => f.payload);
    const user = { role: "user", content: text, files: S.files.map((f) => ({ name: f.name })) };

    S.busy = true; $("#send").disabled = true; setStatus("busy", "WORKING"); galaxyMain.setBusy(true, mode);
    q.value = ""; grow(); S.files = []; renderChips();
    document.body.classList.add("chatting");
    const pending = turnEl(user, [], enginesFor(mode));
    $("#convo").appendChild(pending);
    requestAnimationFrame(() => ($("#convo").scrollTop = $("#convo").scrollHeight));
    galaxyMain.resize();

    try {
      const res = await api("/ask", { method: "POST", body: { threadId: S.currentId, text, mode, files, private: S.priv } });
      if (S.currentId !== res.threadId) { S.currentId = res.threadId; local.set("thread", res.threadId); }
      S.messages.push(res.user, ...res.replies);
      pending.replaceWith(turnEl(res.user, res.replies));
      sync();
    } catch (err) {
      pending.querySelector(".answers").innerHTML = "";
      pending.querySelector(".answers").appendChild(answerEl({ role: "error", engine: mode === "both" ? "gemini" : mode, content: err.message }));
      if (!text) {} else if (!q.value) { q.value = text; grow(); }
    } finally {
      S.busy = false; $("#send").disabled = false; setStatus("", "IDLE"); galaxyMain.setBusy(false);
    }
  }

  /* ---------------- modes ---------------- */
  function renderMode() {
    $$(".seg button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
      b.disabled = S.priv && (b.dataset.mode === "gemini" || b.dataset.mode === "both");
    });
    $("#privBtn").setAttribute("aria-pressed", String(S.priv));
    galaxyMain.setTint(S.priv && (S.mode === "gemini" || S.mode === "both") ? "claude" : S.mode);
  }
  $$(".seg button").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; local.set("mode", S.mode); renderMode(); }));
  $("#privBtn").onclick = () => {
    S.priv = !S.priv; local.set("priv", S.priv);
    if (S.priv && (S.mode === "gemini" || S.mode === "both")) { S.mode = "claude"; local.set("mode", S.mode); }
    renderMode();
  };

  /* ---------------- files ---------------- */
  $("#fileIn").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  q.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("#drop").hidden = false; } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#drop").hidden = true; addFiles([...(e.dataTransfer?.files || [])]); });

  async function addFiles(list) {
    for (const file of list) {
      try {
        const payload = await readFile(file);
        const total = S.files.reduce((n, f) => n + f.size, 0) + payload._size;
        if (total > MAX_BYTES) { alertInline(`"${file.name}" is too big to add. Keep attachments under 18 MB total.`); continue; }
        S.files.push({ name: file.name, size: payload._size, payload: { name: file.name, type: payload.type, kind: payload.kind, data: payload.data, text: payload.text } });
      } catch (err) { alertInline(err.message); }
    }
    renderChips();
    if (S.files.length) setView("ask");
  }
  function renderChips() {
    const box = $("#fileChips"); box.innerHTML = "";
    S.files.forEach((f, i) => {
      const c = document.createElement("span"); c.className = "chip";
      c.innerHTML = `<span></span><button type="button" aria-label="Remove">×</button>`;
      c.firstChild.textContent = f.name;
      c.lastChild.onclick = () => { S.files.splice(i, 1); renderChips(); };
      box.appendChild(c);
    });
  }
  function b64(buf) {
    let s = ""; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function readFile(file) {
    const name = file.name.toLowerCase();
    const type = file.type || "";
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      const buf = await file.arrayBuffer();
      return { kind: "file", type: "application/pdf", data: b64(buf), _size: buf.byteLength };
    }
    if (type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/.test(name)) return readImage(file);
    if (name.endsWith(".docx")) {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
      const res = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const text = res.value.trim();
      if (!text) throw new Error(`Couldn't find any text in "${file.name}".`);
      return { kind: "text", type: "text/plain", text, _size: text.length };
    }
    if (type.startsWith("text/") || /\.(txt|md|csv)$/.test(name)) {
      const text = await file.text();
      return { kind: "text", type: "text/plain", text, _size: text.length };
    }
    throw new Error(`"${file.name}" isn't a type Sobriazar can read. Try a PDF, photo, Word file, or text file.`);
  }
  function readImage(file) {
    // Shrink big phone photos: faster, cheaper, and the same detail for reading text.
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const maxSide = 2000, scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const data = c.toDataURL("image/jpeg", 0.85).split(",")[1];
        resolve({ kind: "file", type: "image/jpeg", data, _size: data.length * 0.75 });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't open "${file.name}". Try saving it as a JPG or PNG.`)); };
      img.src = url;
    });
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      if ([...document.scripts].some((s) => s.src === src)) return res();
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the Word reader. Check your connection."));
      document.head.appendChild(s);
    });
  }

  /* ---------------- markdown ---------------- */
  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  const LIST = /^\s*([-*•]|\d+[.)])\s+/;
  function md(src) {
    const lines = String(src).replace(/\r/g, "").split("\n"); let html = "", i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) { const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; html += `<pre><code>${esc(code.join("\n"))}</code></pre>`; continue; }
      const h = l.match(/^(#{1,4})\s+(.*)/); if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        html += '<div class="tbl"><table><thead><tr>' + cells(l).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"; i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) html += "<tr>" + cells(lines[i++]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
        html += "</tbody></table></div>"; continue;
      }
      if (LIST.test(l)) {
        const tag = /^\s*\d/.test(l) ? "ol" : "ul"; html += `<${tag}>`;
        while (i < lines.length && (LIST.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && lines[i - 1].trim()))) {
          if (LIST.test(lines[i])) html += `<li>${inline(lines[i].replace(LIST, ""))}</li>`;
          else html = html.replace(/<\/li>$/, " " + inline(lines[i].trim()) + "</li>");
          i++;
        }
        html += `</${tag}>`; continue;
      }
      if (!l.trim()) { i++; continue; }
      const p = [l]; i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) p.push(lines[i++]);
      html += `<p>${p.map(inline).join("<br>")}</p>`;
    }
    return html;
  }
  function plain(src) {
    return String(src).replace(/```\w*\n?/g, "").replace(/^#{1,4}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/^\s*(-{3,}|\*{3,})\s*$/gm, "")
      .replace(/^(\s*)[-*]\s+/gm, "$1• ").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ---------------- copy ---------------- */
  async function copy(btn, raw, rich) {
    const text = plain(raw);
    let ok = false;
    try {
      if (rich && window.ClipboardItem && navigator.clipboard?.write) {
        const html = `<div style="font-family:Arial,sans-serif">${md(raw)}</div>`;
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      } else await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch {} ta.remove();
    }
    const old = btn.textContent; btn.textContent = ok ? "Copied" : "Select and copy manually"; btn.classList.toggle("done", ok);
    setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1500);
  }

  /* ---------------- views (phones / fold) ---------------- */
  function setView(v) {
    document.body.dataset.view = v;
    $$(".tabbar button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === v)));
    if (v === "ask") galaxyMain.resize();
  }
  $$(".tabbar button").forEach((b) => (b.onclick = () => {
    const wide = matchMedia("(min-width: 761px)").matches;
    setView(wide && document.body.dataset.view === b.dataset.view ? "ask" : b.dataset.view);
  }));

  function alertInline(msg) {
    const box = $("#convo");
    document.body.classList.add("chatting");
    const t = document.createElement("div"); t.className = "turn";
    t.innerHTML = `<article class="answer err"><div class="body"></div></article>`;
    t.querySelector(".body").textContent = msg;
    box.appendChild(t); box.scrollTop = box.scrollHeight;
    setTimeout(() => { t.remove(); if (!S.messages.length && !box.children.length) document.body.classList.remove("chatting"); }, 6000);
  }

  /* ---------------- galaxy ---------------- */
  function Galaxy(canvas) {
    const ctx = canvas.getContext("2d");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const TINTS = { gemini: [141, 182, 255], claude: [242, 176, 124], best: [143, 227, 180], both: [223, 230, 255] };
    let stars = [], w = 0, h = 0, dpr = 1, raf = 0, running = false, t = 0;
    let speed = 1, targetSpeed = 1, glow = 0, targetGlow = 0, tint = TINTS.gemini, tintNow = [...TINTS.gemini];

    function build() {
      const small = Math.min(w, h) < 400 || matchMedia("(max-width: 760px)").matches;
      const n = small ? 1500 : 3400;
      const arms = 3; stars = [];
      for (let i = 0; i < n; i++) {
        const core = Math.random() < 0.18;
        const r = core ? Math.pow(Math.random(), 2) * 0.22 : 0.08 + Math.pow(Math.random(), 0.8) * 0.92;
        const arm = (i % arms) * ((Math.PI * 2) / arms);
        const spread = (core ? 2.4 : 0.55) * (1 - r * 0.4) * (Math.random() - 0.5);
        stars.push({ r, a: arm + r * 5.2 + spread, s: Math.random() * 1.5 + 0.6, b: Math.random() * 0.6 + 0.55, tw: Math.random() * 6.28 });
      }
    }
    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const nw = Math.round(rect.width), nh = Math.round(rect.height);
      if (nw === w && nh === h) return;
      w = nw; h = nh; canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build(); if (!running) frame(true);
    }
    function frame(once) {
      speed += (targetSpeed - speed) * 0.04; glow += (targetGlow - glow) * 0.05;
      for (let k = 0; k < 3; k++) tintNow[k] += (tint[k] - tintNow[k]) * 0.05;
      t += reduced ? 0 : 0.0016 * speed;
      ctx.clearRect(0, 0, w, h);
      const compact = document.body.classList.contains("chatting");
      const cx = w / 2, cy = compact ? h * 0.34 : h * 0.46;
      const R = compact ? Math.min(w * 0.3, h * 0.32) : Math.min(w * 0.42, h * 0.5);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.45 + glow * 0.25));
      const [tr, tg, tb] = tintNow.map(Math.round);
      g.addColorStop(0, `rgba(${tr},${tg},${tb},${0.16 + glow * 0.18})`); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const st of stars) {
        const ang = st.a + t * (1.6 / (0.25 + st.r));
        const x = cx + Math.cos(ang) * st.r * R;
        const y = cy + Math.sin(ang) * st.r * R * 0.82;
        const twinkle = 0.75 + 0.25 * Math.sin(t * 40 + st.tw);
        const alpha = Math.min(1, st.b * twinkle * (1.15 - st.r * 0.55) * (1 + glow * 0.5));
        const mix = Math.max(0, 1 - st.r * 1.6);
        const cr = Math.round(tr + (255 - tr) * mix), cg = Math.round(tg + (255 - tg) * mix), cb = Math.round(tb + (255 - tb) * mix);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`;
        const s = st.s * (st.r < 0.15 ? 1.3 : 1);
        ctx.fillRect(x, y, s, s);
      }
      ctx.globalCompositeOperation = "source-over";
      if (!once && running) raf = requestAnimationFrame(() => frame());
    }
    return {
      start() { if (running) return; running = true; resize(); frame(); },
      stop() { running = false; cancelAnimationFrame(raf); },
      resize() { requestAnimationFrame(resize); setTimeout(resize, 450); },
      setBusy(b, mode) { targetSpeed = b ? 4.5 : 1; targetGlow = b ? 1 : 0; if (mode) tint = TINTS[mode] || tint; },
      setTint(mode) { tint = TINTS[mode] || TINTS.gemini; if (!running) frame(true); },
    };
  }
  const galaxyMain = Galaxy($("#core"));
  const galaxyLogin = Galaxy($("#loginCore"));
  window.addEventListener("resize", () => { galaxyMain.resize(); galaxyLogin.resize(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { galaxyMain.stop(); galaxyLogin.stop(); }
    else if (!$("#app").hidden) galaxyMain.start(); else galaxyLogin.start();
  });

  /* ---------------- boot ---------------- */
  renderMode(); setView("ask"); grow();
  sync(true).then(() => { if ($("#app").hidden && $("#login").hidden) showLogin(); });
})();
