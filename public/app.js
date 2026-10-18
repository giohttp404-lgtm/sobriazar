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
    { id: "brief", name: "Morning brief", prompt: "Give me my morning brief: today's schedule across all my calendars, anything important or unread in my email from the last day, and my open tasks. Keep it short and scannable." },
    { id: "plan", name: "Plan today", prompt: "Help me plan my day as a simple time-blocked list. Here's what I have going on:" },
    { id: "simplify", name: "Simplify", prompt: "Rewrite this so a 7th grader can understand it. Keep the key ideas and vocabulary:" },
    { id: "exit", name: "Exit ticket", prompt: "Write a short R.A.C.E. exit ticket (one question plus a model answer showing Restate, Answer, Cite, Explain) based on this:" },
    { id: "summary", name: "Summarize", prompt: "Summarize this in 3–5 clear bullet points:" },
    { id: "quiz", name: "Quiz", prompt: "Write 5 multiple-choice questions with an answer key based on this:" },
    { id: "tiered", name: "Tiered", prompt: "Rewrite this at three levels — below grade level, on grade level, and above grade level:" },
    { id: "email", name: "Email", prompt: "Write a short, friendly, professional email about this:" },
    { id: "spanish", name: "Spanish", prompt: "Translate this into clear, natural Spanish:" },
  ];
  const LABELS = { auto: ["A", "auto", "Auto"], gemini: ["G", "g", "Result · G"], claude: ["C", "c", "Result · C"], muse: ["M", "m", "Result · M"], best: ["★", "best", "Best result"] };
  const OFF_PRIVATE = ["gemini", "muse", "all"];
  const MAX_BYTES = 18 * 1024 * 1024;

  const S = {
    threads: [], todos: [], currentId: null, messages: [], mode: ((m) => (m === "both" ? "all" : m))(local.get("autoIntro", false) ? local.get("mode", "auto") : (local.set("autoIntro", true), local.set("mode", "auto"), "auto")), keys: { gemini: true, claude: true, muse: false },
    google: { ready: false, picker: false, accounts: [], library: [] }, forceAccounts: false, sendFrom: null,
    priv: local.get("priv", false), files: [],
    skills: local.get("skills", null) || DEFAULT_SKILLS, skillUses: local.get("skillUses", {}), skillSort: local.get("skillSort", "used"), busy: false, notesDirty: false, budget: 5, lastSync: 0,
  };

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    const r = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.bg ? { "x-sz-bg": "1" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "/login" && !path.startsWith("/passkey/login")) { showLogin(); throw new Error(j.error || "Please sign in."); }
    if (r.status === 423) { showLock(); const e = new Error("Locked."); e.locked = true; throw e; }
    if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status}).`);
    return j;
  }

  /* ---------------- login ---------------- */
  function showLogin(locked) {
    stopVoice();
    $("#app").hidden = true; $("#login").hidden = false;
    document.body.classList.toggle("is-locked", Boolean(locked));
    $("#loginSub").textContent = locked ? "Locked after 5 idle minutes" : "Sign in to continue";
    const pk = Boolean(locked && local.get("pkSet", false) && window.PublicKeyCredential);
    $("#pkBtn").hidden = !pk; $("#pkOr").hidden = !pk;
    $("#loginErr").textContent = "";
    galaxyLogin.start(); galaxyMain.stop();
    if (pk && !showLogin.autoTried && local.get("pkAuto", true)) { showLogin.autoTried = true; autoPasskey(); }
    else setTimeout(() => { if (!pk) $("#pw").focus(); }, 50);
  }
  function showLock() { if (!$("#login").hidden && document.body.classList.contains("is-locked")) return; showLogin.autoTried = false; showLogin(true); }
  function showApp() {
    $("#login").hidden = true; $("#app").hidden = false; requestAnimationFrame(grow);
    galaxyLogin.stop(); galaxyMain.start();
  }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginErr").textContent = "";
    try {
      await api("/login", { method: "POST", body: { password: $("#pw").value } });
      $("#pw").value = ""; markActive(); showApp(); await sync(true);
      offerPasskey();
    } catch (err) { $("#loginErr").textContent = err.message; }
  });
  $("#logout").onclick = async () => { try { await api("/logout", { method: "POST" }); } catch {} showLogin(); };

  /* ---------------- idle lock ---------------- */
  const IDLE_MS = 5 * 60 * 1000;
  let lastActive = Date.now();
  function markActive() { lastActive = Date.now(); }
  ["pointerdown", "keydown", "wheel", "touchstart", "input"].forEach((ev) => window.addEventListener(ev, markActive, { passive: true, capture: true }));
  async function lockNow() {
    try { await api("/lock", { method: "POST", body: {} }); } catch {}
    showLock();
  }
  setInterval(() => { if (!$("#app").hidden && !S.busy && !S.browsing && !voice.active && Date.now() - lastActive > IDLE_MS) lockNow(); }, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("#app").hidden && Date.now() - lastActive > IDLE_MS) lockNow();
  });

  /* ---------------- passkeys (Face ID / fingerprint) ---------------- */
  const b64u = {
    toBuf: (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; },
    fromBuf: (buf) => { let s = ""; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  };
  async function platformAvailable() {
    try { return Boolean(window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())); } catch { return false; }
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return "iPhone";
    if (/Android/.test(ua)) return /SM-|Galaxy/i.test(ua) ? "Galaxy phone" : /moto|razr/i.test(ua) ? "Razr" : "Android phone";
    if (/Macintosh/.test(ua)) return "Mac";
    return "This device";
  }
  async function setupPasskey() {
    try {
      const o = await api("/passkey/register/options", { method: "POST", body: {} });
      const cred = await navigator.credentials.create({ publicKey: {
        ...o, challenge: b64u.toBuf(o.challenge), user: { ...o.user, id: b64u.toBuf(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })),
      } });
      const r = cred.response;
      await api("/passkey/register/verify", { method: "POST", body: { name: deviceName(), response: {
        id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
        authenticatorAttachment: cred.authenticatorAttachment,
        response: { clientDataJSON: b64u.fromBuf(r.clientDataJSON), attestationObject: b64u.fromBuf(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
      } } });
      local.set("pkSet", true); toast("Face ID / fingerprint unlock is on for this device."); renderSecurity();
    } catch (err) {
      if (err.name === "InvalidStateError") { local.set("pkSet", true); toast("This device already has Face ID / fingerprint unlock."); renderSecurity(); return; }
      if (err.name !== "NotAllowedError") toast(err.message || "Couldn't set up Face ID / fingerprint.");
    }
  }
  // Only pop the Face ID / fingerprint prompt when you're actually looking at the page. Locking while the tab sits in the
  // background used to start the prompt with nobody there, and the browser showed "The request timed out".
  function autoPasskey() {
    const go = () => {
      if (document.hidden || !document.hasFocus() || $("#login").hidden) return false;
      window.removeEventListener("focus", tryGo); document.removeEventListener("visibilitychange", tryGo);
      setTimeout(() => unlockWithPasskey(true), 250); return true;
    };
    const tryGo = () => go();
    if (!go()) { window.addEventListener("focus", tryGo); document.addEventListener("visibilitychange", tryGo); }
  }
  async function unlockWithPasskey(auto) {
    auto = auto === true;
    $("#loginErr").textContent = "";
    try {
      const o = await api("/passkey/login/options", { method: "POST", body: {} });
      const cred = await navigator.credentials.get({ publicKey: {
        ...o, challenge: b64u.toBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })),
      } });
      const r = cred.response;
      await api("/passkey/login/verify", { method: "POST", body: { response: {
        id: cred.id, rawId: b64u.fromBuf(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
        authenticatorAttachment: cred.authenticatorAttachment,
        response: { clientDataJSON: b64u.fromBuf(r.clientDataJSON), authenticatorData: b64u.fromBuf(r.authenticatorData), signature: b64u.fromBuf(r.signature), userHandle: r.userHandle ? b64u.fromBuf(r.userHandle) : undefined },
      } } });
      local.set("pkAuto", true);
      markActive(); document.body.classList.remove("is-locked"); showApp(); await sync(true);
    } catch (err) {
      if (auto) { local.set("pkAuto", false); $("#loginErr").textContent = ""; return; } // this browser's prompt didn't work; stop popping it up, the button still works
      if (err.name === "NotAllowedError") $("#loginErr").textContent = "Face ID was cancelled. Tap the button to try again, or use your password.";
      else $("#loginErr").textContent = err.message || "Couldn't unlock. Use your password.";
    }
  }
  $("#pkBtn").onclick = () => unlockWithPasskey(false);
  $("#pkSetup").onclick = setupPasskey;
  $("#lockNow").onclick = lockNow;
  async function renderSecurity() {
    const ok = await platformAvailable();
    const on = local.get("pkSet", false);
    $("#pkSetup").hidden = !ok || on;
    $("#pkStatus").textContent = !ok ? "This browser can't use Face ID or fingerprint, so unlock uses your password."
      : on ? "Face ID or fingerprint unlock is on for this device." : "Face ID or fingerprint unlock isn't set up on this device.";
    try {
      const { passkeys } = await api("/passkeys", { bg: true });
      const ul = $("#pkList"); ul.innerHTML = "";
      passkeys.forEach((p) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="acct-dot"></span><span class="em"></span><button class="x" type="button" aria-label="Remove">×</button>`;
        li.querySelector(".em").textContent = `${p.name} · added ${new Date(p.created).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
        const x = li.querySelector(".x");
        x.onclick = async () => {
          if (!x.classList.contains("confirm")) { x.classList.add("confirm"); x.textContent = "Remove?"; setTimeout(() => { x.classList.remove("confirm"); x.textContent = "×"; }, 3000); return; }
          try { await api(`/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); toast(`Removed ${p.name}.`); renderSecurity(); } catch (err) { toast(err.message); }
        };
        ul.appendChild(li);
      });
      if (!passkeys.length && on) { local.set("pkSet", false); renderSecurity(); }
    } catch {}
  }
  async function offerPasskey() {
    renderSecurity();
    if (local.get("pkSet", false) || local.get("pkAsked", false) || !(await platformAvailable())) return;
    local.set("pkAsked", true);
    const t = $("#toast"); t.innerHTML = "";
    t.append("Unlock faster next time with Face ID or fingerprint.");
    const yes = document.createElement("button"); yes.className = "act"; yes.type = "button"; yes.textContent = "Set up";
    const no = document.createElement("button"); no.className = "act"; no.type = "button"; no.textContent = "Not now";
    yes.onclick = () => { t.hidden = true; setupPasskey(); }; no.onclick = () => (t.hidden = true);
    t.append(yes, no); t.hidden = false; clearTimeout(toast.timer);
  }

  /* ---------------- sync ---------------- */
  async function sync(first, bg) {
    let st;
    try { st = await api("/state", { bg }); } catch (err) { if (!err.locked) setStatus("off", "OFFLINE"); return; }
    showApp();
    S.threads = st.threads; S.todos = st.todos; S.budget = st.budget; S.lastSync = Date.now();
    if (!S.notesDirty && document.activeElement !== $("#notes")) $("#notes").value = st.notes;
    if (!$("#skillDlg").open) {
      S.skills = st.skills || DEFAULT_SKILLS; S.skillUses = st.skillUses || {}; S.skillSort = st.skillSort || "used";
      local.set("skills", S.skills); local.set("skillUses", S.skillUses); local.set("skillSort", S.skillSort);
      renderSkills();
    }
    S.keys = st.keys || S.keys;
    S.google = st.google || S.google; S.sendFrom = st.sendFrom || null; renderGoogle();
    if (S.mode === "muse" && !S.keys.muse) { S.mode = "gemini"; local.set("mode", S.mode); }
    renderMode();
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.lastSync > 5000) sync(false, true); });
  window.addEventListener("focus", () => { if (Date.now() - S.lastSync > 5000) sync(false, true); });
  setInterval(() => { if (!document.hidden && !$("#app").hidden) sync(false, true); }, 45000);

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
    $("#mRow").hidden = !S.keys.muse;
    $("#mMonth").textContent = u.museMonth || 0;
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
    // Keep the live mini-browser card on screen when the conversation re-draws.
    if (S.liveBrowse && S.liveBrowse.threadId === S.currentId) {
      const last = box.lastElementChild;
      (last?.querySelector(".answers") || last || box).appendChild(S.liveBrowse.el);
    }
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
    const usedList = (m.files || []).filter((f) => f.used);
    const routeNote = (m.files || []).find((f) => f.route);
    if (usedList.length || routeNote) {
      const u = document.createElement("div"); u.className = "used";
      if (routeNote) { const sp = document.createElement("span"); sp.className = "route"; sp.textContent = routeNote.route; u.appendChild(sp); }
      [...new Set(usedList.map((f) => f.name))].forEach((n) => { const sp = document.createElement("span"); sp.textContent = "Used " + n; u.appendChild(sp); });
      el.insertBefore(u, body);
    }
    const br = (m.files || []).find((f) => f.browse);
    if (br) {
      const fig = document.createElement("a"); fig.className = "browse-thumb"; fig.href = `/api/browse/${br.browse}/shot`; fig.target = "_blank"; fig.rel = "noopener";
      fig.innerHTML = `<img alt="Last screen in the mini browser" loading="lazy"><span>Last screen</span>`;
      fig.querySelector("img").src = `/api/browse/${br.browse}/shot`;
      fig.querySelector("img").onerror = () => fig.remove();
      el.insertBefore(fig, body);
    }
    const mail = (m.files || []).find((f) => f.email);
    if (mail && m.id) el.appendChild(mailCard(m.id, mail.email));
    const a = document.createElement("div"); a.className = "actions";
    a.innerHTML = `<button class="act" type="button">Copy</button><button class="act" type="button">Copy plain text</button>`;
    const [rich, plainBtn] = a.children;
    rich.onclick = () => copy(rich, m.content, true);
    plainBtn.onclick = () => copy(plainBtn, m.content, false);
    if (S.google.accounts.length) {
      const save = document.createElement("button"); save.type = "button"; save.className = "act"; save.textContent = "Save to Drive";
      save.onclick = () => saveToDrive(save, m.content);
      a.appendChild(save);
    }
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

  function enginesFor(mode) { return mode === "all" ? ["gemini", "claude", ...(S.keys.muse ? ["muse"] : [])] : [mode]; }
  function effectiveMode() { return S.priv && OFF_PRIVATE.includes(S.mode) ? "claude" : S.mode; }

  async function send() {
    const text = q.value.trim();
    const sw = text.match(/^(?:ok(?:ay)?\s+|please\s+)?(?:use|switch to|go back to|back to|change to)\s+(claude|gemini|google|muse|meta|best|auto|all)[.!]?$/i);
    if (sw && !S.files.length) {
      const m = { claude: "claude", gemini: "gemini", google: "gemini", muse: "muse", meta: "muse", best: "best", auto: "auto", all: "all" }[sw[1].toLowerCase()];
      const name = { claude: "C", gemini: "G", muse: "M", best: "Best", auto: "Auto", all: "All" }[m];
      q.value = ""; grow();
      if (m === "muse" && !S.keys.muse) { toast("M isn't set up yet."); return; }
      if (S.priv && OFF_PRIVATE.includes(m)) { toast(`Private is on, so ${name} is off. Turn off Private first.`); return; }
      S.mode = m; local.set("mode", m); renderMode();
      toast(`Switched to ${name}.`);
      if (voice.turn || voice.followUp) { voice.turn = false; speak(`Okay, using ${{ C: "Claude", G: "Gemini", M: "Muse" }[name] || name}.`); }
      return;
    }
    if (S.busy || (!text && !S.files.length)) return;
    const mode = effectiveMode();
    const files = S.files.map((f) => f.payload);
    const user = { role: "user", content: text, files: S.files.map((f) => ({ name: f.name })) };

    const force = S.forceAccounts;
    S.busy = true; $("#send").disabled = true; setStatus("busy", "WORKING"); galaxyMain.setBusy(true, mode);
    q.value = ""; grow(); S.files = []; renderChips();
    document.body.classList.add("chatting");
    const pending = turnEl(user, [], enginesFor(mode));
    $("#convo").appendChild(pending);
    requestAnimationFrame(() => ($("#convo").scrollTop = $("#convo").scrollHeight));
    galaxyMain.resize();

    try {
      const res = await api("/ask", { method: "POST", body: { threadId: S.currentId, text, mode, files, private: S.priv, voice: Boolean(voice.turn), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(S.forceAccounts ? { useAccounts: true } : {}) } });
      if (S.currentId !== res.threadId) { S.currentId = res.threadId; local.set("thread", res.threadId); }
      S.messages.push(res.user, ...res.replies);
      pending.replaceWith(turnEl(res.user, res.replies));
      if (res.browse) { const wasVoice = voice.turn; voice.turn = false; watchBrowse(res.browse.id, res.threadId, wasVoice); }
      else afterAnswer(res.replies);
      sync();
    } catch (err) {
      pending.querySelector(".answers").innerHTML = "";
      pending.querySelector(".answers").appendChild(answerEl({ role: "error", engine: mode === "all" ? "gemini" : mode, content: err.message }));
      if (!text) {} else if (!q.value) { q.value = text; grow(); }
    } finally {
      S.busy = false; S.forceAccounts = false; $("#send").disabled = false; setStatus("", "IDLE"); galaxyMain.setBusy(false);
    }
  }

  /* ---------------- modes ---------------- */
  function renderMode() {
    $$(".compose-opts .seg button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
      b.disabled = S.priv && OFF_PRIVATE.includes(b.dataset.mode);
      if (b.dataset.mode === "muse") b.hidden = !S.keys.muse;
    });
    $("#privBtn").setAttribute("aria-pressed", String(S.priv));
    galaxyMain.setTint(effectiveMode());
  }
  $$(".compose-opts .seg button").forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; local.set("mode", S.mode); renderMode(); }));
  $("#privBtn").onclick = () => {
    S.priv = !S.priv; local.set("priv", S.priv);
    if (S.priv && OFF_PRIVATE.includes(S.mode)) { S.mode = "claude"; local.set("mode", S.mode); }
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
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load a needed script. Check your connection."));
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

  /* ---------------- google ---------------- */
  function toast(msg, ms = 5000) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms);
  }
  function renderGoogle() {
    const g = S.google;
    $("#googleHint").hidden = g.ready;
    $("#connectBtn").hidden = !g.ready;
    $("#connectBtn").textContent = g.accounts.length ? "+ Add another account" : "+ Connect Google account";
    $("#briefBtn").hidden = !g.accounts.length;
    $("#libraryPanel").hidden = !g.accounts.length;
    $("#addDrive").hidden = !g.picker;
    const ul = $("#accts"); ul.innerHTML = "";
    g.accounts.forEach((a) => {
      const li = document.createElement("li");
      const bad = a.status !== "ok";
      li.innerHTML = `<span class="acct-dot ${bad ? "bad" : ""}"></span><span class="em"></span>` +
        (bad ? `<a class="link reconnect" href="/api/google/start">Reconnect</a>` : `<button class="x" type="button" aria-label="Disconnect">×</button>`);
      li.querySelector(".em").textContent = a.email;
      const x = li.querySelector(".x");
      if (x) x.onclick = async () => {
        if (!x.classList.contains("confirm")) { x.classList.add("confirm"); x.textContent = "Disconnect?"; setTimeout(() => { x.classList.remove("confirm"); x.textContent = "×"; }, 3000); return; }
        try { await api(`/google/accounts/${encodeURIComponent(a.email)}`, { method: "DELETE" }); toast(`Disconnected ${a.email}.`); sync(); } catch (err) { toast(err.message); }
      };
      ul.appendChild(li);
    });
    const sel = $("#sendFrom");
    $("#sendFromRow").hidden = g.accounts.length < 1;
    if (document.activeElement !== sel) {
      sel.innerHTML = "";
      g.accounts.forEach((a) => { const o = document.createElement("option"); o.value = a.email; o.textContent = a.email; sel.appendChild(o); });
      if (S.sendFrom) sel.value = S.sendFrom;
    }
    const lib = $("#library"); lib.innerHTML = "";
    if (!g.library.length) lib.innerHTML = `<li class="empty" style="display:block">Nothing here yet.</li>`;
    g.library.forEach((f) => {
      const li = document.createElement("li");
      const kind = /document/.test(f.mime) ? "doc" : /spreadsheet/.test(f.mime) ? "sheet" : /presentation/.test(f.mime) ? "slides" : /pdf/.test(f.mime) ? "pdf" : "file";
      li.innerHTML = `<span class="ftype">${kind}</span>${f.url ? `<a class="nm" target="_blank" rel="noopener"></a>` : `<span class="nm"></span>`}<button class="x" type="button" aria-label="Remove from library">×</button>`;
      const nm = li.querySelector(".nm"); nm.textContent = f.name; if (f.url) nm.href = f.url;
      li.querySelector(".x").onclick = async () => {
        S.google.library = S.google.library.filter((y) => y.id !== f.id); renderGoogle();
        try { await api(`/library/${encodeURIComponent(f.id)}`, { method: "DELETE" }); } catch (err) { toast(err.message); }
      };
      lib.appendChild(li);
    });
  }
  $("#connectBtn").onclick = () => { location.href = "/api/google/start"; };
  $("#sendFrom").onchange = async (e) => {
    const v = e.target.value;
    try { await api("/settings", { method: "PUT", body: { sendFrom: v } }); S.sendFrom = v; toast(`Emails will send from ${v}.`); }
    catch (err) { toast(err.message); e.target.value = S.sendFrom || ""; }
  };
  $("#briefBtn").onclick = () => {
    setView("ask");
    S.forceAccounts = true;
    $("#q").value = "Give me my morning brief: today's schedule across all my calendars, anything important or unread in my email from the last day, and my open tasks. Keep it short and scannable.";
    grow(); send();
  };

  async function saveToDrive(btn, content) {
    let account = S.google.accounts[0]?.email;
    if (S.google.accounts.length > 1) {
      const pick = await chooseAccount(btn, "Save to which account?"); if (!pick) return; account = pick;
    }
    const firstLine = String(content).split("\n").find((l) => l.trim()) || "Sobriazar note";
    const title = firstLine.replace(/^#+\s*|\*\*/g, "").slice(0, 80);
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await api("/drive/save", { method: "POST", body: { account, title, content } });
      S.google.library = res.library; renderGoogle();
      const link = document.createElement("a"); link.className = "act link-out done"; link.href = res.doc.url; link.target = "_blank"; link.rel = "noopener"; link.textContent = "Saved · Open in Drive";
      btn.replaceWith(link);
    } catch (err) { btn.disabled = false; btn.textContent = "Save to Drive"; toast(err.message); }
  }

  function chooseAccount(anchor, label) {
    return new Promise((resolve) => {
      const box = document.createElement("div"); box.className = "actions";
      const lab = document.createElement("span"); lab.className = "hint"; lab.style.margin = "0"; lab.textContent = label; box.appendChild(lab);
      S.google.accounts.forEach((a) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "act"; b.textContent = a.email;
        b.onclick = () => { box.remove(); anchor.hidden = false; resolve(a.email); }; box.appendChild(b);
      });
      const c = document.createElement("button"); c.type = "button"; c.className = "act"; c.textContent = "Cancel";
      c.onclick = () => { box.remove(); anchor.hidden = false; resolve(null); }; box.appendChild(c);
      anchor.hidden = true; anchor.after(box);
    });
  }

  $("#addDrive").onclick = async () => {
    const btn = $("#addDrive");
    let account = S.google.accounts[0]?.email;
    if (S.google.accounts.length > 1) { account = await chooseAccount(btn, "Pick from which account?"); if (!account) return; }
    try {
      const cfg = await api(`/google/picker?account=${encodeURIComponent(account)}`);
      await loadScript("https://apis.google.com/js/api.js");
      await new Promise((res) => window.gapi.load("picker", res));
      const P = window.google.picker;
      const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST);
      const picker = new P.PickerBuilder()
        .addView(view)
        .enableFeature(P.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(cfg.token).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId)
        .setTitle("Add files to Sobriazar")
        .setCallback(async (data) => {
          if (data[P.Response.ACTION] !== P.Action.PICKED) return;
          const files = data[P.Response.DOCUMENTS].map((d) => ({ id: d[P.Document.ID], name: d[P.Document.NAME], mimeType: d[P.Document.MIME_TYPE], url: d[P.Document.URL] }));
          try { const res = await api("/library", { method: "POST", body: { account, files } }); S.google.library = res.library; renderGoogle(); toast(`Added ${files.length} file${files.length === 1 ? "" : "s"} to your library.`); }
          catch (err) { toast(err.message); }
        })
        .build();
      picker.setVisible(true);
    } catch (err) { toast(err.message || "Couldn't open the Drive picker."); }
  };

  (function googleReturn() {
    const p = new URLSearchParams(location.search);
    if (p.has("google")) { const msg = p.get("google"); history.replaceState(null, "", "/"); setTimeout(() => toast(msg, 7000), 600); }
  })();

  // Usage stays hidden until hovered; on phones, tap the Usage heading to show or hide it.
  $("#usagePanel .label").addEventListener("click", () => $("#usagePanel").classList.toggle("open"));
  if (matchMedia("(hover: none)").matches) $("#usagePanel .usage-hint").textContent = "this month · tap to show";

  /* ---------------- mini browser: live view while it works ---------------- */
  function watchBrowse(id, threadId, spoken) {
    S.browsing = true;
    const turn = $("#convo").lastElementChild;
    const card = document.createElement("article");
    card.className = "answer browse-live";
    card.innerHTML = `<div class="src"><span class="dot g">🌐</span>Mini browser</div>
      <div class="bl-bar"><span class="bl-dot"></span><span class="bl-url">Starting a browser…</span></div>
      <div class="bl-screen"><img alt="What the mini browser sees"><div class="bl-wait">Opening a browser in the cloud…</div></div>
      <ol class="bl-steps"></ol>
      <div class="actions"><button class="act" type="button">Stop</button><span class="bl-state">Working · it only looks, never submits anything</span></div>`;
    (turn?.querySelector(".answers") || turn || $("#convo")).appendChild(card);
    S.liveBrowse = { id, threadId, el: card };
    const img = card.querySelector("img"), urlEl = card.querySelector(".bl-url"), steps = card.querySelector(".bl-steps"), stateEl = card.querySelector(".bl-state");
    const stopBtn = card.querySelector(".actions .act");
    let lastShot = 0, done = false, misses = 0;
    if (spoken) speak("Okay, I'm opening the browser. I'll tell you what I find.", () => {});
    stopBtn.onclick = async () => { stopBtn.disabled = true; stopBtn.textContent = "Stopping…"; try { await api(`/browse/${id}/stop`, { method: "POST" }); } catch (err) { toast(err.message); } };
    const finish = async (v) => {
      done = true; S.browsing = false; stopBtn.remove(); S.liveBrowse = null; card.remove();
      stateEl.textContent = v.status === "done" ? "Done" : v.status === "stopped" ? "Stopped" : `Stopped: ${v.error || "something went wrong"}`;
      card.classList.add("finished");
      await sync();
      if (S.currentId === threadId) await openThread(threadId, true);
      if (spoken || $("#speakToggle").checked || $("#glassesToggle").checked) {
        const last = [...S.messages].reverse().find((m) => m.role === "assistant");
        if (last) speak(speakable(last.content));
      }
    };
    const tick = async () => {
      if (done) return;
      let v;
      try { v = await api(`/browse/${id}`, { bg: true }); misses = 0; }
      catch (err) { if (err.locked || ++misses > 20) { S.browsing = false; return; } return setTimeout(tick, 2500); }
      urlEl.textContent = v.url ? `${v.title ? v.title + " · " : ""}${v.url}` : "Searching for where to start…";
      if (v.shotAt && v.shotAt !== lastShot) {
        lastShot = v.shotAt;
        img.src = `/api/browse/${id}/shot?t=${v.shotAt}`;
        img.onload = () => card.querySelector(".bl-wait")?.remove();
      }
      const box = $("#convo"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
      steps.innerHTML = v.steps.map((st) => `<li>${esc(st.note || "")}</li>`).join("");
      if (near) box.scrollTop = box.scrollHeight;
      if (v.status !== "running") return finish(v);
      setTimeout(tick, 1500);
    };
    tick();
  }

  /* ---------------- voice (works through Bluetooth glasses) ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voice = { active: false, rec: null, turn: false, audio: null, convo: false };
  const STOP_WORDS = /^(stop|stop listening|that'?s all|that is all|thanks|thank you|never ?mind|goodbye|bye|i'?m done|done)[.!]?$/i;
  $("#micBtn").hidden = !SR;
  if (!SR) $("#voiceHint").textContent = "This browser can't listen. Chrome on your Galaxy or Razr works best; answers can still be read out loud.";
  $("#speakToggle").checked = local.get("speak", false);
  $("#speakToggle").onchange = (e) => local.set("speak", e.target.checked);

  function voiceBar(text, show = true) { $("#voiceText").textContent = text; $("#voiceBar").hidden = !show; }
  function stopVoice() {
    try { voice.rec && voice.rec.abort(); } catch {}
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
    voice.active = false; voice.rec = null; $("#micBtn").classList.remove("on"); voiceBar("", false);
  }
  $("#voiceStop").onclick = () => { if (voice.countdown) { voice.countdown.cancel(); return; } voice.turn = false; voice.convo = false; voice.email = null; stopVoice(); };

  function startListening() {
    if (voice.countdown) { voice.countdown.cancel(); return; }
    if (voice.once) { try { voice.once.abort(); } catch {} return; }
    if (!SR || $("#app").hidden) return;
    if (voice.active) { voice.convo = false; stopVoice(); return; }
    voice.convo = true;
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
    setView("ask"); markActive();
    const rec = new SR();
    rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = "";
    voice.rec = rec; voice.active = true; $("#micBtn").classList.add("on"); voiceBar(voice.followUp ? "Listening for a follow-up… say \u201cstop\u201d to end" : "Listening…");
    rec.onresult = (e) => {
      let interim = ""; finalText = "";
      for (const r of e.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
      q.value = (finalText + interim).trim(); grow(); markActive();
    };
    rec.onerror = (e) => {
      const msg = { "not-allowed": "Sobriazar needs microphone access. Allow it in your browser's site settings.", "no-speech": "Didn't hear anything. Tap to try again.", "audio-capture": "No microphone found. Check that your glasses are connected." }[e.error];
      if (e.error === "no-speech" && voice.followUp) return;
      if (msg) toast(msg);
    };
    rec.onend = () => {
      voice.active = false; voice.rec = null; $("#micBtn").classList.remove("on"); voiceBar("", false);
      const text = q.value.trim();
      const wasFollow = voice.followUp; voice.followUp = false;
      if (!text) { voice.convo = false; if (wasFollow) voiceBar("", false); return; }
      if (STOP_WORDS.test(text)) { q.value = ""; grow(); voice.convo = false; return; }
      voice.turn = true; send();
    };
    try { rec.start(); } catch { stopVoice(); }
  }
  $("#micBtn").onclick = startListening;

  function speakable(md) {
    return plain(md).split("\n").filter((l) => !/^\s*\|/.test(l)).join("\n")
      .replace(/https?:\/\/\S+/g, "link").replace(/[•*#_`>]/g, " ").replace(/\s+\n/g, "\n").trim();
  }
  function pickVoice() {
    const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    const lang = (navigator.language || "en-US").slice(0, 2);
    return vs.find((v) => /Google US English|Samantha|Ava|Natural/i.test(v.name) && v.lang.startsWith(lang)) || vs.find((v) => v.lang.startsWith(lang)) || null;
  }
  function speak(text, then) {
    if (!window.speechSynthesis || !text) { if (then) then(); return; }
    let t = text; if (t.length > 1600) { const cut = t.lastIndexOf(".", 1600); t = t.slice(0, cut > 400 ? cut + 1 : 1600) + " The rest is on screen."; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = 1.05;
    u.onstart = () => voiceBar("Speaking…");
    u.onend = () => { voiceBar("", false); if (then) then(); else listenAgain(); };
    u.onerror = () => { voiceBar("", false); if (then) then(); };
    speechSynthesis.speak(u);
  }
  function listenAgain() {
    if (!voice.convo || voice.active || $("#app").hidden) return;
    voice.followUp = true;
    setTimeout(() => { if (voice.convo && !voice.active) { voice.convo = false; startListeningFollow(); } }, 350);
  }
  function startListeningFollow() { startListening(); voice.followUp = true; voiceBar("Listening for a follow-up… say \u201cstop\u201d to end"); }
  function afterAnswer(replies) {
    const wantSpeak = voice.turn || $("#speakToggle").checked || $("#glassesToggle").checked;
    voice.turn = false;
    if (!wantSpeak) return;
    const order = ["best", "claude", "gemini", "muse"];
    const r = replies.filter((x) => x.role === "assistant").sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine))[0];
    if (!window.speechSynthesis) { listenAgain(); return; }
    const ready = replies.find((x) => x.role === "assistant" && openEmail(x));
    if (ready) { readBackEmail(ready); return; }
    if (r) speak(speakable(r.content));
    else if (replies[0]) speak(String(replies[0].content).replace(/^⚠\s*/, ""));
  }

  /* ---------------- email: read back, "send it / change it / cancel", 5-second cancel window ---------------- */
  const SEND_RE = /^(?:yes|yeah|yep|ok(?:ay)?|sure|great|perfect|good)?[,.!\s]*(?:please\s+)?(?:send(?: it| that| the email| the reply)?(?: now)?|go ahead(?: and send(?: it)?)?|ship it)(?:\s*,?\s*please)?[.!]*$/i;
  const CANCEL_RE = /^(?:no|nope|cancel|cancel it|don'?t send(?: it)?|never ?mind|scratch that|forget it|stop|delete it|discard(?: it)?)(?:[,.!\s].*)?$/i;
  const AGAIN_RE = /^(?:read it (?:again|back)|again|repeat(?: that)?|what did it say|say that again)[.!?]*$/i;
  const CHANGE_ONLY_RE = /^(?:change(?: it| that)?|edit(?: it)?|i want to change (?:it|something))[.!]*$/i;
  const CANCEL_WORD = /\b(cancel|stop|wait|don'?t|no)\b/i;

  function openEmail(m) {
    const e = (m.files || []).find((f) => f.email)?.email;
    return e && !e.sentAt && !e.canceledAt ? e : null;
  }
  function sayEmail(addr) { return String(addr || "").replace(/@/g, " at ").replace(/\./g, " dot "); }

  function mailCard(mid, e) {
    const card = document.createElement("div"); card.className = "mailcard"; card.dataset.mid = mid;
    card.innerHTML = `<div class="meta"><span>To <b class="to"></b></span><span>From <b class="from"></b></span><span>Subject <b class="subj"></b></span></div><div class="state"></div><div class="actions"></div>`;
    card.querySelector(".to").textContent = e.to; card.querySelector(".from").textContent = e.from; card.querySelector(".subj").textContent = e.subject || "(no subject)";
    paintCard(card, e.sentAt ? "sent" : e.canceledAt ? "canceled" : "ready");
    return card;
  }
  function paintCard(card, state, extra) {
    if (!card) return;
    const st = card.querySelector(".state"), act = card.querySelector(".actions");
    card.classList.toggle("sent", state === "sent"); card.classList.toggle("off", state === "canceled");
    act.innerHTML = "";
    if (state === "sent") { st.textContent = "✓ Sent"; return; }
    if (state === "canceled") { st.textContent = "Not sent"; return; }
    if (state === "sending") { st.textContent = "Sending…"; return; }
    if (state === "countdown") {
      st.textContent = `Sending in ${extra}…`;
      const c = document.createElement("button"); c.type = "button"; c.className = "act"; c.textContent = "Cancel";
      c.onclick = () => voice.countdown && voice.countdown.cancel(); act.appendChild(c); return;
    }
    st.textContent = "Ready to send. Nothing has been sent.";
    const send = document.createElement("button"); send.type = "button"; send.className = "act send"; send.textContent = "Send";
    send.onclick = () => countdownSend(card.dataset.mid, false);
    const no = document.createElement("button"); no.type = "button"; no.className = "act"; no.textContent = "Don't send";
    no.onclick = () => cancelEmail(card.dataset.mid, false);
    act.append(send, no);
  }
  const cardFor = (mid) => document.querySelector(`.mailcard[data-mid="${CSS.escape(mid)}"]`);
  function emailFor(mid) { const m = S.messages.find((x) => x.id === mid); return m && (m.files || []).find((f) => f.email)?.email; }

  function readBackEmail(m) {
    const e = openEmail(m);
    voice.email = { mid: m.id, tries: 0 };
    speak(`${speakable(m.content)} It goes to ${e.toName || sayEmail(e.to)}, from ${sayEmail(e.from)}. Send it, change it, or cancel?`, () => askConfirm());
  }
  function askConfirm() {
    if (!voice.email) return;
    listenOnce("Say “send it”, “change it”, or “cancel”", (text) => handleConfirm(text));
  }
  function handleConfirm(raw) {
    const st = voice.email; if (!st) return;
    const text = String(raw || "").trim();
    if (!text) {
      if (++st.tries >= 2) { voice.email = null; speak("I'll leave it on screen. Nothing was sent.", () => {}); return; }
      speak("Send it, change it, or cancel?", () => askConfirm()); return;
    }
    if (SEND_RE.test(text)) { voice.email = null; countdownSend(st.mid, true); return; }
    if (CANCEL_RE.test(text)) { voice.email = null; cancelEmail(st.mid, true); return; }
    if (AGAIN_RE.test(text)) { const m = S.messages.find((x) => x.id === st.mid); if (m) readBackEmail(m); return; }
    if (CHANGE_ONLY_RE.test(text)) { speak("What should I change?", () => listenOnce("Say what to change…", (t) => { if (!t) { askConfirm(); return; } voice.email = null; askChange(t); })); return; }
    voice.email = null; askChange(text);
  }
  function askChange(text) {
    q.value = /^(change|make|add|remove|take out|say|instead|shorter|longer)/i.test(text) ? text : `Change the email: ${text}`;
    grow(); voice.turn = true; voice.convo = true; send();
  }

  function listenOnce(label, done) {
    if (!SR) { done(""); return; }
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
    const rec = new SR();
    rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let heard = "", finished = false;
    voice.once = rec; $("#micBtn").classList.add("on"); voiceBar(label);
    rec.onresult = (e) => { heard = [...e.results].map((r) => r[0].transcript).join(" ").trim(); voiceBar(heard || label); markActive(); };
    rec.onerror = (e) => { if (e.error === "not-allowed") toast("Sobriazar needs microphone access."); };
    rec.onend = () => { if (finished) return; finished = true; voice.once = null; $("#micBtn").classList.remove("on"); voiceBar("", false); done(heard); };
    try { rec.start(); } catch { voice.once = null; done(""); }
  }

  function countdownSend(mid, spoken) {
    const e = emailFor(mid);
    if (!e || e.sentAt || e.canceledAt || voice.countdown) return;
    const card = cardFor(mid);
    let left = 5, canceled = false, over = false, rec = null, tick = null;
    const finish = () => {
      if (over) return; over = true;
      clearInterval(tick); voice.countdown = null;
      if (rec) { try { rec.abort(); } catch {} rec = null; }
      $("#micBtn").classList.remove("on"); voiceBar("", false);
      if (canceled) cancelEmail(mid, spoken); else reallySend(mid, spoken);
    };
    voice.countdown = { cancel: () => { canceled = true; finish(); } };
    const listen = () => {
      if (!SR || !spoken || over) return;
      rec = new SR(); rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = true;
      rec.onresult = (ev) => { const t = [...ev.results].map((r) => r[0].transcript).join(" "); if (CANCEL_WORD.test(t)) { canceled = true; finish(); } };
      rec.onend = () => { rec = null; if (!over && left > 0) listen(); }; // phones end listening early; keep it open for the full 5 seconds
      try { rec.start(); $("#micBtn").classList.add("on"); } catch {}
    };
    const startClock = () => {
      if (over) return;
      paintCard(card, "countdown", left); voiceBar(`Sending in ${left}… say “cancel” to stop`);
      listen();
      tick = setInterval(() => {
        left -= 1;
        if (left <= 0) { finish(); return; }
        paintCard(card, "countdown", left); voiceBar(`Sending in ${left}… say “cancel” to stop`);
      }, 1000);
    };
    paintCard(card, "countdown", left);
    if (spoken) speak(`Sending from ${sayEmail(e.from)} in 5 seconds. Say cancel to stop.`, startClock);
    else startClock();
  }

  async function reallySend(mid, spoken) {
    const card = cardFor(mid); paintCard(card, "sending");
    try {
      const res = await api("/email/send", { method: "POST", body: { messageId: mid } });
      const e = emailFor(mid); if (e) e.sentAt = res.email.sentAt || Date.now();
      paintCard(card, "sent");
      const who = res.email.toName || res.email.to;
      if (spoken) speak(`Sent to ${who}.`, () => { voice.convo = false; });
      else toast(`Sent to ${who} from ${res.email.from}.`);
      sync();
    } catch (err) {
      paintCard(card, "ready");
      if (spoken) speak(`It didn't send. ${err.message}`, () => {}); else toast(err.message);
    }
  }
  async function cancelEmail(mid, spoken) {
    const e = emailFor(mid); if (e) e.canceledAt = Date.now();
    paintCard(cardFor(mid), "canceled");
    if (spoken) speak("Canceled. Nothing was sent.", () => { voice.convo = false; });
    else toast("Canceled. Nothing was sent.");
    try { await api("/email/cancel", { method: "POST", body: { messageId: mid } }); } catch {}
  }

  // Glasses mode: keep a silent media session so a tap on the glasses (play/pause) starts listening.
  function silentWav() {
    const rate = 8000, n = rate; const buf = new ArrayBuffer(44 + n); const v = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  }
  async function armGlasses() {
    if (!voice.audio) { voice.audio = new Audio(silentWav()); voice.audio.loop = true; }
    try { await voice.audio.play(); } catch { toast("Tap anywhere once to turn glasses mode back on."); return false; }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Sobriazar", artist: "Tap your glasses to talk", artwork: [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
      const go = () => { voice.audio.play().catch(() => {}); navigator.mediaSession.playbackState = "playing"; startListening(); };
      ["play", "pause", "nexttrack", "previoustrack"].forEach((a) => { try { navigator.mediaSession.setActionHandler(a, go); } catch {} });
      navigator.mediaSession.playbackState = "playing";
    }
    return true;
  }
  function disarmGlasses() {
    if (voice.audio) voice.audio.pause();
    if ("mediaSession" in navigator) ["play", "pause", "nexttrack", "previoustrack"].forEach((a) => { try { navigator.mediaSession.setActionHandler(a, null); } catch {} });
  }
  $("#glassesToggle").checked = local.get("glasses", false);
  $("#glassesToggle").onchange = async (e) => {
    local.set("glasses", e.target.checked);
    if (e.target.checked) { if (await armGlasses()) toast("Glasses mode is on. Tap your glasses (or the mic) and speak."); }
    else { disarmGlasses(); toast("Glasses mode is off."); }
  };
  if (local.get("glasses", false)) window.addEventListener("pointerdown", function rearm() { window.removeEventListener("pointerdown", rearm); if ($("#glassesToggle").checked) armGlasses(); });

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

  /* ---------------- embers (behind the phoenix) ---------------- */
  function Galaxy(canvas) {
    const ctx = canvas.getContext("2d");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const TINTS = { gemini: [111, 190, 255], claude: [255, 140, 90], muse: [190, 150, 255], best: [120, 230, 180], all: [200, 220, 255], auto: [230, 120, 160] };
    const RED = [255, 74, 60], BLUE = [90, 210, 255];
    let w = 0, h = 0, dpr = 1, raf = 0, running = false, last = 0;
    let parts = [], busy = false, energy = 0, tint = TINTS.gemini, tintNow = [...TINTS.gemini];

    function spawn(initial) {
      const compact = document.body.classList.contains("chatting") && canvas.id === "core";
      const cx = w / 2, spreadX = Math.min(w * (compact ? 0.18 : 0.34), compact ? 160 : 420);
      const blue = Math.random() < 0.5;
      return {
        x: cx + (Math.random() - 0.5) * 2 * spreadX * (blue ? (Math.random() < 0.5 ? 1 : 0.6) : 1) + (blue ? spreadX * 0.25 : -spreadX * 0.25) * Math.random(),
        y: initial ? Math.random() * h : h * (0.55 + Math.random() * 0.5),
        vx: (Math.random() - 0.5) * 0.25,
        vy: -(0.25 + Math.random() * 0.7),
        r: 0.6 + Math.random() * 1.8,
        life: 0, max: 220 + Math.random() * 260,
        col: blue ? BLUE : RED, tw: Math.random() * 6.28,
      };
    }
    function count() { const small = w < 500; return (small ? 45 : 95) * (busy ? 1.8 : 1); }
    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const nw = Math.round(rect.width), nh = Math.round(rect.height);
      if (nw === w && nh === h) return;
      w = nw; h = nh; canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      parts = Array.from({ length: Math.round(count()) }, () => spawn(true));
      if (!running) frame(performance.now(), true);
    }
    function frame(now, once) {
      const dt = Math.min(3, (now - (last || now)) / 16.7); last = now;
      energy += ((busy ? 1 : 0) - energy) * 0.05;
      for (let k = 0; k < 3; k++) tintNow[k] += (tint[k] - tintNow[k]) * 0.05;
      ctx.clearRect(0, 0, w, h);
      const compact = document.body.classList.contains("chatting") && canvas.id === "core";
      const cx = w / 2, cy = canvas.id === "core" ? h * (compact ? 0.5 : 0.42) : h * 0.4;
      const R = Math.min(w, h) * (compact ? 0.5 : 0.48);
      const pulse = reduced ? 0 : 0.5 + 0.5 * Math.sin(now / (busy ? 260 : 1600));
      const [tr, tg, tb] = tintNow.map(Math.round);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, `rgba(${tr},${tg},${tb},${0.10 + 0.06 * pulse + energy * 0.14})`);
      g.addColorStop(0.55, `rgba(255,74,60,${0.04 + energy * 0.06})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const speed = reduced ? 0 : (1 + energy * 2.2) * dt;
      while (parts.length < count()) parts.push(spawn(false));
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += speed; p.x += (p.vx + Math.sin((p.life + p.tw * 40) / 40) * 0.15) * speed; p.y += p.vy * speed;
        const fade = Math.min(1, p.life / 30) * Math.max(0, 1 - p.life / p.max);
        if (p.life > p.max || p.y < -10) { if (parts.length > count()) parts.splice(i, 1); else parts[i] = spawn(false); continue; }
        const flick = 0.7 + 0.3 * Math.sin(p.life / 6 + p.tw);
        const a = fade * flick * (0.55 + energy * 0.4);
        const [r, gg, b] = p.col;
        ctx.fillStyle = `rgba(${r},${gg},${b},${a * 0.18})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3.2, 0, 6.283); ctx.fill();
        ctx.fillStyle = `rgba(${Math.min(255, r + 60)},${Math.min(255, gg + 60)},${Math.min(255, b + 60)},${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      if (!once && running) raf = requestAnimationFrame((t) => frame(t));
    }
    return {
      start() { if (running) return; running = true; resize(); last = 0; raf = requestAnimationFrame((t) => frame(t)); },
      stop() { running = false; cancelAnimationFrame(raf); },
      resize() { requestAnimationFrame(resize); setTimeout(resize, 450); },
      setBusy(b, mode) { busy = b; document.body.classList.toggle("busy", b); if (mode && TINTS[mode]) tint = TINTS[mode]; },
      setTint(mode) { tint = TINTS[mode] || TINTS.gemini; },
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
  sync(true).then(() => { if ($("#app").hidden && $("#login").hidden) showLogin(); else if (!$("#app").hidden) renderSecurity(); });
})();
