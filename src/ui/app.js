const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  colonies: [],
  current: null,
  meta: null,
  plan: { tasks: [] },
  tab: "overview",
  reports: [],
  chat: [],
  events: null,
  streamBubble: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setHealth(ok, text) {
  const el = $("#health");
  el.textContent = text;
  el.className = `pill ${ok ? "ok" : "warn"}`;
}

async function boot() {
  try {
    const health = await api("/api/health");
    setHealth(true, `online · ${health.version}`);
  } catch {
    setHealth(false, "offline");
  }
  await loadColonies();
  bind();
}

async function loadColonies() {
  const data = await api("/api/colonies");
  state.colonies = data.colonies || [];
  const list = $("#colony-list");
  list.innerHTML = "";
  for (const colony of state.colonies) {
    const id = colony.id || colony.name;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<strong>${esc(id)}</strong><small>${esc(colony.goal || colony.queen_id || "")}</small>`;
    btn.title = colony.goal || id;
    btn.setAttribute("aria-current", state.current === id ? "true" : "false");
    btn.addEventListener("click", () => selectColony(id));
    li.append(btn);
    list.append(li);
  }
  $("#colony-empty").classList.toggle("hidden", state.colonies.length > 0);
  if (state.colonies.length && !state.current) {
    const saved = localStorage.getItem("pi-hive.colony");
    const target = state.colonies.find((c) => (c.id || c.name) === saved)?.id || state.colonies[0].id || state.colonies[0].name;
    await selectColony(target);
  }
  if (!state.colonies.length) {
    $("#welcome").classList.remove("hidden");
    $("#colony-view").classList.add("hidden");
  }
}

async function selectColony(name) {
  state.events?.close();
  state.events = null;
  state.current = name;
  state.reports = [];
  state.chat = [];
  localStorage.setItem("pi-hive.colony", name);
  history.replaceState(null, "", `#${encodeURIComponent(name)}`);
  const data = await api(`/api/colonies/${encodeURIComponent(name)}`);
  state.meta = data.colony;
  state.plan = data.plan || { tasks: [] };
  $("#welcome").classList.add("hidden");
  $("#colony-view").classList.remove("hidden");
  $("#colony-name").textContent = state.meta.id || state.meta.name;
  const queenName = state.meta.queen_name || state.meta.queen_id || "queen";
  const queenId = state.meta.queen_id || "";
  $("#colony-queen").textContent = queenName === queenId ? queenName : `${queenName} · ${queenId}`;
  $("#colony-goal").textContent = state.meta.goal || "No goal set.";
  $("#sentinel-pill").textContent = state.meta.sentinel_enabled ? "Sentinel: on" : "Sentinel: off";
  $("#sentinel-pill").className = `pill ${state.meta.sentinel_enabled ? "ok" : ""}`;
  await loadMessages();
  selectTab("overview");
  await refreshAll();
  connectEvents();
  loadColonies().catch(() => {});
}

function connectEvents() {
  if (!state.current || typeof EventSource === "undefined") return;
  const es = new EventSource(`/api/colonies/${encodeURIComponent(state.current)}/events`);
  es.addEventListener("worker_report", (event) => {
    try {
      const data = JSON.parse(event.data);
      state.reports.unshift({ id: data.id, status: data.report?.status, summary: data.report?.summary, at: data.report?.at });
      renderReports();
      refreshStats().catch(() => {});
    } catch { /* ignore malformed events */ }
  });
  es.addEventListener("queen_event", () => {});
  es.onerror = () => { /* EventSource reconnects automatically */ };
  state.events = es;
}

async function loadMessages() {
  try {
    const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/messages`);
    state.chat = (data.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  } catch {
    state.chat = [];
  }
  renderChat();
}

function messageNode(role, text) {
  const node = $("#chat-message").content.firstElementChild.cloneNode(true);
  node.classList.toggle("user", role === "user");
  $("header", node).textContent = role === "user" ? "You" : "Queen";
  $(".bubble", node).textContent = text;
  return node;
}

function renderChat() {
  const log = $("#chat-log");
  log.innerHTML = "";
  for (const message of state.chat) log.append(messageNode(message.role, message.text));
  log.scrollTop = log.scrollHeight;
}

function appendChat(role, text) {
  const node = messageNode(role, text);
  $("#chat-log").append(node);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return node;
}

async function sendChat(text) {
  if (!text.trim() || !state.current) return;
  const input = $("#chat-text");
  const button = $("#chat-send");
  const status = $("#chat-status");
  input.value = "";
  button.disabled = true;
  status.textContent = "thinking…";
  appendChat("user", text);
  state.streamBubble = null;

  try {
    const res = await fetch(`/api/colonies/${encodeURIComponent(state.current)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const payload = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !payload) continue;
        const data = JSON.parse(payload);
        if (event === "delta") {
          finalText += data.delta || "";
          if (!state.streamBubble) state.streamBubble = appendChat("assistant", "");
          state.streamBubble.querySelector(".bubble").textContent = finalText;
          $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
        } else if (event === "done") {
          finalText = data.text || finalText;
        } else if (event === "error") {
          throw new Error(data.error || "chat failed");
        }
      }
    }
    if (!state.streamBubble && finalText) appendChat("assistant", finalText);
    if (state.streamBubble) state.streamBubble.querySelector(".bubble").textContent = finalText;
    status.textContent = "";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    state.streamBubble = null;
    button.disabled = false;
    input.focus();
    refreshStats().catch(() => {});
  }
}

