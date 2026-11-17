#!/usr/bin/env bun
/**
 * panel.js: the browser panel served at `/`.
 *
 * One job: let the operator point the bridge's egress at an HTTP proxy and see
 * whether that proxy actually reaches upstream. Everything the panel draws comes
 * from `proxy.describe()` over JSON; no user-supplied value is interpolated into
 * this HTML, and the client sets every dynamic string with `textContent`.
 *
 * Design direction: Material Design 3, as requested by the operator. A settings
 * console for the local bridge, using MD3 tonal surfaces, outlined fields, and
 * one filled primary action. A compact top app bar holds a live status pill and
 * four text tabs; tabs group the real operator tasks (see health, change egress,
 * rotate, debug) so a short screen never scrolls through unrelated sections.
 * System UI type for prose; monospace only where characters are read one by one
 * (a proxy URL or an IP). Dials: ENERGY 1, RHYTHM 1, MOTION 1.
 */

const STYLE = `
/* Material Design 3 tokens. Light and dark palettes follow MD3's baseline
   roles. Surfaces are tonal, fields are outlined, and the one filled button
   is the proxy commit action: the decision this screen exists to support.
   Contrast of every text/background pairing was measured against WCAG AA
   (R-25); the log console uses its own fixed elevated surface in both themes. */
:root {
  color-scheme: light dark;
  --primary: #6750A4;
  --on-primary: #FFFFFF;
  --primary-container: #EADDFF;
  --on-primary-container: #21005D;
  --secondary-container: #E8DEF8;
  --on-secondary-container: #1D192B;
  --surface: #FEF7FF;
  --surface-container-low: #F7F2FA;
  --surface-container: #F3EDF7;
  --surface-container-high: #ECE6F0;
  --on-surface: #1D1B20;
  --on-surface-variant: #49454F;
  --outline: #79747E;
  --outline-strong: #49454F;
  --error: #B3261E;
  --success: #1B5E20;
  --log-surface: #1D1B20;
  --log-on-surface: #E6E0E9;
  --log-muted: #CAC4D0;
  --log-warn: #FFD85E;
  --log-error: #F2B8B5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --primary: #D0BCFF;
    --on-primary: #381E72;
    --primary-container: #4F378B;
    --on-primary-container: #EADDFF;
    --secondary-container: #4A4458;
    --on-secondary-container: #E8DEF8;
    --surface: #141218;
    --surface-container-low: #1D1B20;
    --surface-container: #211F26;
    --surface-container-high: #2B2930;
    --on-surface: #E6E0E9;
    --on-surface-variant: #CAC4D0;
    --outline: #938F99;
    --outline-strong: #CAC4D0;
    --error: #F2B8B5;
    --success: #6DD58C;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 140px; }
body {
  margin: 0;
  padding: 0 20px 64px;
  background: var(--surface);
  color: var(--on-surface);
  font: 16px/1.55 Roboto, "Segoe UI", system-ui, -apple-system, sans-serif;
}
main { max-width: 640px; margin: 0 auto; }
/* MD3 top app bar, compact and sticky. The tab row sits inside it so the
   current task stays visible and one thumb tap reaches any other task. */
.app-bar {
  position: sticky; top: 0; z-index: 10;
  margin: 0 -20px; padding: 12px 20px 0;
  background: var(--surface);
  border-bottom: 1px solid var(--surface-container-high);
}
.app-bar-inner { max-width: 640px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
h1 { font-size: 1.25rem; line-height: 1.3; font-weight: 500; margin: 0; flex: 1; }
/* Live status chip: real state from /health, never decorative (R-09, R-31). */
.app-status {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 16px; font-size: 0.8125rem; font-weight: 500;
  background: var(--surface-container); color: var(--on-surface-variant);
}
.app-status[data-state="idle"] { background: var(--surface-container); color: var(--on-surface-variant); }
.app-status[data-state="ok"] { background: var(--surface-container); color: var(--success); }
.app-status[data-state="warn"] { background: var(--surface-container); color: var(--error); }
.app-status .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.sub { margin: 10px 0 0; color: var(--on-surface-variant); font-size: 0.875rem; }
/* MD3 primary tabs: text labels, 48dp tall, 3dp indicator marking the active
   tab. The indicator is a real state marker, not decoration. */
.tabs {
  display: flex; gap: 4px; max-width: 640px; margin: 12px auto 0;
  overflow-x: auto; scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  flex: 1 0 auto; min-width: 84px; min-height: 48px;
  padding: 12px 12px 10px; border: none; border-radius: 0;
  background: transparent; color: var(--on-surface-variant);
  font-size: 0.875rem; font-weight: 500;
  border-bottom: 3px solid transparent;
}
.tab[aria-selected="true"] { color: var(--primary); border-bottom-color: var(--primary); }
.tab:focus-visible { outline-offset: -3px; }
.panel[hidden] { display: none; }
/* Section heads are MD3 title-small, not uppercase tracking (R-06). */
h2 { font-size: 1rem; font-weight: 500; line-height: 1.4; color: var(--on-surface); margin: 0 0 12px; }
section { margin-bottom: 24px; }
/* MD3 filled card: surface-container-low, 12dp radius, no shadow. Elevation
   is reserved for the log console only. */
.status, .live-box, .card, .pool-list li {
  border: none; border-radius: 12px; background: var(--surface-container-low);
}
.status {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px;
  padding: 16px;
}
.status .mode { font-weight: 500; color: var(--primary); }
.status .host { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9375rem; }
.status .note { color: var(--on-surface-variant); font-size: 0.875rem; width: 100%; }
.field { margin-bottom: 16px; }
label { display: block; font-weight: 500; font-size: 0.9375rem; margin-bottom: 6px; color: var(--on-surface); }
/* MD3 outlined text fields: 4dp radius, outline border, filled surface,
   primary border/focus ring. Focus is visible for keyboard use (R-32). */
input[type="text"], input[type="password"], input[type="number"], textarea, select {
  width: 100%; padding: 10px 12px; font-size: 1rem; font-family: inherit;
  color: var(--on-surface); background: var(--surface);
  border: 1px solid var(--outline-strong); border-radius: 4px;
  appearance: none;
}
input[type="text"], textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
textarea { font-size: 0.9375rem; resize: vertical; }
select {
  font-size: 0.9375rem;
  background-image: linear-gradient(45deg, transparent 50%, var(--on-surface-variant) 50%),
                    linear-gradient(135deg, var(--on-surface-variant) 50%, transparent 50%);
  background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 32px;
}
input::placeholder, textarea::placeholder { color: var(--on-surface-variant); opacity: 1; }
.pool-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.pool-list[hidden] { display: none; }
.pool-list li {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  padding: 12px; font-size: 0.9375rem;
}
.pool-list .name { font-weight: 500; }
.pool-list .addr { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.875rem; }
/* State labels: real server state only (ready/cooling/disabled), no decoration. */
.pool-list .state { margin-left: auto; font-size: 0.8125rem; font-weight: 500; }
.pool-list .state[data-state="ready"] { color: var(--success); }
.pool-list .state[data-state="cooling"] { color: var(--error); }
.pool-list .state[data-state="disabled"] { color: var(--on-surface-variant); }
.pool-list .detail { width: 100%; color: var(--on-surface-variant); font-size: 0.8125rem; }
/* Model list: one row per discovered model with a real probe action. */
.model-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; }
.model-list[hidden] { display: none; }
.model-list li {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 10px 12px; border-radius: 12px; background: var(--surface-container-low);
}
.model-list .model-id { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.875rem; overflow-wrap: anywhere; }
.model-list button { min-height: 44px; padding: 8px 16px; font-size: 0.8125rem; }
.hint { margin: 6px 0 0; font-size: 0.875rem; color: var(--on-surface-variant); }
.hint code { font-size: 0.8125rem; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
/* MD3 buttons: filled (primary), tonal (secondary), outlined (tertiary).
   The proxy save is the single filled action; all others are tonal or outlined. */
button {
  font: inherit; font-size: 0.9375rem; font-weight: 500;
  padding: 10px 20px; min-height: 40px;
  border-radius: 20px; border: 1px solid transparent;
  background: transparent; color: var(--primary); cursor: pointer;
}
button.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
button.tonal { background: var(--secondary-container); color: var(--on-secondary-container); }
button:disabled { opacity: 0.45; cursor: default; }
:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
.report { margin-top: 16px; font-size: 0.9375rem; }
.report[hidden] { display: none; }
.report .line { margin: 0 0 4px; }
.report .ok { color: var(--success); font-weight: 500; }
.report .bad { color: var(--error); font-weight: 500; }
.report .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
/* Live summary: cards on a tonal grid. The gate card is the only one that
   carries state color; the rest stay ink so color marks where attention goes. */
.card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.card { display: flex; flex-direction: column; gap: 2px; padding: 16px; }
.card-label { font-size: 0.75rem; font-weight: 500; color: var(--on-surface-variant); }
.card-val { font-size: 1.0625rem; font-weight: 500; overflow-wrap: anywhere; }
.card-val.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9375rem; }
.card-sub { font-size: 0.8125rem; color: var(--on-surface-variant); }
.card[data-gate="open"] .card-val { color: var(--success); }
.card[data-gate="throttled"] .card-val, .card[data-gate="ip-blocked"] .card-val { color: var(--error); }
.usage { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.875rem; }
.usage-wrap { overflow-x: auto; }
.usage caption { text-align: left; color: var(--on-surface-variant); font-size: 0.8125rem; padding-bottom: 6px; }
.usage th, .usage td { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--surface-container-high); }
.usage tbody tr:last-child td { border-bottom: none; }
.usage th { color: var(--on-surface-variant); font-weight: 500; }
.usage td.num, .usage th.num { text-align: right; font-variant-numeric: tabular-nums; }
.updated { margin: 10px 0 0; color: var(--on-surface-variant); font-size: 0.8125rem; }
/* Log console: the one deliberately elevated dark surface in both themes.
   Reason: a log stream reads as a terminal; the tonal surface fights monospace
   output, so one inset console carries that character (one focal treatment). */
.logbox {
  background: var(--log-surface); color: var(--log-on-surface);
  border: none; border-radius: 12px;
  padding: 12px; margin: 0;
  height: 300px; overflow-y: auto;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.logbox .row { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.logbox .row .t { color: var(--log-muted); }
.logbox .row[data-level="warn"] { color: var(--log-warn); }
.logbox .row[data-level="error"] { color: var(--log-error); }
.logtabs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.logtabs button { min-height: 36px; padding: 6px 14px; font-size: 0.8125rem; }
.logtabs button[aria-pressed="true"] { background: var(--secondary-container); color: var(--on-secondary-container); }
.logtabs .log-auto { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 0.875rem; font-weight: 500; }
.logtabs .log-auto input { width: auto; margin: 0; }
#log-stamp { margin: 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0; font-size: 0.9375rem; }
dt { color: var(--on-surface-variant); }
dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--surface-container-high); padding-top: 16px; color: var(--on-surface-variant); font-size: 0.875rem; }
footer a { color: var(--primary); }
dd a { display: inline-block; padding: 12px 4px; margin: -12px -4px; min-height: 44px; }
@media (max-width: 600px) {
  body { padding: 0 16px 48px; }
  .app-bar { margin: 0 -16px; padding: 10px 16px 0; }
  h1 { font-size: 1.125rem; }
  .sub { font-size: 0.8125rem; }
  .tab { min-width: 76px; padding: 10px 8px; font-size: 0.8125rem; }
  .actions button { width: 100%; }
  dl { grid-template-columns: 1fr; gap: 2px 0; }
  dd { margin-bottom: 8px; }
  .logbox { height: 220px; }
}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);

// --- tabs: one task per pane, keyboard arrows included (R-32) ---
const TAB_IDS = ["tab-ringkasan", "tab-proxy", "tab-rotator", "tab-log"];
function selectTab(id) {
  for (const tabId of TAB_IDS) {
    const tab = $(tabId);
    const pane = $(tab.getAttribute("aria-controls"));
    const active = tabId === id;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    pane.hidden = !active;
  }
}
for (const [index, tabId] of TAB_IDS.entries()) {
  const tab = $(tabId);
  tab.addEventListener("click", () => selectTab(tabId));
  tab.addEventListener("keydown", (event) => {
    let next = null;
    if (event.key === "ArrowRight") next = TAB_IDS[(index + 1) % TAB_IDS.length];
    if (event.key === "ArrowLeft") next = TAB_IDS[(index - 1 + TAB_IDS.length) % TAB_IDS.length];
    if (event.key === "Home") next = TAB_IDS[0];
    if (event.key === "End") next = TAB_IDS[TAB_IDS.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    $(next).focus();
  });
}

const urlInput = $("proxy-url");
const saveBtn = $("save");
const testBtn = $("test");
const directBtn = $("direct");
const report = $("report");
const form = $("form");

function line(text, cls) {
  const p = document.createElement("p");
  p.className = "line" + (cls ? " " + cls : "");
  p.textContent = text;
  return p;
}

// --- live summary (dashboard) ---

let liveTimer = null;
// One shared egress-IP probe per dashboard refresh cycle: the trace request is
// real upstream traffic, so it must not fire per line render.
let egressIpState = { at: 0, promise: null };

async function probeEgressIp() {
  if (egressIpState.promise && Date.now() - egressIpState.at < 15000) {
    return egressIpState.promise;
  }
  egressIpState.at = Date.now();
  egressIpState.promise = (async () => {
    try {
      return await readJson(await fetch("/api/egress-ip"));
    } catch (err) {
      return { ok: false, ip: null, error: err.message };
    }
  })();
  return egressIpState.promise;
}

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function renderLive(h) {
  const box = $("live-box");
  const d = h.identity || {};
  const gate = d.gate || {};
  const rot = (h.egress || {}).rotator || {};

  // Header chip: one real fact from this health snapshot, text first so the
  // state never depends on color alone (R-25, C-4).
  const chip = $("app-status");
  const chipText = $("app-status-text");
  const gateStatus = gate.status || "tidak diketahui";
  const chipState = gateStatus === "open" ? "ok" : gateStatus === "tidak diketahui" ? "idle" : "warn";
  chip.dataset.state = chipState;
  chipText.textContent = gateStatus === "open"
    ? "Upstream siap"
    : gateStatus === "throttled"
      ? "Upstream throttled"
      : gateStatus === "ip-blocked"
        ? "IP diblokir"
        : "Gate " + gateStatus;

  // Card row: gate, egress IP, models, rotator. Reason: these are the four
  // facts an operator glances at, and equal weight would hide which one
  // demands attention — so the gate card carries the state color and the
  // others stay ink (hierarchy, not decoration).
  const grid = document.createElement("div");
  grid.className = "card-row";

  const gateCard = statusCard("Gate upstream", gate.status || "tidak diketahui");
  gateCard.dataset.gate = gate.status || "";
  const gateSub = [];
  if (gate.status === "throttled" && gate.throttledUntil) {
    gateSub.push("cooldown sisa " + Math.max(0, Math.ceil((gate.throttledUntil - Date.now()) / 1000)) + " dtk");
  }
  if (gate.status === "ip-blocked" && gate.ipBlockedSince) {
    gateSub.push("ditolak upstream sejak " + new Date(gate.ipBlockedSince).toLocaleTimeString());
  }
  if (gate.lastUpstreamError) gateSub.push(gate.lastUpstreamError);
  if (gateSub.length) gateCard.querySelector(".card-sub").textContent = gateSub.join(" · ");
  grid.append(gateCard);

  // Egress IP: the trace round-trip finishes after the snapshot, so this card
  // says "memeriksa …" first and patches in place.
  const ipCard = statusCard("IP egress", "memeriksa …", "yang dilihat upstream");
  ipCard.querySelector(".card-val").classList.add("mono");
  probeEgressIp().then((r2) => {
    const val = ipCard.querySelector(".card-val");
    if (r2 && r2.ip) {
      val.textContent = r2.ip;
    } else {
      val.textContent = "tidak terbaca";
      ipCard.dataset.gate = "throttled";
      ipCard.querySelector(".card-sub").textContent = (r2 && r2.error) || "probe gagal";
    }
  });
  grid.append(ipCard);

  grid.append(statusCard("Model gratis", String(h.discoveredModels ?? "0"), "aktif hari ini"));

  const rotVal = rot.enabled ? (rot.rotations || 0) + " rotasi" : "nonaktif";
  const rotSub = rot.enabled ? "hop otomatis saat 429" : "belum dikonfigurasi";
  const rotCard = statusCard("Rotator " + (rot.provider === "tor" ? "Tor" : "WARP"), rotVal, rotSub);
  if (rot.enabled && rot.coolingForMs > 0) {
    rotCard.querySelector(".card-sub").textContent = "cooldown " + Math.ceil(rot.coolingForMs / 1000) + " dtk";
  }
  grid.append(rotCard);

  const stamp = document.createElement("p");
  stamp.className = "updated";
  stamp.textContent = "Diperbarui " + new Date().toLocaleTimeString() + " · otomatis tiap 15 dtk";

  box.replaceChildren(grid, wrapUsage(buildUsage(h)), stamp);
}

// The usage table is wider than a 390px phone (five columns of numbers), so it
// rides in a horizontal scroll wrapper instead of pushing the page wide
// (R-03: no page-level overflow; the table scrolls inside its own box).
function wrapUsage(table) {
  const wrap = document.createElement("div");
  wrap.className = "usage-wrap";
  wrap.append(table);
  return wrap;
}

function statusCard(label, value, sub) {
  const card = document.createElement("div");
  card.className = "card";
  const head = document.createElement("span");
  head.className = "card-label";
  head.textContent = label;
  const val = document.createElement("span");
  val.className = "card-val";
  val.textContent = value;
  const subEl = document.createElement("span");
  subEl.className = "card-sub";
  subEl.textContent = sub || "";
  card.append(head, val, subEl);
  return card;
}

// Per-egress traffic for today, straight from /health egress.usage.perEgress.
function buildUsage(h) {
  const usage = (h.egress || {}).usage || {};
  const rows = usage.perEgress || {};
  const keys = Object.keys(rows);
  const table = document.createElement("table");
  table.className = "usage";
  const cap = document.createElement("caption");
  cap.textContent = "Pemakaian egress hari ini" + (usage.day ? " (" + usage.day + ")" : "");
  table.append(cap);
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const t of ["Egress", "Req", "OK", "Masuk", "Keluar"]) {
    const th = document.createElement("th");
    th.textContent = t;
    if (t !== "Egress") th.className = "num";
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);
  const tbody = document.createElement("tbody");
  for (const k of keys) {
    const u = rows[k] || {};
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = u.label || (k === "@direct" ? "langsung" : k);
    tr.append(name);
    for (const v of [u.requests, u.okRequests]) {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = String(v ?? 0);
      tr.append(td);
    }
    for (const v of [u.requestBytes, u.responseBytes]) {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = fmtBytes(v);
      tr.append(td);
    }
    tbody.append(tr);
  }
  if (keys.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "Belum ada request hari ini.";
    tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

// --- model list: every discovered model gets a real probe action ---
async function loadModels() {
  const list = $("model-list");
  try {
    const data = await readJson(await fetch("/v1/models"));
    const ids = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    list.replaceChildren(...ids.map((id) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "model-id";
      name.textContent = id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tonal";
      btn.textContent = "Uji";
      btn.setAttribute("aria-label", "Uji model " + id);
      btn.addEventListener("click", () => testOneModel(id, btn));
      li.append(name, btn);
      return li;
    }));
    list.hidden = ids.length === 0;
  } catch {
    list.hidden = true;
  }
}

async function testOneModel(id, btn) {
  const box = $("model-test-report");
  box.hidden = false;
  box.replaceChildren(line("Menguji " + id + " …"));
  btn.disabled = true;
  try {
    const r = await send("/api/models/test", { model: id });
    const cls = r.state === "ok" ? "ok" : "bad";
    box.replaceChildren(
      line(id + ": " + r.label + (r.durationMs ? " (" + (r.durationMs / 1000).toFixed(1) + " dtk)" : ""), cls)
    );
  } catch (err) {
    box.replaceChildren(line(id + ": " + err.message, "bad"));
  } finally {
    btn.disabled = false;
  }
}
loadModels();

async function loadLive() {
  try {
    renderLive(await readJson(await fetch("/health")));
  } catch {
    // Transient failures (restart upstream, network blip) keep the last
    // snapshot; the stamp goes stale on purpose so the operator can see it.
    const stamp = document.querySelector("#live-box .updated");
    if (stamp) stamp.textContent = "Gagal memuat — menampilkan data terakhir";
  }
}
liveTimer = setInterval(loadLive, 15000);
loadLive();

function showReport(nodes) {
  report.replaceChildren(...nodes);
  report.hidden = false;
}

let locked = false;

// Busy disables everything so a second click cannot race the first. Idle
// restores the lock: an env-owned proxy blocks saving, but probing a candidate
// proxy is read-only and stays available.
function setBusy(busy) {
  saveBtn.disabled = busy || locked;
  directBtn.disabled = busy || locked;
  testBtn.disabled = busy;
}

function renderStatus(state) {
  $("mode").textContent =
    state.mode === "pool" ? "Pool aktif" : state.mode === "proxy" ? "Lewat proxy" : "Langsung (IP asli)";
  $("mode").dataset.mode = state.mode === "direct" ? "direct" : "proxy";
  $("host").textContent = state.proxy || "tidak ada proxy";
  const notes = [];
  if (state.locked) notes.push("Dikunci " + state.source + ": ubah variabel environment lalu restart.");
  if (state.hasCredentials) notes.push("Kredensial tersimpan, tidak ditampilkan.");
  if (state.source === "file") notes.push("Disimpan di " + state.configPath);
  if (state.error) notes.push(state.error);
  $("note").textContent = notes.join(" ");
  $("note").hidden = notes.length === 0;
  renderPool(state.pool);
}

function renderPool(pool) {
  const list = $("pool-list");
  const state = pool || {};
  const entries = Array.isArray(state.entries) ? state.entries : [];

  if (!state.active || entries.length === 0) {
    list.hidden = true;
    list.replaceChildren();
    return;
  }

  list.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.label || entry.id;

      const addr = document.createElement("span");
      addr.className = "addr";
      addr.textContent = entry.host || "?";

      const badge = document.createElement("span");
      badge.className = "state";
      badge.dataset.state = entry.state;
      badge.textContent =
        entry.state === "ready" ? "siap" : entry.state === "cooling" ? "cooldown" : "nonaktif";

      li.append(name, addr, badge);

      const detail = document.createElement("span");
      detail.className = "detail";
      const bits = [];
      if (entry.state === "cooling" && entry.cooldownMsLeft) {
        bits.push("pulih dalam " + Math.ceil(entry.cooldownMsLeft / 1000) + " dtk");
      }
      if (entry.failures) bits.push(entry.failures + " kegagalan");
      if (entry.lastError) bits.push(entry.lastError);
      if (entry.weight !== 1) bits.push("bobot " + entry.weight);
      if (bits.length) detail.textContent = bits.join(" · ");
      if (bits.length) li.append(detail);

      return li;
    })
  );
  list.hidden = false;
}

/**
 * Parse the textarea into entries. One per line; label=url or a bare URL.
 * Validation happens on the server, which already owns the URL rules, so this
 * only splits the text.
 */
function readPoolInput() {
  return $("pool-entries")
    .value.split("\\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.slice(0, eq).includes("/")) {
        return { label: line.slice(0, eq).trim(), url: line.slice(eq + 1).trim() };
      }
      return { url: line };
    });
}

function poolEntriesToText(pool) {
  const entries = Array.isArray(pool?.entries) ? pool.entries : [];
  return entries
    .map((entry) => (entry.label && entry.label !== entry.id ? entry.label + "=" : "") + (entry.host || ""))
    .join("\\n");
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

async function load() {
  try {
    const state = await readJson(await fetch("/api/proxy"));
    renderStatus(state);

    // Prefill the pool editor from the live config so an operator can edit an
    // existing entry instead of retyping it. Host:port is enough to identify an
    // entry; credentials never round-trip through the panel.
    const poolState = state.pool || {};
    $("pool-entries").value = poolEntriesToText(poolState);
    // Reset the select first: an unknown strategy from a newer release must
    // not leave the select stuck on a stale option, and an existing selection
    // survives because setting an invalid value makes .value empty.
    $("pool-strategy").value = "";
    $("pool-strategy").value = poolState.strategy || "round-robin";

    locked = state.locked;

    // An env-owned proxy is read-only for saving, but the field stays usable so
    // a candidate can still be probed before the operator edits the service unit.
    saveBtn.disabled = locked;
    directBtn.disabled = locked;
    $("pool-save").disabled = locked;
    $("pool-clear").disabled = locked;
  } catch (err) {
    showReport([line("Gagal memuat status: " + err.message, "bad")]);
  }
}

async function send(path, payload) {
  setBusy(true);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await readJson(res);
  } finally {
    setBusy(false);
  }
}

async function save() {
  const value = urlInput.value;
  try {
    const state = await send("/api/proxy", { url: value });
    renderStatus(state);
    urlInput.value = "";
    showReport([line(state.mode === "proxy" ? "Proxy aktif. Request berikutnya memakai egress ini." : "Proxy dimatikan. Egress kembali langsung.", "ok")]);
  } catch (err) {
    showReport([line(err.message, "bad")]);
  }
}

saveBtn.addEventListener("click", save);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  save();
});

testBtn.addEventListener("click", async () => {
  const target = urlInput.value.trim();
  if (!target) {
    showReport([line("Isi URL proxy dulu untuk diuji.", "bad")]);
    return;
  }
  showReport([line("Menguji " + target + " …")]);
  try {
    const r = await send("/api/proxy/test", { url: target });
    const nodes = [];
    if (r.ok) {
      nodes.push(line("Proxy menjawab upstream (HTTP " + r.apiStatus + ") dalam " + r.latencyMs + " ms.", "ok"));
      if (r.exitIp) nodes.push(line("IP keluar: " + r.exitIp, "mono"));
      else nodes.push(line("IP keluar tidak terbaca: " + (r.exitError || "tidak diketahui"), "bad"));
    } else {
      nodes.push(line(r.error || "Uji proxy gagal.", "bad"));
      if (r.exitIp) nodes.push(line("IP keluar: " + r.exitIp, "mono"));
    }
    showReport(nodes);
  } catch (err) {
    showReport([line(err.message, "bad")]);
  }
});

directBtn.addEventListener("click", async () => {
  try {
    const state = await send("/api/proxy", { url: "" });
    renderStatus(state);
    urlInput.value = "";
    showReport([line("Proxy dimatikan. Egress kembali langsung dari IP mesin ini.", "ok")]);
  } catch (err) {
    showReport([line(err.message, "bad")]);
  }
});

function showPoolReport(nodes) {
  const box = $("pool-report");
  box.replaceChildren(...nodes);
  box.hidden = false;
}

// --- rotator (WARP-style hop) ---

const rotCmd = $("rot-command");
const rotProvider = $("rot-provider");
const rotControlHost = $("rot-control-host");
const rotControlPort = $("rot-control-port");
const rotControlPassword = $("rot-control-password");
const rotControlCookie = $("rot-control-cookie");
const rotTorFields = $("rot-tor-fields");
const rotSaveBtn = $("rot-save");
const rotHopBtn = $("rot-hop");
const rotReport = $("rot-report");

function syncRotFields() {
  rotTorFields.hidden = rotProvider.value !== "tor";
}

function showRotReport(nodes) {
  rotReport.replaceChildren(...nodes);
  rotReport.hidden = false;
}

function renderRotator(rot) {
  const state = rot || {};
  rotSaveBtn.disabled = locked || state.locked;
  rotHopBtn.disabled = locked || state.locked || state.busy || !state.enabled;
  const status = $("rot-status");
  status.dataset.state = state.enabled ? (state.coolingForMs > 0 ? "cooling" : "ok") : "off";
  const bits = [];
  const label = state.provider === "tor" ? "Tor" : "WARP";
  if (state.enabled) {
    bits.push("aktif — hop otomatis saat 429");
    if (state.coolingForMs > 0) bits.push("cooldown " + Math.ceil(state.coolingForMs / 1000) + " dtk");
    if (state.locked) bits.push("dikunci environment");
  } else {
    bits.push("nonaktif — 429 diteruskan apa adanya");
  }
  bits.push("provider: " + label);
  if (state.provider === "tor" && state.controlConfigured) bits.push("kontrol Tor siap");
  if (state.rotations) bits.push(state.rotations + " rotasi");
  if (state.lastResult && state.lastResult.at) {
    const r = state.lastResult;
    bits.push("terakhir: " + (r.ok ? (r.fromIp || "?") + " → " + (r.toIp || "?") : "gagal — " + (r.error || "?")));
  }
  status.textContent = bits.join(" · ");
  status.hidden = false;
  renderRotHistory(state.history);
}

async function loadRotator() {
  try {
    const rot = await readJson(await fetch("/api/rotator"));
    if (rot.provider) rotProvider.value = rot.provider;
    if (rot.controlHost) rotControlHost.value = rot.controlHost;
    if (rot.controlPort) rotControlPort.value = String(rot.controlPort);
    syncRotFields();
    renderRotator(rot);
  } catch (err) {
    // The rotator is optional; a panel served by an older bridge or a repair
    // fallback still works without this section reporting.
    showRotReport([line("Rotator tidak tersedia: " + err.message, "bad")]);
  }
}

rotProvider.addEventListener("change", syncRotFields);
rotSaveBtn.addEventListener("click", async () => {
  try {
    const payload = {
      provider: rotProvider.value,
      command: rotCmd.value,
    };
    if (rotProvider.value === "tor") {
      payload.controlHost = rotControlHost.value;
      payload.controlPort = rotControlPort.value;
      payload.controlPassword = rotControlPassword.value;
      payload.controlCookiePath = rotControlCookie.value;
    }
    const state = await send("/api/rotator", payload);
    rotCmd.value = "";
    rotControlPassword.value = "";
    rotControlCookie.value = "";
    renderRotator(state);
    showRotReport([line(state.enabled ? "Konfigurasi rotator disimpan. Hop otomatis aktif pada 429." : "Rotator dimatikan.", "ok")]);
  } catch (err) {
    showRotReport([line(err.message, "bad")]);
  }
});

rotHopBtn.addEventListener("click", async () => {
  showRotReport([line("Rotasi dijalankan … (bisa sampai " + "45 dtk)")]);
  try {
    const r = await send("/api/rotator", { rotate: true });
    if (r.ok) {
      showRotReport([line("IP baru: " + (r.toIp || "?") + (r.fromIp ? " (sebelumnya " + r.fromIp + ")" : ""), "ok")]);
    } else {
      showRotReport([line((r.skipped ? "[" + r.skipped + "] " : "") + (r.error || "Rotasi gagal."), "bad")]);
    }
    renderRotator(await readJson(await fetch("/api/rotator")));
  } catch (err) {
    showRotReport([line(err.message, "bad")]);
  }
});

// --- rotation history (latest first) ---

function renderRotHistory(history) {
  const list = $("rot-history");
  const entries = Array.isArray(history) ? history.slice().reverse() : [];
  if (entries.length === 0) {
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  list.replaceChildren(
    ...entries.map((h) => {
      const li = document.createElement("li");

      const when = document.createElement("span");
      when.className = "mono";
      when.textContent = new Date(h.at).toLocaleTimeString();

      const trigger = document.createElement("span");
      trigger.className = "state";
      trigger.dataset.state = h.trigger === "429" ? "cooling" : "ready";
      trigger.textContent = h.trigger === "429" ? "otomatis (429)" : "manual";

      const out = document.createElement("span");
      out.className = "addr";
      out.textContent = h.ok
        ? (h.fromIp || "?") + " → " + (h.toIp || "?")
        : h.skipped
          ? "dilewati [" + h.skipped + "]"
          : "gagal: " + (h.error || "?");

      const ms = document.createElement("span");
      ms.className = "detail";
      ms.textContent = h.durationMs + " ms" + (h.ok ? "" : h.skipped ? "" : "");

      li.append(when, trigger, out, ms);
      return li;
    })
  );
  list.hidden = false;
}


$("pool-save").addEventListener("click", async () => {
  const entries = readPoolInput();
  if (entries.length === 0) {
    showPoolReport([line("Isi minimal satu proxy.", "bad")]);
    return;
  }
  try {
    const state = await send("/api/proxy", {
      entries,
      strategy: $("pool-strategy").value,
    });
    renderStatus(state);
    showPoolReport([
      line(
        "Pool aktif: " + state.pool.enabled + "/" + state.pool.size + " entri, strategi " + state.pool.strategy + ".",
        "ok"
      ),
    ]);
  } catch (err) {
    showPoolReport([line(err.message, "bad")]);
  }
});

$("pool-test").addEventListener("click", async () => {
  const entries = readPoolInput();
  if (entries.length === 0) {
    showPoolReport([line("Isi minimal satu proxy untuk diuji.", "bad")]);
    return;
  }
  showPoolReport([line("Menguji " + entries.length + " proxy …")]);
  try {
    const r = await send("/api/proxy/test", { entries });
    const nodes = (r.entries || []).map((entry) => {
      const head = (entry.label || entry.host || entry.id) + " — ";
      if (entry.ok) {
        return line(head + "ok, " + entry.latencyMs + " ms, IP " + (entry.exitIp || "tidak terbaca"), "ok");
      }
      return line(head + (entry.error || "gagal"), "bad");
    });
    showPoolReport(nodes.length ? nodes : [line("Tidak ada hasil.", "bad")]);
  } catch (err) {
    showPoolReport([line(err.message, "bad")]);
  }
});

$("pool-clear").addEventListener("click", async () => {
  try {
    const state = await send("/api/proxy", { entries: [] });
    renderStatus(state);
    $("pool-entries").value = "";
    showPoolReport([line("Pool dikosongkan. Egress kembali ke proxy tunggal atau langsung.", "ok")]);
  } catch (err) {
    showPoolReport([line(err.message, "bad")]);
  }
});

// --- log bridge viewer ---

const logBox = $("log-box");
const logStamp = $("log-stamp");
const logAuto = $("log-auto");
let logTimer = null;
// Incremental fetch: only lines newer than the last one drawn. The server
// filters on 'since', so a quiet bridge costs one small JSON round trip.
let lastLogAt = 0;

function drawLogLines(lines) {
  if (!lines.length) return;
  const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
  for (const entry of lines) {
    const row = document.createElement("p");
    row.className = "row";
    row.dataset.level = entry.level;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(entry.at).toLocaleTimeString() + "  ";
    row.append(t, document.createTextNode(entry.text));
    logBox.append(row);
    lastLogAt = entry.at;
  }
  while (logBox.children.length > 600) logBox.removeChild(logBox.firstChild);
  if (atBottom) logBox.scrollTop = logBox.scrollHeight;
}

async function loadLogs(initial) {
  try {
    const body = await readJson(await fetch("/api/logs?since=" + lastLogAt));
    if (initial && body.count === 0) {
      logBox.replaceChildren();
      const row = document.createElement("span");
      row.className = "row";
      row.textContent = "Log kosong — bridge belum mencetak apa pun sejak start.";
      logBox.append(row);
    } else {
      if (initial) logBox.replaceChildren();
      drawLogLines(body.lines || []);
    }
    logStamp.textContent = "Diperbarui " + new Date().toLocaleTimeString();
  } catch (err) {
    logStamp.textContent = "Gagal memuat log: " + err.message;
  }
}

function setLogAuto(on) {
  clearInterval(logTimer);
  logTimer = null;
  if (on) logTimer = setInterval(() => loadLogs(false), 5000);
}

$("log-refresh").addEventListener("click", () => loadLogs(false));
logAuto.addEventListener("change", () => setLogAuto(logAuto.checked));
$("log-copy").addEventListener("click", async () => {
  const text = Array.from(logBox.querySelectorAll(".row"))
    .map((row) => row.textContent)
    .join("\\n");
  try {
    await navigator.clipboard.writeText(text);
    $("log-copy").textContent = "Tersalin";
    setTimeout(() => { $("log-copy").textContent = "Copy"; }, 1500);
  } catch {
    // Clipboard API can be refused on plain-http origins other than loopback.
    logStamp.textContent = "Copy gagal — izin clipboard ditolak browser.";
  }
});

loadLogs(true);
setLogAuto(true);

load();
loadRotator();
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * Full panel document. `description` is `proxy.describe()`; only its scalar
 * fields are read, and they are escaped, so a value from the config file cannot
 * become markup.
 */
function renderPanel(description, { version = "", port = "" } = {}) {
  const state = description || {};
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Proxy egress · opencode-free-bridge</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header class="app-bar">
    <div class="app-bar-inner">
      <h1>Proxy egress</h1>
      <span class="app-status" id="app-status" data-state="ok" role="status" aria-live="polite">
        <span class="dot" aria-hidden="true"></span><span id="app-status-text">Memuat …</span>
      </span>
    </div>
    <p class="sub">Kelola egress bridge: arah keluar, rotasi alamat, dan log langsung dari satu tempat.</p>
    <div class="tabs" role="tablist" aria-label="Bagian panel">
      <button type="button" class="tab" role="tab" id="tab-ringkasan" aria-controls="pane-ringkasan" aria-selected="true" tabindex="0">Ringkasan</button>
      <button type="button" class="tab" role="tab" id="tab-proxy" aria-controls="pane-proxy" aria-selected="false" tabindex="-1">Proxy</button>
      <button type="button" class="tab" role="tab" id="tab-rotator" aria-controls="pane-rotator" aria-selected="false" tabindex="-1">Rotator</button>
      <button type="button" class="tab" role="tab" id="tab-log" aria-controls="pane-log" aria-selected="false" tabindex="-1">Log</button>
    </div>
  </header>

  <div class="panel" id="pane-ringkasan" role="tabpanel" aria-labelledby="tab-ringkasan">
  <section aria-labelledby="live-title">
    <h2 id="live-title">Ringkasan live</h2>
    <div class="live-box" id="live-box">
      <p class="live-line">Memuat …</p>
    </div>
  </section>
  <section aria-labelledby="models-title">
    <h2 id="models-title">Model gratis</h2>
    <p class="hint">Daftar model aktif dari upstream. Uji satu model untuk memastikan model itu menjawab lewat bridge ini.</p>
    <ul class="model-list" id="model-list" hidden></ul>
    <div class="report" id="model-test-report" role="status" aria-live="polite" hidden></div>
  </section>

  <section aria-labelledby="endpoint-title">
    <h2 id="endpoint-title">Endpoint klien</h2>
    <dl>
      <dt>Base URL</dt><dd>http://127.0.0.1:${escapeHtml(port || "20129")}/v1</dd>
      <dt>API key</dt><dd>public</dd>
      <dt>Versi</dt><dd>${escapeHtml(version || "")}</dd>
      <dt>Health</dt><dd><a href="/health">/health</a></dd>
    </dl>
  </section>
  </div>

  <div class="panel" id="pane-proxy" role="tabpanel" aria-labelledby="tab-proxy" hidden>
  <section aria-labelledby="status-title">
    <h2 id="status-title">Status sekarang</h2>
    <div class="status">
      <span class="mode" id="mode">${escapeHtml(state.mode === "pool" ? "Pool aktif" : state.mode === "proxy" ? "Lewat proxy" : "Langsung (IP asli)")}</span>
      <span class="host" id="host">${escapeHtml(state.proxy || "tidak ada proxy")}</span>
      <span class="note" id="note" hidden></span>
    </div>
    <ul class="pool-list" id="pool-list" hidden></ul>
  </section>

  <section aria-labelledby="pool-title">
    <h2 id="pool-title">Pool egress</h2>
    <p class="hint">Satu URL per baris. Tambahkan label dengan <code>nama=url</code>. Pool dipakai bergantian; entri yang ditolak upstream masuk cooldown dan dilewati sampai pulih.</p>
    <div class="field">
      <label for="pool-entries">Daftar proxy</label>
      <textarea id="pool-entries" rows="6" spellcheck="false" placeholder="med1=http://10.0.0.1:8888&#10;med2=http://10.0.0.2:8888"></textarea>
    </div>
    <div class="field">
      <label for="pool-strategy">Strategi</label>
      <select id="pool-strategy">
        <option value="priority-failover">Prioritas + failover (utamakan urutan atas, balik otomatis)</option>
        <option value="round-robin">Round-robin (sebar rata)</option>
        <option value="failover">Failover (pakai yang pertama sampai ditolak)</option>
        <option value="random">Acak berbobot</option>
      </select>
    </div>
    <div class="actions">
      <button type="button" class="tonal" id="pool-save">Simpan pool</button>
      <button type="button" class="tonal" id="pool-test">Uji semua</button>
      <button type="button" class="tonal" id="pool-clear">Kosongkan pool</button>
    </div>
    <div class="report" id="pool-report" role="status" aria-live="polite" hidden></div>
  </section>

  <section aria-labelledby="form-title">
    <h2 id="form-title">Atur proxy</h2>
    <form id="form" novalidate>
      <div class="field">
        <label for="proxy-url">URL proxy</label>
        <input id="proxy-url" name="proxy-url" type="text" inputmode="url" autocomplete="off"
               spellcheck="false" placeholder="http://user:pass@host:8080"
               aria-describedby="url-hint">
        <p class="hint" id="url-hint">Format <code>http://[user:pass@]host:port</code>. Hanya HTTP/HTTPS (tunnel CONNECT). Kosongkan lalu simpan untuk kembali langsung.</p>
      </div>
      <div class="actions">
        <button type="button" class="primary" id="save">Simpan dan pakai</button>
        <button type="button" class="tonal" id="test">Uji koneksi</button>
        <button type="button" class="tonal" id="direct">Matikan proxy</button>
      </div>
      <div class="report" id="report" role="status" aria-live="polite" hidden></div>
    </form>
  </section>
  </div>

  <div class="panel" id="pane-rotator" role="tabpanel" aria-labelledby="tab-rotator" hidden>
  <section aria-labelledby="rotator-title">
    <h2 id="rotator-title">Rotator egress (WARP / Tor)</h2>
    <p class="hint">Saat upstream menjawab <code>429</code> (jatah IP habis), bridge mengganti alamat keluar lalu mengulang request yang sama. WARP menjalankan perintah hop; Tor mengirim <code>SIGNAL NEWNYM</code> lewat control port. Client tidak pernah melihat 429 selama rotasi berhasil.</p>
    <div class="status">
      <span class="mode" id="rot-status" data-state="off" hidden></span>
    </div>
    <div class="field">
      <label for="rot-provider">Provider</label>
      <select id="rot-provider">
        <option value="warp">WARP (perintah hop)</option>
        <option value="tor">Tor (SIGNAL NEWNYM)</option>
      </select>
    </div>
    <div class="field">
      <label for="rot-command">Perintah rotasi (WARP, atau opsional untuk Tor)</label>
      <input id="rot-command" name="rot-command" type="text" autocomplete="off"
             spellcheck="false" placeholder="powershell -File C:\\warp\\hop.ps1">
      <p class="hint">Untuk WARP: script reconnect tunnel. Untuk Tor: bisa dikosongkan jika control port diisi. Kosongkan keduanya untuk mematikan rotator.</p>
    </div>
    <div id="rot-tor-fields" hidden>
      <div class="field">
        <label for="rot-control-host">Host kontrol Tor</label>
        <input id="rot-control-host" type="text" value="127.0.0.1" autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="rot-control-port">Port kontrol Tor</label>
        <input id="rot-control-port" type="number" value="9051" min="1" max="65535">
      </div>
      <div class="field">
        <label for="rot-control-password">Password kontrol Tor</label>
        <input id="rot-control-password" type="password" autocomplete="off" spellcheck="false">
        <p class="hint">Isi password ATAU path cookie, tidak keduanya.</p>
      </div>
      <div class="field">
        <label for="rot-control-cookie">Path cookie Tor</label>
        <input id="rot-control-cookie" type="text" autocomplete="off" spellcheck="false" placeholder="/var/lib/tor/control_auth_cookie">
      </div>
    </div>
    <div class="actions">
      <button type="button" class="tonal" id="rot-save">Simpan konfigurasi</button>
      <button type="button" class="tonal" id="rot-hop">Rotasi sekarang</button>
    </div>
    <div class="report" id="rot-report" role="status" aria-live="polite" hidden></div>
    <ul class="pool-list" id="rot-history" hidden></ul>
    <p class="hint">Riwayat di atas: hasil tiap percobaan rotasi (manual dan otomatis saat 429), terbaru di atas — IP sebelum → sesudah, atau alasan gagal/dilewati.</p>
  </section>
  </div>

  <div class="panel" id="pane-log" role="tabpanel" aria-labelledby="tab-log" hidden>
  <section aria-labelledby="status-title">
    <h2 id="logs-title">Log bridge</h2>
    <div class="logtabs">
      <button type="button" class="tonal" id="log-refresh">Muat ulang</button>
      <button type="button" class="tonal" id="log-copy">Copy</button>
      <label class="log-auto"><input type="checkbox" id="log-auto" checked> Auto</label>
    </div>
    <pre class="logbox" id="log-box" tabindex="0" aria-label="Log bridge, terbaru di bawah"><span class="row">Memuat log …</span></pre>
    <p class="updated" id="log-stamp"></p>
    <p class="hint">Buffer in-memory (terakhir 500 baris sejak bridge start). Riwayat penuh tetap di service: <code>journalctl -u opencode-free-bridge -f</code> (Linux), <code>docker compose logs -f</code> (Docker), atau terminal tempat <code>bun server.js</code> jalan.</p>
  </section>

  </div>

  <footer>
    Proxy berlaku untuk inference, discovery model, sinkronisasi identity, dan cek update. Perubahan langsung dipakai request berikutnya, tanpa restart.
  </footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderPanel };
