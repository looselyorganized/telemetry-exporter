#!/usr/bin/env bun
/**
 * Telemetry Verification Dashboard
 *
 * Bun HTTP server that serves a self-contained HTML dashboard comparing
 * local telemetry data with what's stored in Supabase.
 *
 * Usage: bun run bin/dashboard.ts
 * Default port: 7777
 */

import { createClient } from "@supabase/supabase-js";
import { readAllLocal } from "../src/verify/local-reader";
import { readAllRemote } from "../src/verify/remote-reader";
import {
  compareEvents,
  compareMetrics,
  compareTokens,
  compareModels,
  compareProjects,
  buildHealth,
} from "../src/verify/comparator";
import { loadEnv } from "../src/cli-output";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "7777", 10);
const { url, key } = loadEnv();
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Snapshot cache (coalesces concurrent requests) ─────────────────────────

import type { LocalData } from "../src/verify/local-reader";
import type { RemoteData } from "../src/verify/remote-reader";

let cachedSnapshot: { local: LocalData; remote: RemoteData; ts: number } | null = null;
const CACHE_TTL = 5_000;

async function getSnapshot(): Promise<{ local: LocalData; remote: RemoteData }> {
  if (cachedSnapshot && Date.now() - cachedSnapshot.ts < CACHE_TTL) {
    return cachedSnapshot;
  }
  const [local, remote] = await Promise.all([
    Promise.resolve(readAllLocal()),
    readAllRemote(supabase),
  ]);
  cachedSnapshot = { local, remote, ts: Date.now() };
  return cachedSnapshot;
}

// ─── API handlers ───────────────────────────────────────────────────────────

async function handleHealth(): Promise<Response> {
  const { local, remote } = await getSnapshot();
  return Response.json(buildHealth(local, remote));
}

async function handleCompare(
  type: string
): Promise<Response> {
  const { local, remote } = await getSnapshot();

  const compareFns: Record<string, () => ReturnType<typeof compareEvents>> = {
    events: () => compareEvents(local, remote),
    metrics: () => compareMetrics(local, remote),
    tokens: () => compareTokens(local, remote),
    models: () => compareModels(local, remote),
    projects: () => compareProjects(local, remote),
  };

  const fn = compareFns[type];
  if (!fn) return new Response("Not found", { status: 404 });

  return Response.json(fn());
}