async function refreshAll() {
  if (!state.current) return;
  await Promise.allSettled([refreshStats(), refreshWorkers(), refreshTracker(), refreshPlaybooks(), refreshTriggers(), refreshInbox()]);
}

async function refreshStats() {
  if (!state.current) return;
  const name = encodeURIComponent(state.current);
  const [workers, tables, runs, inbox] = await Promise.all([
    api(`/api/colonies/${name}/workers`).catch(() => ({ workers: [] })),
    api(`/api/colonies/${name}/tracker?sql=${encodeURIComponent("SELECT name FROM sqlite_master WHERE type='table'")}`).catch(() => ({ rows: [] })),
    api(`/api/colonies/${name}/playbooks/runs`).catch(() => ({ runs: [] })),
    api(`/api/colonies/${name}/inbox`).catch(() => ({ inbox: [] })),
  ]);
  $("#stat-workers").textContent = workers.workers.length;
  $("#stat-tables").textContent = tables.rows.length;
  $("#stat-runs").textContent = runs.runs.length;
  $("#stat-inbox").textContent = inbox.inbox.length;
  $("#plan-list").innerHTML = "";
  const plan = state.plan || {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : Object.values(plan.tasks || {});
  for (const task of tasks.slice(-8)) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(task.subject || task.id)}</strong><small>${esc(task.status || "")}</small>`;
    $("#plan-list").append(li);
  }
  $("#plan-empty").classList.toggle("hidden", tasks.length > 0);
}

function renderReports() {
  const list = $("#report-list");
  list.innerHTML = "";
  for (const report of state.reports.slice(0, 8)) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(report.id || "worker")}</strong><small>${esc(report.summary || report.status || "")}</small>`;
    list.append(li);
  }
  $("#report-empty").classList.toggle("hidden", state.reports.length > 0);
}

async function refreshWorkers() {
  if (!state.current) return;
  const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/workers`).catch(() => ({ workers: [] }));
  const tbody = $("#worker-table tbody");
  tbody.innerHTML = "";
  for (const worker of data.workers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(worker.id)}</td><td>${esc(worker.task)}</td><td>${esc(worker.status)}</td>`;
    tbody.append(tr);
  }
  if (!data.workers.length) tbody.innerHTML = `<tr><td colspan="3" class="muted">No active workers.</td></tr>`;
}

async function refreshTracker() {
  if (!state.current) return;
  const sql = $("#tracker-sql").value || "SELECT name FROM sqlite_master WHERE type='table'";
  const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/tracker?sql=${encodeURIComponent(sql)}`).catch((err) => ({ rows: [], error: err.message }));
  const table = $("#tracker-table");
  const thead = $("thead", table);
  const tbody = $("tbody", table);
  thead.innerHTML = "";
  tbody.innerHTML = "";
  if (data.error) {
    tbody.innerHTML = `<tr><td class="error">${esc(data.error)}</td></tr>`;
    return;
  }
  const rows = data.rows || [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  thead.innerHTML = `<tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = columns.map((c) => `<td>${esc(row[c])}</td>`).join("");
    tbody.append(tr);
  }
  if (!rows.length) tbody.innerHTML = `<tr><td class="muted">No rows.</td></tr>`;
}

