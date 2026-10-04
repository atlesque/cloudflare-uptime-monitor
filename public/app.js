// Uptime Monitor dashboard. Plain ES module, no build step.

const REFRESH_MS = 30_000;
// Set from /api/me once loaded; until then (or if unset) the browser's own time zone is used.
let timeZone;

const state = {
  monitors: [],
  /** Explicitly selected monitor ids. Only ever contains currently visible monitors. */
  selected: new Set(),
  filters: { search: "", group: "", status: "" },
  editing: null,
};

const $ = (id) => document.getElementById(id);

// ---------- formatting ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let timestampFormat;
let fullTimestampFormat;
function buildFormats() {
  timestampFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  fullTimestampFormat = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "long" });
}
buildFormats();
const formatTime = (ms) => (ms == null ? "—" : timestampFormat.format(new Date(ms)));
const formatFullTime = (ms) => (ms == null ? "—" : fullTimestampFormat.format(new Date(ms)));

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const formatDowntime = (ms) => (ms === 0 ? "0m" : formatDuration(ms));

function ago(ms) {
  if (ms == null) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  return `${formatDuration(s * 1000)} ago`;
}

function formatUptime(pct) {
  if (pct == null) return "—";
  if (pct >= 100) return "100%";
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

/** Operational value with the inclusive value in parentheses when they differ. */
const pair = (a, b) => (a === b ? esc(a) : `${esc(a)} <span class="muted">(${esc(b)})</span>`);

function uptimeClass(pct) {
  if (pct == null) return "muted";
  if (pct >= 99.9) return "uptime-good";
  if (pct >= 99) return "uptime-warn";
  return "uptime-bad";
}

const STATE_LABELS = { up: "Up", down: "Down", pending: "Pending" };
const MAINTENANCE_LABELS = { notify: "Maintenance", silent: "Silent maintenance" };
const MAINTENANCE_TITLES = {
  notify: "Maintenance with notifications: checks and alerts continue",
  silent: "Maintenance without notifications: checks continue, alerts are suppressed",
};

function stateBadges(m) {
  let html = `<span class="badge ${m.state}">${STATE_LABELS[m.state]}</span>`;
  if (m.maintenanceMode !== "none") {
    html += ` <span class="badge ${m.maintenanceMode}" title="${esc(MAINTENANCE_TITLES[m.maintenanceMode])} since ${esc(
      formatFullTime(m.maintenanceStartedAt),
    )}">${MAINTENANCE_LABELS[m.maintenanceMode]}</span>`;
  }
  return `<span class="badges">${html}</span>`;
}

function lastCheckCell(m) {
  const c = m.lastCheck;
  if (!c) return `<span class="muted">Not checked yet</span>`;
  const result = c.error ? `<span class="error-text">${esc(c.error)}</span>` : `HTTP ${esc(c.status)}`;
  return `<span title="${esc(formatFullTime(c.at))}">${esc(ago(c.at))}</span><br /><small>${result}</small>`;
}

// ---------- API ----------

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    Object.assign(err, { status: res.status, data });
    throw err;
  }
  return data;
}

async function refresh() {
  try {
    const data = await request("/api/monitors");
    state.monitors = data.monitors;
    $("updated").textContent = `Updated ${formatTime(Date.now())}`;
    render();
  } catch (err) {
    $("updated").textContent = `Refresh failed: ${err.message}`;
  }
}

// ---------- filtering and selection ----------

function visibleMonitors() {
  const { search, group, status } = state.filters;
  const q = search.trim().toLowerCase();
  return state.monitors.filter((m) => {
    if (q && !m.name.toLowerCase().includes(q) && !m.url.toLowerCase().includes(q)) return false;
    if (group === "__none__" ? m.group !== null : group && m.group !== group) return false;
    if (status === "maintenance") return m.maintenanceMode !== "none";
    if (status && m.state !== status) return false;
    return true;
  });
}