// ─── HTML Dashboard ─────────────────────────────────────────────────────────

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LO Telemetry Verification</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'IBM Plex Mono', 'SF Mono', 'Menlo', monospace;
    background: #0a0a0a;
    color: #e0e0e0;
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: #888;
    margin-bottom: 16px;
  }
  .health-bar {
    border: 1px dashed #333;
    padding: 12px 16px;
    margin-bottom: 20px;
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    font-size: 13px;
  }
  .health-item { display: flex; align-items: center; gap: 6px; }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    display: inline-block;
  }
  .dot.green { background: #50ff96; }
  .dot.red { background: #ff5050; }
  .dot.yellow { background: #ffc850; }
  .dim { color: #666; }
  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 0;
    border-bottom: 1px dashed #333;
  }
  .tab {
    padding: 8px 16px;
    cursor: pointer;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    border: 1px dashed #333;
    border-bottom: none;
    background: transparent;
    font-family: inherit;
  }
  .tab:hover { color: #aaa; }
  .tab.active {
    color: #e0e0e0;
    background: #141414;
    border-color: #555;
  }
  .panel {
    border: 1px dashed #333;
    border-top: none;
    padding: 16px;
    display: none;
  }
  .panel.active { display: block; }
  .comparison {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 16px;
  }
  .side {
    border: 1px dashed #282828;
    padding: 12px;
  }
  .side-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    margin-bottom: 10px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
    font-size: 12px;
    border-bottom: 1px solid #1a1a1a;
  }
  .row-key {
    color: #aaa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
  .row-val { color: #e0e0e0; }
  .row-val.match { color: #50ff96; }
  .row-val.warning { color: #ffc850; }
  .row-val.error { color: #ff5050; }
  .summary {
    font-size: 12px;
    padding: 10px 0;
    border-top: 1px dashed #333;
    display: flex;
    gap: 20px;
  }
  .s-match { color: #50ff96; }
  .s-warning { color: #ffc850; }
  .s-error { color: #ff5050; }
  .disc-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    margin: 12px 0 8px;
  }
  .disc-row {
    font-size: 12px;
    padding: 4px 0;
    border-bottom: 1px solid #1a1a1a;
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .badge.warning { background: #3d2e00; color: #ffc850; }
  .badge.error { background: #3d0000; color: #ff5050; }
  .refresh-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    color: #555;
    margin-bottom: 12px;
  }
  .refresh-btn {
    background: transparent;
    border: 1px dashed #444;
    color: #888;
    padding: 4px 12px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .refresh-btn:hover { color: #e0e0e0; border-color: #888; }
  .loading { color: #555; font-style: italic; padding: 20px; text-align: center; font-size: 12px; }
  @media (max-width: 700px) { .comparison { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<h1>LO Telemetry Verification</h1>

<div class="refresh-bar">
  <span id="refresh-status">Loading...</span>
  <button class="refresh-btn" onclick="refreshAll()">Refresh</button>
</div>

<div class="health-bar" id="health-bar">
  <div class="health-item">
    <span class="dot" id="daemon-dot"></span>
    <span>Daemon: <span id="daemon-status">...</span></span>
  </div>
  <div class="health-item">
    <span class="dot" id="supabase-dot"></span>
    <span>Supabase: <span id="supabase-status">...</span></span>
  </div>
  <div class="health-item dim">
    <span>Last sync: <span id="last-sync">...</span></span>
  </div>
</div>

<div class="tabs" id="tabs">
  <button class="tab active" data-tab="events">Events</button>
  <button class="tab" data-tab="metrics">Metrics</button>
  <button class="tab" data-tab="tokens">Tokens</button>
  <button class="tab" data-tab="models">Models</button>
  <button class="tab" data-tab="projects">Projects</button>
</div>

<div class="panel active" id="panel-events"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-metrics"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-tokens"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-models"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-projects"><p class="loading">Loading...</p></div>

<script>
const REFRESH_INTERVAL = 30000;
let refreshTimer = null;

document.getElementById('tabs').addEventListener('click', function(e) {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  tab.classList.add('active');
  document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
});

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildSide(title, data, remoteData, discMap, isRemote) {
  var source = isRemote ? remoteData : data;
  var side = el('div', 'side');
  side.appendChild(el('div', 'side-title', title));

  var keys = Object.keys(Object.assign({}, data, remoteData)).sort();
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = source[key] || 0;
    var disc = discMap[key];
    var row = el('div', 'row');
    var keyEl = el('span', 'row-key', key);
    keyEl.title = key;
    row.appendChild(keyEl);

    var cls = 'row-val';
    var suffix = '';
    if (isRemote) {
      if (disc) {
        cls += ' ' + disc.severity;
        suffix = disc.severity === 'error' ? ' \\u2717' : ' ~';
      } else {
        cls += ' match';
        suffix = ' \\u2713';
      }
    }
    row.appendChild(el('span', cls, formatNum(val) + suffix));
    side.appendChild(row);
  }
  return side;
}

function renderComparison(panel, result) {
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  var discMap = {};
  for (var i = 0; i < result.discrepancies.length; i++) {
    discMap[result.discrepancies[i].key] = result.discrepancies[i];
  }

  var grid = el('div', 'comparison');
  grid.appendChild(buildSide('LOCAL', result.local, result.remote, discMap, false));
  grid.appendChild(buildSide('SUPABASE', result.local, result.remote, discMap, true));
  panel.appendChild(grid);

  var summary = el('div', 'summary');
  summary.appendChild(el('span', 's-match', result.summary.matches + ' matches'));
  summary.appendChild(el('span', 's-warning', result.summary.warnings + ' warnings (<2%)'));
  summary.appendChild(el('span', 's-error', result.summary.errors + ' errors (>=2%)'));
  panel.appendChild(summary);

  if (result.discrepancies.length > 0) {
    panel.appendChild(el('div', 'disc-title', 'Discrepancies'));
    for (var j = 0; j < result.discrepancies.length; j++) {
      var d = result.discrepancies[j];
      var row = el('div', 'disc-row');
      row.appendChild(el('span', 'badge ' + d.severity, d.severity));
      row.appendChild(el('span', 'row-key', d.key));
      var detail = 'local: ' + formatNum(d.local) + ' / remote: ' + formatNum(d.remote) +
        ' (diff: ' + (d.diff > 0 ? '+' : '') + formatNum(d.diff) + ', ' + (d.pctDiff * 100).toFixed(1) + '%)';
      row.appendChild(el('span', '', detail));
      panel.appendChild(row);
    }
  }
}

function showError(panel, msg) {
  while (panel.firstChild) panel.removeChild(panel.firstChild);
  panel.appendChild(el('p', 'loading', 'Error: ' + msg));
}

function fetchPanel(type) {
  var panel = document.getElementById('panel-' + type);
  return fetch('/api/compare/' + type)
    .then(function(res) { return res.json(); })
    .then(function(data) { renderComparison(panel, data); })
    .catch(function(err) { showError(panel, err.message); });
}

function fetchHealth() {
  return fetch('/api/health')
    .then(function(res) { return res.json(); })
    .then(function(h) {
      var daemonDot = document.getElementById('daemon-dot');
      var daemonStatus = document.getElementById('daemon-status');
      daemonDot.className = 'dot ' + (h.daemon.running ? 'green' : 'red');
      daemonStatus.textContent = h.daemon.running ? 'running (PID ' + h.daemon.pid + ')' : 'stopped';

      var supaDot = document.getElementById('supabase-dot');
      var supaStatus = document.getElementById('supabase-status');
      supaDot.className = 'dot ' + (h.supabase.connected ? 'green' : 'red');
      supaStatus.textContent = h.supabase.connected ? 'connected (' + h.supabase.latencyMs + 'ms)' : 'disconnected';

      document.getElementById('last-sync').textContent = h.lastSyncAgo || 'never';
    })
    .catch(function() {
      document.getElementById('daemon-dot').className = 'dot yellow';
      document.getElementById('supabase-dot').className = 'dot yellow';
    });
}

function refreshAll() {
  var start = Date.now();
  document.getElementById('refresh-status').textContent = 'Refreshing...';

  Promise.all([
    fetchHealth(),
    fetchPanel('events'),
    fetchPanel('metrics'),
    fetchPanel('tokens'),
    fetchPanel('models'),
    fetchPanel('projects')
  ]).then(function() {
    var dur = Date.now() - start;
    document.getElementById('refresh-status').textContent =
      'Refreshed in ' + (dur / 1000).toFixed(1) + 's | Auto-refresh: ' + (REFRESH_INTERVAL / 1000) + 's';
  });
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_INTERVAL);
}

refreshAll();
startAutoRefresh();
</script>
</body>
</html>`;
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const reqUrl = new URL(req.url);
    const path = reqUrl.pathname;

    try {
      if (path === "/" || path === "/index.html") {
        return new Response(dashboardHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (path === "/api/health") {
        return await handleHealth();
      }

      const compareMatch = path.match(/^\/api\/compare\/(events|metrics|tokens|models|projects)$/);
      if (compareMatch) {
        return await handleCompare(compareMatch[1]);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Request error:", err);
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
});

console.log(`Dashboard running at http://localhost:${server.port}`);

// Open browser (macOS)
try {
  Bun.spawn(["open", `http://localhost:${server.port}`]);
} catch {}