async function refreshPlaybooks() {
  if (!state.current) return;
  const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/playbooks/runs`).catch(() => ({ runs: [] }));
  const box = $("#playbook-runs");
  box.innerHTML = "";
  for (const run of data.runs || []) {
    const el = document.createElement("article");
    el.className = "run";
    el.innerHTML = `<div class="run-head"><strong>${esc(run.name)}</strong><span class="pill">${esc(run.status)}</span></div>
      <p class="muted small">${esc(run.run_id)} · dispatched ${esc(run.dispatched)} · dead-lettered ${esc(run.dead_lettered)}</p>
      <pre>${esc((run.logs || []).join("\n"))}</pre>`;
    if (run.status === "running" || run.status === "stopping") {
      const btn = document.createElement("button");
      btn.className = "danger";
      btn.textContent = "Stop";
      btn.addEventListener("click", async () => {
        await api(`/api/colonies/${encodeURIComponent(state.current)}/playbooks/stop`, { method: "POST", body: JSON.stringify({ run_id: run.run_id }) });
        refreshPlaybooks();
      });
      $(".run-head", el).append(btn);
    }
    box.append(el);
  }
  if (!(data.runs || []).length) box.innerHTML = `<p class="muted small">No playbook runs yet.</p>`;
}

async function refreshTriggers() {
  if (!state.current) return;
  const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/triggers`).catch(() => ({ triggers: [] }));
  const list = $("#trigger-list");
  list.innerHTML = "";
  for (const trigger of data.triggers || []) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(trigger.name)}</strong><small>${esc(trigger.type)} · ${esc(trigger.interval_minutes ? `${trigger.interval_minutes}m` : trigger.cron)} · ${trigger.enabled ? "enabled" : "disabled"}</small>`;
    list.append(li);
  }
  if (!(data.triggers || []).length) list.innerHTML = `<li class="muted">No triggers.</li>`;
}

async function refreshInbox() {
  if (!state.current) return;
  const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/inbox`).catch(() => ({ inbox: [] }));
  const box = $("#inbox-list");
  box.innerHTML = "";
  for (const item of data.inbox || []) {
    const el = document.createElement("article");
    el.className = "run";
    el.innerHTML = `<div class="run-head"><strong>${esc(item.kind)}</strong><span class="pill">${esc(item.at)}</span></div>
      <p>${esc(item.reason)}</p>`;
    box.append(el);
  }
  if (!(data.inbox || []).length) box.innerHTML = `<p class="muted small">Inbox is empty.</p>`;
}