/** Drops selections that are not visible, so bulk actions never include hidden monitors. */
function pruneSelection(visible) {
  const ids = new Set(visible.map((m) => m.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
}

function selectedMonitors() {
  return state.monitors.filter((m) => state.selected.has(m.id));
}

// ---------- rendering ----------

function render() {
  const visible = visibleMonitors();
  pruneSelection(visible);
  renderSummary();
  renderGroupOptions();

  $("rows").innerHTML = visible.map(rowHtml).join("");
  const empty = $("empty");
  empty.hidden = visible.length > 0;
  empty.textContent = state.monitors.length === 0 ? "No monitors yet. Add one to start checking." : "No monitors match the filters.";

  const selectAll = $("select-all");
  const count = state.selected.size;
  selectAll.checked = visible.length > 0 && count === visible.length;
  selectAll.indeterminate = count > 0 && count < visible.length;
  selectAll.disabled = visible.length === 0;

  $("bulkbar").hidden = count === 0;
  $("selected-count").textContent = `${count} selected`;
}

function rowHtml(m) {
  const metrics = m.metrics30d;
  const selected = state.selected.has(m.id);
  return `<tr data-id="${m.id}" id="monitor-${m.id}" class="${selected ? "selected" : ""}">
  <td class="select"><input type="checkbox" data-select="${m.id}" ${selected ? "checked" : ""} aria-label="Select ${esc(m.name)}" /></td>
  <td><button type="button" class="monitor-name" data-action="detail">${esc(m.name)}</button>
      <a class="monitor-url" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a></td>
  <td>${m.group ? esc(m.group) : '<span class="muted">—</span>'}</td>
  <td>${stateBadges(m)}</td>
  <td class="num"><span class="${uptimeClass(metrics.uptimePct)}">${pair(
    formatUptime(metrics.uptimePct),
    formatUptime(metrics.uptimeInclusivePct),
  )}</span></td>
  <td class="num">${pair(formatDowntime(metrics.downtimeMs), formatDowntime(metrics.downtimeInclusiveMs))}</td>
  <td class="nowrap">${lastCheckCell(m)}</td>
  <td class="num">${m.lastCheck?.durationMs != null ? `${m.lastCheck.durationMs} ms` : '<span class="muted">—</span>'}</td>
  <td class="nowrap">${
    m.currentOutageStartedAt
      ? `<span class="error-text" title="${esc(formatFullTime(m.currentOutageStartedAt))}">${esc(
          formatTime(m.currentOutageStartedAt),
        )}</span><br /><small class="muted">${esc(formatDuration(Date.now() - m.currentOutageStartedAt))}</small>`
      : '<span class="muted">—</span>'
  }</td>
  <td class="actions"><span class="row-actions">
    <button type="button" data-action="check">Check now</button>
    <select data-action="maintenance" aria-label="Maintenance for ${esc(m.name)}">
      <option value="" selected disabled>Maintenance…</option>
      ${m.maintenanceMode !== "notify" ? '<option value="notify">Start (notifications on)</option>' : ""}
      ${m.maintenanceMode !== "silent" ? '<option value="silent">Start (silent)</option>' : ""}
      ${m.maintenanceMode !== "none" ? '<option value="none">End maintenance</option>' : ""}
    </select>
    <button type="button" data-action="edit">Edit</button>
    <button type="button" class="danger" data-action="delete">Delete</button>
  </span></td>
</tr>`;
}

function renderSummary() {
  const count = (pred) => state.monitors.filter(pred).length;
  const parts = [
    ["down", count((m) => m.state === "down"), "Down"],
    ["up", count((m) => m.state === "up"), "Up"],
    ["pending", count((m) => m.state === "pending"), "Pending"],
    ["notify", count((m) => m.maintenanceMode !== "none"), "In maintenance"],
  ];
  $("summary").innerHTML = parts
    .filter(([, n], i) => n > 0 || i < 2)
    .map(([cls, n, label]) => `<span class="badge ${cls}">${n} ${label}</span>`)
    .join("");
  document.title = `${parts[0][1] > 0 ? `(${parts[0][1]} down) ` : ""}Uptime Monitor`;
}

function renderGroupOptions() {
  const groups = [...new Set(state.monitors.map((m) => m.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const select = $("filter-group");
  const current = state.filters.group;
  select.innerHTML =
    `<option value="">All groups</option>` +
    groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("") +
    `<option value="__none__">No group</option>`;
  select.value = groups.includes(current) || current === "__none__" ? current : "";
  if (select.value !== current) state.filters.group = select.value;
  $("group-options").innerHTML = groups.map((g) => `<option value="${esc(g)}"></option>`).join("");
}

// ---------- dialogs ----------

function openDialog(id) {
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

document.addEventListener("click", (e) => {
  const close = e.target.closest("[data-close]");
  if (close) close.closest("dialog").close();
});

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

/**
 * Shows a confirmation listing the affected monitors. `run` performs the action;
 * errors are shown in the dialog.
 */
function confirmAction({ title, intro, monitors, note, okLabel, danger, run }) {
  $("confirm-title").textContent = title;
  $("confirm-body").innerHTML = `<p>${intro}</p>
    <ul class="confirm-list">${monitors.map((m) => `<li>${esc(m.name)} <span class="muted">${esc(m.url)}</span></li>`).join("")}</ul>
    ${note ? `<p><strong>${note}</strong></p>` : ""}`;
  $("confirm-error").textContent = "";
  const ok = $("confirm-ok");
  ok.textContent = okLabel;
  ok.className = danger ? "primary danger" : "primary";
  ok.disabled = false;
  ok.onclick = async () => {
    ok.disabled = true;
    try {
      await run();
      $("confirm-dialog").close();
    } catch (err) {
      $("confirm-error").textContent = err.message;
      ok.disabled = false;
    }
  };
  openDialog("confirm-dialog");
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- add / edit ----------

function openMonitorForm(monitor) {
  state.editing = monitor ?? null;
  const form = $("monitor-form");
  form.reset();
  $("monitor-dialog-title").textContent = monitor ? `Edit ${monitor.name}` : "Add monitor";
  $("monitor-submit").textContent = monitor ? "Save" : "Add monitor";
  form.name.value = monitor?.name ?? "";
  form.url.value = monitor?.url ?? "";
  form.group.value = monitor?.group ?? "";
  form.timeout.value = String((monitor?.timeoutMs ?? 10_000) / 1000);
  $("url-change-hint").hidden = true;
  $("url-change-confirm").hidden = true;
  $("monitor-error").textContent = "";
  openDialog("monitor-dialog");
  form.name.focus();
}

$("monitor-form").url.addEventListener("input", (e) => {
  const changed = state.editing && e.target.value.trim() !== state.editing.url;
  $("url-change-hint").hidden = !changed;
  $("url-change-confirm").hidden = !changed;
});

$("monitor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value,
    url: form.url.value,
    group: form.group.value.trim() || null,
    timeoutMs: Math.round(Number(form.timeout.value) * 1000),
  };
  const submit = $("monitor-submit");
  submit.disabled = true;
  try {
    if (state.editing) {
      if (!$("url-change-confirm").hidden) {
        if (!form.confirmUrlChange.checked) throw new Error("Confirm the URL change to continue.");
        body.confirmUrlChange = true;
      }
      await request(`/api/monitors/${state.editing.id}`, { method: "PATCH", body });
      toast(`Saved ${body.name.trim()}`);
    } else {
      await request("/api/monitors", { method: "POST", body });
      toast(`Added ${body.name.trim()}. It stays Pending until the first scheduled check.`);
    }
    $("monitor-dialog").close();
    await refresh();
  } catch (err) {
    $("monitor-error").textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

$("add-button").addEventListener("click", () => openMonitorForm(null));

// ---------- row actions ----------

const findMonitor = (id) => state.monitors.find((m) => m.id === id);

$("rows").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const m = findMonitor(Number(button.closest("tr").dataset.id));
  if (!m) return;
  switch (button.dataset.action) {
    case "detail":
      return showDetail(m.id);
    case "edit":
      return openMonitorForm(m);
    case "check":
      return checkNow(m, button);
    case "delete":
      return confirmAction({
        title: `Delete ${m.name}?`,
        intro: "This permanently deletes the monitor and its incident history:",
        monitors: [m],
        note: "This cannot be undone.",
        okLabel: "Delete permanently",
        danger: true,
        run: async () => {
          await request(`/api/monitors/${m.id}?confirm=true`, { method: "DELETE" });
          toast(`Deleted ${m.name}`);
          await refresh();
        },
      });
  }
});

$("rows").addEventListener("change", async (e) => {
  const checkbox = e.target.closest("input[data-select]");
  if (checkbox) {
    const id = Number(checkbox.dataset.select);
    checkbox.checked ? state.selected.add(id) : state.selected.delete(id);
    return render();
  }
  const select = e.target.closest("select[data-action=maintenance]");
  if (select) {
    const m = findMonitor(Number(select.closest("tr").dataset.id));
    const mode = select.value;
    select.value = "";
    try {
      await request(`/api/monitors/${m.id}/maintenance`, { method: "PUT", body: { mode } });
      toast(mode === "none" ? `Ended maintenance for ${m.name}` : `${m.name} is now in ${MAINTENANCE_LABELS[mode].toLowerCase()}`);
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }
});

async function checkNow(m, button) {
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const r = await request(`/api/monitors/${m.id}/check`, { method: "POST" });
    $("check-body").innerHTML = `<h2>Check now: ${esc(m.name)}</h2>
      <p class="muted">Diagnostic only. This result does not change the monitor's state, incidents, uptime or notifications.</p>
      <dl class="detail-meta">
        <dt>URL</dt><dd>${esc(m.url)}</dd>
        <dt>Result</dt><dd>${r.ok ? '<span class="badge up">Healthy</span>' : '<span class="badge down">Failing</span>'}</dd>
        <dt>Status</dt><dd>${r.status == null ? "—" : `HTTP ${esc(r.status)}`}</dd>
        <dt>Error</dt><dd>${r.error ? `<span class="error-text">${esc(r.error)}</span>` : "—"}</dd>
        <dt>Response time</dt><dd>${esc(r.durationMs)} ms</dd>
        <dt>Checked at</dt><dd>${esc(formatFullTime(r.checkedAt))}</dd>
      </dl>`;
    openDialog("check-dialog");
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Check now";
  }
}

async function showDetail(id) {
  let m;
  try {
    m = await request(`/api/monitors/${id}`);
  } catch (err) {
    return toast(err.message);
  }
  const metrics = m.metrics30d;
  const incidents = m.incidents.length
    ? `<table class="incidents"><thead><tr><th>Started</th><th>Ended</th><th>Duration</th><th>Failure reason</th><th>Maintenance</th></tr></thead><tbody>
        ${m.incidents
          .map((i) => {
            const maint = [
              i.silentMaintenanceMs > 0 ? `Silent ${formatDuration(i.silentMaintenanceMs)}` : "",
              i.notifyMaintenanceMs > 0 ? `With notifications ${formatDuration(i.notifyMaintenanceMs)}` : "",
            ].filter(Boolean);
            return `<tr>
              <td class="nowrap">${esc(formatFullTime(i.startedAt))}</td>
              <td class="nowrap">${i.ongoing ? '<span class="badge down">Ongoing</span>' : esc(formatFullTime(i.endedAt))}</td>
              <td class="nowrap">${esc(formatDuration(i.durationMs))}</td>
              <td>${esc(i.failureReason ?? "—")}</td>
              <td>${maint.length ? esc(maint.join(", ")) : '<span class="muted">None</span>'}</td>
            </tr>`;
          })
          .join("")}
      </tbody></table>`
    : `<p class="muted">No incidents in the last 30 days.</p>`;
  $("detail-body").innerHTML = `<h2>${esc(m.name)} ${stateBadges(m)}</h2>
    <dl class="detail-meta">
      <dt>URL</dt><dd><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a></dd>
      <dt>Group</dt><dd>${esc(m.group ?? "—")}</dd>
      <dt>Timeout</dt><dd>${esc(m.timeoutMs / 1000)} s</dd>
      <dt>Observed since</dt><dd>${esc(formatFullTime(m.observedSince))}</dd>
      <dt>Uptime (30 days)</dt><dd><span class="${uptimeClass(metrics.uptimePct)}">${pair(
        formatUptime(metrics.uptimePct),
        formatUptime(metrics.uptimeInclusivePct),
      )}</span></dd>
      <dt>Downtime (30 days)</dt><dd>${pair(formatDowntime(metrics.downtimeMs), formatDowntime(metrics.downtimeInclusiveMs))}</dd>
      <dt>Outages (30 days)</dt><dd>${pair(String(metrics.outages), String(metrics.outagesInclusive))}</dd>
      <dt>Last check</dt><dd>${lastCheckCell(m)}</dd>
    </dl>
    <h2>Incidents (last 30 days)</h2>
    ${incidents}`;
  openDialog("detail-dialog");
}

// ---------- bulk actions ----------

$("select-all").addEventListener("change", (e) => {
  const visible = visibleMonitors();
  state.selected = e.target.checked ? new Set(visible.map((m) => m.id)) : new Set();
  render();
});

$("clear-selection").addEventListener("click", () => {
  state.selected.clear();
  render();
});

$("bulkbar").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-bulk]");
  if (!button) return;
  const monitors = selectedMonitors();
  const ids = monitors.map((m) => m.id);
  const n = monitors.length;
  if (n === 0) return;

  const submit = async (body, done) => {
    const result = await request("/api/monitors/bulk", { method: "POST", body: { ...body, ids, confirm: true } });
    state.selected.clear();
    toast(done(result));
    await refresh();
  };

  switch (button.dataset.bulk) {
    case "maintenance-notify":
    case "maintenance-silent": {
      const mode = button.dataset.bulk === "maintenance-notify" ? "notify" : "silent";
      return confirmAction({
        title: `Start ${mode === "silent" ? "maintenance without notifications" : "maintenance with notifications"} for ${plural(n, "monitor")}?`,
        intro: `Mode: <strong>${mode === "silent" ? "Maintenance without notifications" : "Maintenance with notifications"}</strong>. Checks continue${
          mode === "silent" ? "; outage and recovery alerts are suppressed" : " and alerts are still sent"
        }. Applies to these ${plural(n, "monitor")}:`,
        monitors,
        note: "Maintenance starts now and has no end time. It stays active until you end it manually.",
        okLabel: `Start maintenance for ${plural(n, "monitor")}`,
        run: () => submit({ action: "maintenance", mode }, (r) => `Maintenance started for ${plural(r.changed, "monitor")}`),
      });
    }
    case "end-maintenance":
      return confirmAction({
        title: `End maintenance for ${plural(n, "monitor")}?`,
        intro: "Maintenance ends now for:",
        monitors,
        note: "Monitors that are still down after silent maintenance send one “still down” notification.",
        okLabel: `End maintenance for ${plural(n, "monitor")}`,
        run: () => submit({ action: "end-maintenance" }, (r) => `Maintenance ended for ${plural(r.changed, "monitor")}`),
      });
    case "delete":
      return confirmAction({
        title: `Permanently delete ${plural(n, "monitor")}?`,
        intro: `This deletes these ${plural(n, "monitor")} and all their incident history:`,
        monitors,
        note: "This cannot be undone.",
        okLabel: `Delete ${plural(n, "monitor")}`,
        danger: true,
        run: () => submit({ action: "delete" }, (r) => `Deleted ${plural(r.changed, "monitor")}`),
      });
  }
});

// ---------- filters ----------

function onFilterChange() {
  state.filters = {
    search: $("filter-search").value,
    group: $("filter-group").value,
    status: $("filter-status").value,
  };
  // Hidden selections are cleared so a bulk action never includes monitors you cannot see.
  render();
}
$("filter-search").addEventListener("input", onFilterChange);
$("filter-group").addEventListener("change", onFilterChange);
$("filter-status").addEventListener("change", onFilterChange);

// ---------- startup ----------

async function loadChannels() {
  try {
    const me = await request("/api/me");
    timeZone = me.timeZone;
    buildFormats();
    const on = (v) => (v ? "configured" : "not configured");
    $("channels").textContent = `Notifications: email ${on(me.notifications.email)}, ntfy ${on(me.notifications.ntfy)}. Times shown in ${me.timeZone}.`;
  } catch {
    $("channels").textContent = "";
  }
}

async function openFromHash() {
  const match = /^#monitor-(\d+)$/.exec(location.hash);
  if (match) await showDetail(Number(match[1]));
}

await loadChannels();
await refresh();
await openFromHash();
window.addEventListener("hashchange", openFromHash);
setInterval(() => {
  // Avoid re-rendering under an open dialog's feet; the next tick catches up.
  if (!document.querySelector("dialog[open]")) refresh();
}, REFRESH_MS);
