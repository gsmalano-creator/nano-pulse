/**
 * The read-only dashboard, served as one self-contained document.
 *
 * Deliberately a single file with no build step and no third-party anything:
 * this page holds someone's API key, so every byte it loads is a byte that
 * could read that key. The CSP below is the enforcement, not the intention --
 * `default-src 'none'` plus a per-request nonce means an injected script has
 * nowhere to come from and nowhere to send to.
 *
 * Every fetch is same-origin. The worker answers the whole API on every
 * hostname it is routed to, so a page served from dash.nano-api.com can call
 * /v1/monitors on its own origin. That is why there is no CORS anywhere in
 * this codebase, and why there should not be.
 */

export function contentSecurityPolicy(nonce: string): string {
	return [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		"connect-src 'self'",
		"img-src 'self' data:",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}

const STYLE = `
:root {
  --bg:#0b0f14; --surface:#111822; --surface-2:#161f2b; --border:#223041;
  --text:#e7eef6; --muted:#9bacc0; --alive:#35d399; --alive-ink:#35d399;
  --alert:#fb7185; --warn:#fbbf5c; --link:#7cc9f0;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#fff; --surface:#f7f9fc; --surface-2:#eef2f7; --border:#dde4ed;
    --text:#0e1620; --muted:#56677a; --alive:#10a06f; --alive-ink:#08744f;
    --alert:#c92a43; --warn:#8a5b00; --link:#0a6fb5;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--bg); color:var(--text);
  font:14px/1.5 ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing:antialiased;
}
code, .mono { font-family:var(--mono); }
a { color:var(--link); }
header {
  position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:.6em 1.2em;
  align-items:center; padding:.7em 1.1em; background:var(--bg);
  border-bottom:1px solid var(--border);
}
.brand { display:flex; align-items:center; gap:.5em; font-family:var(--mono); font-weight:700; }
.brand svg { color:var(--alive); }
.spacer { margin-left:auto; }
.meta { display:flex; flex-wrap:wrap; gap:.5em .9em; align-items:center; font-size:12px; color:var(--muted); }
button {
  font:inherit; font-size:12px; padding:.4em .8em; border-radius:8px; cursor:pointer;
  background:var(--surface-2); color:var(--text); border:1px solid var(--border);
}
button:hover { border-color:var(--muted); }
button.primary { background:var(--alive); color:#05211a; border-color:var(--alive); font-weight:700; }
main { max-width:1100px; margin:0 auto; padding:1.4em 1.1em 4em; }
h1 { font-size:1.3rem; margin:0 0 .4em; }
h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);
     margin:2.2em 0 .7em; font-weight:700; }
h2 .n { color:var(--text); }
.panel { border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--surface); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th {
  text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); font-weight:600; padding:.55em .9em; background:var(--surface-2);
  border-bottom:1px solid var(--border); white-space:nowrap;
}
td { padding:.5em .9em; border-bottom:1px solid var(--border); vertical-align:top; }
tr:last-child td { border-bottom:none; }
td.mono, th.mono { font-family:var(--mono); font-size:12px; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:.5em; vertical-align:baseline; }
.ok { background:var(--alive); } .down { background:var(--alert); }
.pending { background:var(--muted); } .paused { background:var(--warn); }
.s-ok { color:var(--alive-ink); } .s-down { color:var(--alert); }
.s-pending { color:var(--muted); } .s-paused { color:var(--warn); }
.empty { padding:1.3em .9em; color:var(--muted); font-size:13px; }
.empty pre { margin:.7em 0 0; }
pre {
  margin:0; padding:.8em .9em; background:var(--bg); border:1px solid var(--border);
  border-radius:8px; font-family:var(--mono); font-size:12px; overflow-x:auto;
}
.gate { max-width:34em; margin:9vh auto; padding:0 1.1em; }
.gate p { color:var(--muted); }
.gate input {
  width:100%; font-family:var(--mono); font-size:13px; padding:.7em .8em; border-radius:8px;
  border:1px solid var(--border); background:var(--surface); color:var(--text); margin-bottom:.8em;
}
.gate input:focus { outline:2px solid var(--alive); outline-offset:1px; }
.note { border-left:3px solid var(--warn); padding:.1em 0 .1em .9em; margin:1.2em 0; }
.note.bad { border-color:var(--alert); }
.err { color:var(--alert); font-size:13px; }
.muted { color:var(--muted); }
.hidden { display:none !important; }
@media (max-width:620px) {
  th:nth-child(n+4), td:nth-child(n+4) { display:none; }
}
`;

const SCRIPT = `
"use strict";
var KEY = null;
var timer = null;
var live = true;

var el = function (id) { return document.getElementById(id); };
function text(s) { return document.createTextNode(s == null ? "" : String(s)); }
function node(tag, cls, content) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (content !== undefined) n.appendChild(text(content));
  return n;
}

// Relative time, because "2026-09-24T13:25:01.000Z" is not an answer to
// "is it alive". Absolute time stays in the title attribute.
function rel(iso) {
  if (!iso) return "never";
  var t = Date.parse(iso);
  if (isNaN(t)) return "-";
  var d = Math.round((Date.now() - t) / 1000);
  var future = d < 0;
  d = Math.abs(d);
  var s;
  if (d < 60) s = d + "s";
  else if (d < 3600) s = Math.floor(d / 60) + "m";
  else if (d < 86400) s = Math.floor(d / 3600) + "h";
  else s = Math.floor(d / 86400) + "d";
  return future ? "in " + s : s + " ago";
}
function timeCell(iso) {
  var td = node("td", "mono");
  td.appendChild(text(rel(iso)));
  if (iso) td.title = iso;
  return td;
}

function api(path) {
  return fetch(path, { headers: { authorization: "Bearer " + KEY } }).then(function (r) {
    if (r.status === 401) throw new Error("unauthorized");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function table(cols, rows, build, emptyHtml) {
  var panel = node("div", "panel");
  if (!rows.length) {
    var e = node("div", "empty");
    e.appendChild(text(emptyHtml.text));
    if (emptyHtml.curl) { var pre = node("pre"); pre.appendChild(text(emptyHtml.curl)); e.appendChild(pre); }
    panel.appendChild(e);
    return panel;
  }
  var t = document.createElement("table");
  var thead = document.createElement("thead");
  var tr = document.createElement("tr");
  cols.forEach(function (c) {
    var parts = String(c).split("|");
    tr.appendChild(node("th", parts[1] ? parts[1] : null, parts[0]));
  });
  thead.appendChild(tr);
  var tbody = document.createElement("tbody");
  rows.forEach(function (row) { tbody.appendChild(build(row)); });
  t.appendChild(thead); t.appendChild(tbody);
  panel.appendChild(t);
  return panel;
}

function section(id, title, count, panel) {
  var wrap = el(id);
  wrap.textContent = "";
  var h = node("h2", null, title + " ");
  h.appendChild(node("span", "n", "(" + count + ")"));
  wrap.appendChild(h);
  wrap.appendChild(panel);
}

function fail(id, title, message) {
  var panel = node("div", "panel");
  var e = node("div", "empty");
  e.appendChild(node("span", "err", "Could not load: " + message));
  panel.appendChild(e);
  section(id, title, "!", panel);
}

function renderMonitors(d) {
  var rows = d.monitors || [];
  section("monitors", "Heartbeats", rows.length, table(
    ["Status", "Slug", "Last ping", "Due", "Every|num", "Grace|num", "Alerts"], rows,
    function (m) {
      var tr = document.createElement("tr");
      var st = node("td");
      st.appendChild(node("span", "dot " + m.status));
      st.appendChild(node("span", "s-" + m.status, m.status));
      tr.appendChild(st);
      tr.appendChild(node("td", "mono", m.slug));
      tr.appendChild(timeCell(m.last_ping_at));
      tr.appendChild(timeCell(m.alert_due_at));
      tr.appendChild(node("td", "mono num", m.expected_interval_seconds + "s"));
      tr.appendChild(node("td", "mono num", m.grace_period_seconds + "s"));
      tr.appendChild(node("td", "mono", m.alert_webhook_configured ? "yes" : "none"));
      return tr;
    },
    { text: "No heartbeats. The first ping creates one:",
      curl: "curl -X POST $PULSE/v1/ping/nightly-backup?interval=86400 \\\\\\n  -H \\"Authorization: Bearer $WRITE_KEY\\"" }));
}

function renderSchedules(d) {
  var rows = d.schedules || [];
  section("schedules", "Schedules", rows.length, table(
    ["Status", "Slug", "Cron", "Timezone", "Next run", "Last run", "Last"], rows,
    function (s) {
      var tr = document.createElement("tr");
      var state = s.paused ? "paused" : (s.consecutive_failures > 0 ? "down" : "ok");
      var st = node("td");
      st.appendChild(node("span", "dot " + state));
      st.appendChild(node("span", "s-" + state, s.paused ? "paused" : (s.consecutive_failures > 0 ? "failing" : "ok")));
      tr.appendChild(st);
      tr.appendChild(node("td", "mono", s.slug));
      tr.appendChild(node("td", "mono", s.cron));
      tr.appendChild(node("td", "mono", s.timezone));
      tr.appendChild(timeCell(s.next_run_at));
      tr.appendChild(timeCell(s.last_run_at));
      tr.appendChild(node("td", "mono", s.last_status == null ? "-" : String(s.last_status)));
      return tr;
    },
    { text: "No schedules yet.", curl: "curl -X POST $RELAY/v1/schedules -H \\"Authorization: Bearer $WRITE_KEY\\" \\\\\\n  -d '{\\"slug\\":\\"nightly\\",\\"cron\\":\\"0 3 * * *\\",\\"timezone\\":\\"Europe/Oslo\\",\\"url\\":\\"https://...\\"}'" }));
}

function renderLocks(d) {
  var rows = d.locks || [];
  section("locks", "Locks", rows.length, table(
    ["Status", "Name", "Owner", "Expires", "Fence|num"], rows,
    function (l) {
      var tr = document.createElement("tr");
      var state = l.held ? "ok" : "pending";
      var st = node("td");
      st.appendChild(node("span", "dot " + state));
      st.appendChild(node("span", "s-" + state, l.held ? "held" : "free"));
      tr.appendChild(st);
      tr.appendChild(node("td", "mono", l.name));
      tr.appendChild(node("td", "mono", l.owner || "-"));
      tr.appendChild(timeCell(l.expires_at));
      tr.appendChild(node("td", "mono num", l.fence));
      return tr;
    },
    { text: "No locks. A lock appears the first time something acquires it." }));
}

function renderConfigs(d) {
  var rows = d.configs || [];
  section("configs", "Configs", rows.length, table(
    ["Name", "Version|num", "Keys|num", "Updated"], rows,
    function (c) {
      var tr = document.createElement("tr");
      tr.appendChild(node("td", "mono", c.name));
      tr.appendChild(node("td", "mono num", "v" + c.version));
      tr.appendChild(node("td", "mono num", c.keys));
      tr.appendChild(timeCell(c.updated_at));
      return tr;
    },
    { text: "No config documents yet." }));
}

function renderCounters(d) {
  var rows = d.counters || [];
  section("counters", "Counters", rows.length, table(
    ["Name", "Value|num", "Label", "Updated", "Badge"], rows,
    function (c) {
      var tr = document.createElement("tr");
      tr.appendChild(node("td", "mono", c.name));
      tr.appendChild(node("td", "mono num", c.value));
      tr.appendChild(node("td", "mono", c.label || "-"));
      tr.appendChild(timeCell(c.updated_at));
      var link = node("td");
      var a = document.createElement("a");
      a.href = c.badge_url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.appendChild(text("svg"));
      link.appendChild(a);
      tr.appendChild(link);
      return tr;
    },
    { text: "No counters yet." }));
}

function renderKeys(d) {
  var rows = d.keys || [];
  section("keys", "API keys", rows.length, table(
    ["Status", "Prefix", "Scope", "Name", "Last used"], rows,
    function (k) {
      var tr = document.createElement("tr");
      var state = k.active ? "ok" : "pending";
      var st = node("td");
      st.appendChild(node("span", "dot " + state));
      st.appendChild(node("span", "s-" + state, k.id === d.current_key_id ? "this one" : (k.active ? "active" : "revoked")));
      tr.appendChild(st);
      tr.appendChild(node("td", "mono", k.key_prefix));
      tr.appendChild(node("td", "mono", k.scope));
      tr.appendChild(node("td", null, k.name || "-"));
      tr.appendChild(timeCell(k.last_used_at));
      return tr;
    },
    { text: "No keys." }));
}

var PANELS = [
  ["/v1/monitors", "monitors", "Heartbeats", renderMonitors],
  ["/v1/schedules", "schedules", "Schedules", renderSchedules],
  ["/v1/locks", "locks", "Locks", renderLocks],
  ["/v1/configs", "configs", "Configs", renderConfigs],
  ["/v1/counters", "counters", "Counters", renderCounters],
  ["/v1/keys", "keys", "API keys", renderKeys]
];

function refresh() {
  // Panels load and fail independently: one endpoint having a bad day should
  // not blank the other five.
  PANELS.forEach(function (p) {
    api(p[0]).then(p[3]).catch(function (e) {
      if (e.message === "unauthorized") return signOut();
      fail(p[1], p[2], e.message);
    });
  });
  api("/v1/whoami").then(function (w) {
    el("quota").textContent = "quota " + w.usage.used + "/" + w.usage.limit;
  }).catch(function () {});
  el("updated").textContent = "updated " + new Date().toLocaleTimeString();
}

function schedule() {
  if (timer) clearInterval(timer);
  if (live) timer = setInterval(refresh, 30000);
}

function start(whoami) {
  el("gate").classList.add("hidden");
  el("app").classList.remove("hidden");
  el("bar").classList.remove("hidden");
  el("who").textContent = whoami.user.email;
  el("keyinfo").textContent = whoami.api_key.prefix + " \\u00b7 " + whoami.api_key.scope;
  refresh();
  schedule();
}

function signOut() {
  try { sessionStorage.removeItem("nano_read_key"); } catch (e) {}
  KEY = null;
  if (timer) clearInterval(timer);
  el("app").classList.add("hidden");
  el("bar").classList.add("hidden");
  el("gate").classList.remove("hidden");
  el("keyin").value = "";
}

function attempt(key) {
  var msg = el("gatemsg");
  var wrong = el("wrongscope");
  msg.textContent = "";
  wrong.classList.add("hidden");
  KEY = key;
  return api("/v1/whoami").then(function (w) {
    // The dashboard is read-only, so it insists on a key that is read-only too.
    // A write key would work for every request on this page, which is exactly
    // why it should not be pasted into a browser to look at a list.
    if (w.api_key.scope !== "read") {
      KEY = null;
      wrong.classList.remove("hidden");
      el("howtolead").textContent = "Mint a read-only one with the key you just tried, then paste that:";
      return;
    }
    try { sessionStorage.setItem("nano_read_key", key); } catch (e) {}
    start(w);
  }).catch(function (e) {
    KEY = null;
    msg.textContent = e.message === "unauthorized" ? "That key is not valid, or it has been revoked." : "Could not reach the API: " + e.message;
  });
}

document.addEventListener("DOMContentLoaded", function () {
  el("gateform").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = el("keyin").value.trim();
    if (v) attempt(v);
  });
  el("signout").addEventListener("click", signOut);
  el("refresh").addEventListener("click", refresh);
  el("pause").addEventListener("click", function () {
    live = !live;
    el("pause").textContent = live ? "pause" : "resume";
    schedule();
  });

  var saved = null;
  try { saved = sessionStorage.getItem("nano_read_key"); } catch (e) {}
  if (saved) attempt(saved);
});
`;

const LOGO = `<svg viewBox="0 0 28 16" width="24" height="14" aria-hidden="true"><path d="M0 8 H6 l2.5 -6 l2.5 12 l2.5 -6 H28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

export function dashboardHtml(nonce: string, pulseBase: string): string {
	const mintCurl = [
		`curl -X POST ${pulseBase}/v1/keys \\`,
		`  -H "Authorization: Bearer $NANO_API_KEY" \\`,
		`  -H 'content-type: application/json' \\`,
		`  -d '{"name":"dashboard","scope":"read"}'`,
	].join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 16'%3E%3Cpath d='M0 8 H6 l2.5 -6 l2.5 12 l2.5 -6 H28' fill='none' stroke='%2335d399' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<title>Dashboard - nano-api</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header id="bar" class="hidden">
  <span class="brand">${LOGO} nano-api</span>
  <span class="meta">
    <span id="who"></span>
    <span id="keyinfo" class="mono"></span>
    <span id="quota"></span>
  </span>
  <span class="spacer"></span>
  <span class="meta"><span id="updated"></span></span>
  <button id="refresh" type="button">refresh</button>
  <button id="pause" type="button">pause</button>
  <button id="signout" type="button">sign out</button>
</header>

<div class="gate" id="gate">
  <span class="brand">${LOGO} nano-api</span>
  <h1>Read-only dashboard</h1>
  <p>
    Everything on one key: heartbeats, schedules, locks, configs and counters.
    Nothing here can change anything, and it needs a key that cannot either.
  </p>
  <form id="gateform">
    <input id="keyin" type="password" autocomplete="off" spellcheck="false"
           placeholder="np_live_..." aria-label="Read-only API key">
    <button class="primary" type="submit">Open</button>
  </form>
  <p id="gatemsg" class="err"></p>

  <div id="wrongscope" class="note bad hidden">
    <p><strong>That key can write.</strong> It was not stored, and nothing was opened.</p>
  </div>

  <div id="howto" class="note">
    <p id="howtolead">You need a key with <code>scope: read</code>. Signup gives you a write key; this makes the other kind:</p>
    <pre>${mintCurl}</pre>
    <p class="muted">
      The scope is fixed at creation and a read key cannot issue a wider one, so this
      is the one that is safe to keep in a browser. It is held in
      <code>sessionStorage</code> and is gone when you close the tab.
    </p>
  </div>
</div>

<main id="app" class="hidden">
  <section id="monitors"></section>
  <section id="schedules"></section>
  <section id="locks"></section>
  <section id="configs"></section>
  <section id="counters"></section>
  <section id="keys"></section>
</main>

<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