async function refreshSoul() {
  if (!state.current) return;
  const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/soul`).catch(() => null);
  const box = $("#soul-identity");
  const proposals = $("#soul-proposals");
  box.innerHTML = "";
  proposals.innerHTML = "";
  if (!data) return;
  const identity = data.soul?.identity || {};
  const fields = [
    ["Mission", identity.mission || "(not set)"],
    ["Voice", (identity.voice || []).join("\n") || "(not set)"],
    ["Principles", (identity.principles || []).join("\n") || "(not set)"],
  ];
  for (const [label, value] of fields) {
    const el = document.createElement("div");
    el.innerHTML = `<span class="muted small">${esc(label)}</span><p>${esc(value)}</p>`;
    box.append(el);
  }
  $("#soul-mode").value = data.soul?.mode || "review";
  $("#soul-status").textContent = `${data.pending || 0} pending · ${data.last_review_at ? "reviewed" : "not reviewed"}`;
  for (const proposal of data.proposals || []) {
    const el = document.createElement("article");
    el.className = "run";
    el.innerHTML = `<div class="run-head"><strong>${esc(proposal.section)}</strong><span class="pill">${esc(proposal.status)}</span></div>
      <p>${esc(proposal.change)}</p>
      <pre>${esc((proposal.evidence || []).join("\n"))}</pre>`;
    if (proposal.status === "pending") {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = "Apply";
      btn.addEventListener("click", async () => {
        await api(`/api/colonies/${encodeURIComponent(state.current)}/soul/apply`, { method: "POST", body: JSON.stringify({ id: proposal.id }) });
        refreshSoul().catch(() => {});
      });
      $(".run-head", el).append(btn);
    }
    proposals.append(el);
  }
  if (!(data.proposals || []).length) proposals.innerHTML = `<p class="muted small">No proposals yet. Run a review.</p>`;
}

function selectTab(tab) {
  state.tab = tab;
  for (const btn of $$(".tabs button")) btn.setAttribute("aria-selected", btn.dataset.tab === tab ? "true" : "false");
  for (const panel of $$("[data-panel]")) panel.classList.toggle("hidden", panel.dataset.panel !== tab);
  if (tab === "overview") refreshStats().catch(() => {});
  if (tab === "workers") refreshWorkers().catch(() => {});
  if (tab === "tracker") refreshTracker().catch(() => {});
  if (tab === "playbooks") refreshPlaybooks().catch(() => {});
  if (tab === "triggers") refreshTriggers().catch(() => {});
  if (tab === "inbox") refreshInbox().catch(() => {});
  if (tab === "soul") refreshSoul().catch(() => {});
}

function bind() {
  $("#refresh-colonies").addEventListener("click", () => loadColonies().catch(() => {}));
  $("#refresh-view").addEventListener("click", () => refreshAll().catch(() => {}));
  $("#new-colony").addEventListener("click", openDialog);
  $("#welcome-new").addEventListener("click", openDialog);
  $("#colony-cancel").addEventListener("click", () => $("#colony-dialog").close());

  for (const btn of $$(".tabs button")) btn.addEventListener("click", () => selectTab(btn.dataset.tab));

  $("#chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    sendChat($("#chat-text").value).catch(() => {});
  });
  $("#chat-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChat($("#chat-text").value).catch(() => {});
    }
  });

  $("#worker-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const task = $("#worker-task").value.trim();
    if (!task) return;
    $("#worker-task").value = "";
    try {
      const data = await api(`/api/colonies/${encodeURIComponent(state.current)}/workers`, { method: "POST", body: JSON.stringify({ task }) });
      state.reports.unshift({ id: "direct", status: data.report?.status, summary: data.report?.summary });
      renderReports();
    } catch (err) {
      state.reports.unshift({ id: "direct", status: "failed", summary: err.message });
      renderReports();
    }
    refreshWorkers().catch(() => {});
    refreshStats().catch(() => {});
  });

  $("#tracker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refreshTracker().catch(() => {});
  });

  $("#playbook-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#playbook-name").value.trim();
    if (!name) return;
    $("#playbook-name").value = "";
    try {
      await api(`/api/colonies/${encodeURIComponent(state.current)}/playbooks/run`, { method: "POST", body: JSON.stringify({ name }) });
    } catch (err) {
      alert(err.message);
    }
    refreshPlaybooks().catch(() => {});
  });

  $("#trigger-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#trigger-name").value.trim();
    const kind = $("#trigger-kind").value;
    const spec = $("#trigger-every").value.trim();
    const prompt = $("#trigger-prompt").value.trim();
    if (!name || !spec) return;
    const payload = { name, type: kind, prompt };
    if (kind === "interval") {
      const match = /^(\d+)\s*(m|min|minute|minutes)?$/i.exec(spec);
      if (!match) { alert("Interval must be minutes, e.g. 5 or 5m."); return; }
      payload.interval_minutes = Number(match[1]);
    } else {
      payload.cron = spec;
    }
    try {
      await api(`/api/colonies/${encodeURIComponent(state.current)}/triggers`, { method: "POST", body: JSON.stringify(payload) });
      $("#trigger-name").value = "";
      $("#trigger-every").value = "";
      $("#trigger-prompt").value = "";
    } catch (err) {
      alert(err.message);
    }
    refreshTriggers().catch(() => {});
  });

  $("#inbox-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#inbox-text").value.trim();
    if (!text) return;
    $("#inbox-text").value = "";
    try {
      await api(`/api/colonies/${encodeURIComponent(state.current)}/sentinel/reply`, { method: "POST", body: JSON.stringify({ text }) });
      await loadMessages();
      refreshInbox().catch(() => {});
    } catch (err) {
      alert(err.message);
    }
  });

  $("#soul-review").addEventListener("click", async () => {
    const status = $("#soul-status");
    const button = $("#soul-review");
    button.disabled = true;
    status.textContent = "reviewing…";
    try {
      const result = await api(`/api/colonies/${encodeURIComponent(state.current)}/soul/review`, { method: "POST", body: "{}" });
      status.textContent = `${(result.proposals || []).length} proposals written`;
      await refreshSoul();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $("#soul-mode").addEventListener("change", async (event) => {
    try {
      await api(`/api/colonies/${encodeURIComponent(state.current)}/soul/mode`, { method: "POST", body: JSON.stringify({ mode: event.target.value }) });
    } catch (err) {
      alert(err.message);
    }
  });

  $("#colony-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("#colony-error");
    error.classList.add("hidden");
    const payload = {
      name: $("#new-name").value.trim(),
      queen_id: $("#new-queen").value,
      goal: $("#new-goal").value.trim(),
      workspace: $("#new-workspace").value.trim(),
      sentinel_enabled: $("#new-sentinel").checked,
    };
    try {
      await api("/api/colonies", { method: "POST", body: JSON.stringify(payload) });
      $("#colony-dialog").close();
      $("#colony-form").reset();
      await loadColonies();
      await selectColony(payload.name);
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove("hidden");
    }
  });
}

function openDialog() {
  $("#colony-dialog").showModal();
  $("#new-name").focus();
}

boot().catch((err) => setHealth(false, err.message));
