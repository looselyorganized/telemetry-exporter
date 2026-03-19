#!/usr/bin/env bun
/**
 * Telemetry Verification Dashboard
 *
 * Bun HTTP server that serves a self-contained HTML dashboard comparing
 * outbox data with what's stored in Supabase.
 *
 * Usage: bun run bin/dashboard.ts
 * Default port: 7777
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { readFromOutbox, readOutboxHealth, type OutboxData } from "../src/verify/outbox-reader";
import { readAllRemote, type RemoteData } from "../src/verify/remote-reader";
import {
  compareEvents,
  compareMetrics,
  compareTokens,
  compareModels,
  compareProjects,
  buildHealth,
  type LocalData,
} from "../src/verify/comparator";
import { loadEnv, PID_FILE, isProcessRunning } from "../src/cli-output";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "7777", 10);
const { url, key } = loadEnv();
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "telemetry.db");

// ─── Adapter: OutboxData → LocalData ────────────────────────────────────────
//
// The comparator expects LocalData shape. We map OutboxData fields to match.
// Fields not tracked by the outbox (metrics, models, hourDistribution) return
// empty stubs so comparisons gracefully show "no data" rather than crashing.

function outboxToLocalData(outbox: OutboxData): LocalData {
  // events: outbox has projId → count (flat); comparator expects byProjectDate
  // We store the flat count under a synthetic date key "__all__" so the
  // comparator collapses it back to a per-project total correctly.
  const byProjectDate: Record<string, Record<string, number>> = {};
  for (const [projId, count] of Object.entries(outbox.events)) {
    byProjectDate[projId] = { __all__: count };
  }

  // tokens: outbox has projId → number, matches LocalData.tokens.byProject
  const tokensByProject: Record<string, number> = { ...outbox.tokens };

  // projects: outbox has { id, slug }; LocalData.projects has { dirName, slug, projId }
  const projects = outbox.projects.map((p) => ({
    dirName: p.slug,
    slug: p.slug,
    projId: p.id,
  }));

  // daemon status from PID file (same as old reader)
  let daemon: LocalData["daemon"] = { running: false, pid: null };
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (!isNaN(pid)) {
        daemon = { running: isProcessRunning(pid), pid };
      }
    } catch {
      // leave as stopped
    }
  }

  return {
    events: { byProjectDate, totalCount: outbox.available ? Object.values(outbox.events).reduce((a, b) => a + b, 0) : 0 },
    metrics: { dailyActivity: [] },
    tokens: { byProject: tokensByProject },
    models: { stats: [] },
    projects,
    hourDistribution: {},
    daemon,
    logStartDate: null,
  };
}

// ─── Snapshot cache (coalesces concurrent requests) ─────────────────────────

let cachedSnapshot: { local: LocalData; outbox: OutboxData; remote: RemoteData; slugMap: Record<string, string>; ts: number } | null = null;
const CACHE_TTL = 5_000;

async function getSnapshot(): Promise<{ local: LocalData; outbox: OutboxData; remote: RemoteData; slugMap: Record<string, string> }> {
  if (cachedSnapshot && Date.now() - cachedSnapshot.ts < CACHE_TTL) {
    return cachedSnapshot;
  }

  const outbox = readFromOutbox(DB_PATH);
  const local = outboxToLocalData(outbox);
  const remote = await readAllRemote(supabase);

  // Build projId → slug lookup for dashboard display
  const slugMap: Record<string, string> = {};
  for (const proj of outbox.projects) {
    slugMap[proj.id] = proj.slug;
  }

  cachedSnapshot = { local, outbox, remote, slugMap, ts: Date.now() };
  return cachedSnapshot;
}

// ─── API handlers ───────────────────────────────────────────────────────────

async function handleHealth(): Promise<Response> {
  const { local, remote } = await getSnapshot();
  const health = buildHealth(local, remote);

  const { count, error: countError } = await supabase
    .from("exporter_errors")
    .select("*", { count: "exact", head: true });

  if (countError) return Response.json({ error: countError.message }, { status: 500 });

  // Add pipeline status from outbox health
  const outboxHealth = readOutboxHealth(DB_PATH);
  const oldestPending = (() => {
    if (!outboxHealth.failedRows.length && outboxHealth.depth.pending === 0) return null;
    // failedRows are sorted by id ascending; oldest is first
    return outboxHealth.failedRows[0]?.createdAt ?? null;
  })();

  const pipeline = {
    outboxDepth: outboxHealth.depth.pending,
    archiveDepth: outboxHealth.archive.pending,
    oldestPending,
  };

  return Response.json({ ...health, errorCount: count ?? 0, pipeline });
}

async function handleOutbox(): Promise<Response> {
  const health = readOutboxHealth(DB_PATH);
  return Response.json(health);
}

async function handleErrors(): Promise<Response> {
  const { data, error } = await supabase
    .from("exporter_errors")
    .select("*")
    .order("last_seen", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data ?? []);
}

async function handleCompare(type: string): Promise<Response> {
  const { local, remote, slugMap } = await getSnapshot();

  const compareFns: Record<string, () => ReturnType<typeof compareEvents>> = {
    events: () => compareEvents(local, remote),
    metrics: () => compareMetrics(local, remote),
    tokens: () => compareTokens(local, remote),
    models: () => compareModels(local, remote),
    projects: () => compareProjects(local, remote),
  };

  const fn = compareFns[type];
  if (!fn) return new Response("Not found", { status: 404 });

  return Response.json({ ...fn(), slugMap });
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
  .row-pct { color: #555; font-size: 11px; min-width: 50px; text-align: right; }
  .row-pct.match { color: #50ff96; }
  .row-pct.warning { color: #ffc850; }
  .row-pct.error { color: #ff5050; }
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
  .error-table { width: 100%; font-size: 12px; border-collapse: collapse; }
  .error-table th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    padding: 6px 8px;
    border-bottom: 1px dashed #333;
  }
  .error-table td { padding: 6px 8px; border-bottom: 1px solid #1a1a1a; }
  .error-table tr { cursor: pointer; }
  .error-table tr:hover { background: #1a1a1a; }
  .cat-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .cat-event_write { background: #3d2e00; color: #ffc850; }
  .cat-project_registration { background: #2e003d; color: #c850ff; }
  .cat-facility_state { background: #3d0000; color: #ff5050; }
  .cat-metrics_sync { background: #2e3d00; color: #c8ff50; }
  .cat-telemetry_sync { background: #003d3d; color: #50c8ff; }
  .cat-supabase_transient { background: #003d2e; color: #50ffc8; }
  .error-context {
    display: none;
    padding: 8px 12px;
    background: #111;
    border: 1px dashed #282828;
    font-size: 11px;
    white-space: pre-wrap;
    color: #aaa;
    margin: 4px 8px 8px;
  }
  .error-context.open { display: block; }
  .no-errors {
    color: #50ff96;
    padding: 24px;
    text-align: center;
    font-size: 13px;
  }
  .outbox-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 16px;
  }
  .outbox-card {
    border: 1px dashed #282828;
    padding: 12px;
  }
  .outbox-card-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #666;
    margin-bottom: 8px;
  }
  .outbox-stat {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    padding: 2px 0;
  }
  .outbox-stat-key { color: #888; }
  .outbox-stat-val { color: #e0e0e0; }
  .outbox-stat-val.zero { color: #444; }
  .outbox-stat-val.nonzero-fail { color: #ff5050; }
  .outbox-stat-val.nonzero-pend { color: #ffc850; }
  @media (max-width: 700px) { .comparison { grid-template-columns: 1fr; } .outbox-grid { grid-template-columns: 1fr; } }
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
  <div class="health-item">
    <span class="dot" id="pipeline-dot"></span>
    <span>Pipeline: <span id="pipeline-status">...</span></span>
  </div>
  <div class="health-item">
    <span class="dot" id="errors-dot"></span>
    <span>Errors: <span id="errors-status">...</span></span>
  </div>
  <div class="health-item dim">
    <span>Last sync: <span id="last-sync">...</span></span>
  </div>
</div>

<div class="tabs" id="tabs">
  <button class="tab active" data-tab="events">Events</button>
  <button class="tab" data-tab="metrics">Messages</button>
  <button class="tab" data-tab="tokens">Tokens</button>
  <button class="tab" data-tab="models">Models</button>
  <button class="tab" data-tab="projects">Projects</button>
  <button class="tab" data-tab="outbox">Outbox</button>
  <button class="tab" data-tab="errors">Errors</button>
</div>

<div class="panel active" id="panel-events"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-metrics"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-tokens"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-models"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-projects"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-outbox"><p class="loading">Loading...</p></div>
<div class="panel" id="panel-errors"><p class="loading">Loading...</p></div>

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

function displayKey(key, slugMap) {
  if (slugMap && slugMap[key]) return slugMap[key] + ' (' + key.slice(0, 13) + '\\u2026)';
  return key;
}

function buildSide(title, data, remoteData, discMap, isRemote, slugMap) {
  var source = isRemote ? remoteData : data;
  var side = el('div', 'side');
  side.appendChild(el('div', 'side-title', title));

  var keys = Object.keys(Object.assign({}, data, remoteData)).sort();
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = source[key] || 0;
    var disc = discMap[key];
    var row = el('div', 'row');
    var keyEl = el('span', 'row-key', displayKey(key, slugMap));
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

    if (isRemote) {
      var pctCls = 'row-pct';
      var pctText = '';
      if (disc) {
        pctCls += ' ' + disc.severity;
        pctText = (disc.pctDiff * 100).toFixed(1) + '%';
      } else {
        pctCls += ' match';
        pctText = '0%';
      }
      row.appendChild(el('span', pctCls, pctText));
    }

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

  var slugMap = result.slugMap || {};
  var grid = el('div', 'comparison');
  grid.appendChild(buildSide('OUTBOX', result.local, result.remote, discMap, false, slugMap));
  grid.appendChild(buildSide('SUPABASE', result.local, result.remote, discMap, true, slugMap));
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
      row.appendChild(el('span', 'row-key', displayKey(d.key, slugMap)));
      var detail = 'outbox: ' + formatNum(d.local) + ' / remote: ' + formatNum(d.remote) +
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

      var pipelineDot = document.getElementById('pipeline-dot');
      var pipelineStatus = document.getElementById('pipeline-status');
      if (h.pipeline) {
        var depth = h.pipeline.outboxDepth || 0;
        var archiveDepth = h.pipeline.archiveDepth || 0;
        if (depth === 0 && archiveDepth === 0) {
          pipelineDot.className = 'dot green';
          pipelineStatus.textContent = 'clear';
        } else {
          pipelineDot.className = 'dot yellow';
          pipelineStatus.textContent = depth + ' pending, ' + archiveDepth + ' archive';
        }
      } else {
        pipelineDot.className = 'dot yellow';
        pipelineStatus.textContent = 'no db';
      }

      var errorsDot = document.getElementById('errors-dot');
      var errorsStatus = document.getElementById('errors-status');
      errorsDot.className = 'dot ' + (h.errorCount > 0 ? 'red' : 'green');
      errorsStatus.textContent = h.errorCount > 0 ? String(h.errorCount) : 'none';

      document.getElementById('last-sync').textContent = h.lastSyncAgo || 'never';
    })
    .catch(function() {
      document.getElementById('daemon-dot').className = 'dot yellow';
      document.getElementById('supabase-dot').className = 'dot yellow';
      document.getElementById('pipeline-dot').className = 'dot yellow';
    });
}

function renderOutbox(panel, data) {
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  var grid = el('div', 'outbox-grid');

  // Depth card
  var depthCard = el('div', 'outbox-card');
  depthCard.appendChild(el('div', 'outbox-card-title', 'Outbox Depth'));
  [['Pending', data.depth.pending, 'nonzero-pend'], ['Shipped', data.depth.shipped, ''], ['Failed', data.depth.failed, 'nonzero-fail']].forEach(function(item) {
    var row = el('div', 'outbox-stat');
    row.appendChild(el('span', 'outbox-stat-key', item[0]));
    var val = item[1];
    var extraCls = val === 0 ? 'zero' : (item[2] || '');
    row.appendChild(el('span', 'outbox-stat-val ' + extraCls, formatNum(val)));
    depthCard.appendChild(row);
  });
  grid.appendChild(depthCard);

  // Archive card
  var archCard = el('div', 'outbox-card');
  archCard.appendChild(el('div', 'outbox-card-title', 'Archive Queue'));
  [['Pending', data.archive.pending, 'nonzero-pend'], ['Shipped', data.archive.shipped, '']].forEach(function(item) {
    var row = el('div', 'outbox-stat');
    row.appendChild(el('span', 'outbox-stat-key', item[0]));
    var val = item[1];
    var extraCls = val === 0 ? 'zero' : (item[2] || '');
    row.appendChild(el('span', 'outbox-stat-val ' + extraCls, formatNum(val)));
    archCard.appendChild(row);
  });
  grid.appendChild(archCard);

  // Cursors card
  var cursorCard = el('div', 'outbox-card');
  cursorCard.appendChild(el('div', 'outbox-card-title', 'Cursors'));
  var cursorKeys = Object.keys(data.cursors);
  if (cursorKeys.length === 0) {
    cursorCard.appendChild(el('div', 'outbox-stat-key', 'No cursors'));
  } else {
    cursorKeys.forEach(function(src) {
      var row = el('div', 'outbox-stat');
      row.appendChild(el('span', 'outbox-stat-key', src));
      row.appendChild(el('span', 'outbox-stat-val', formatNum(data.cursors[src].offset)));
      cursorCard.appendChild(row);
    });
  }
  grid.appendChild(cursorCard);

  panel.appendChild(grid);

  // Per-target breakdown
  var targets = Object.keys(data.byTarget).sort();
  if (targets.length > 0) {
    panel.appendChild(el('div', 'disc-title', 'By Target'));
    var tgrid = el('div', 'outbox-grid');
    targets.forEach(function(target) {
      var t = data.byTarget[target];
      var card = el('div', 'outbox-card');
      card.appendChild(el('div', 'outbox-card-title', target));
      [['Pending', t.pending, 'nonzero-pend'], ['Shipped', t.shipped, ''], ['Failed', t.failed, 'nonzero-fail']].forEach(function(item) {
        var row = el('div', 'outbox-stat');
        row.appendChild(el('span', 'outbox-stat-key', item[0]));
        var val = item[1];
        var extraCls = val === 0 ? 'zero' : (item[2] || '');
        row.appendChild(el('span', 'outbox-stat-val ' + extraCls, formatNum(val)));
        card.appendChild(row);
      });
      tgrid.appendChild(card);
    });
    panel.appendChild(tgrid);
  }

  // Failed rows
  if (data.failedRows && data.failedRows.length > 0) {
    panel.appendChild(el('div', 'disc-title', 'Failed Rows'));
    data.failedRows.forEach(function(row) {
      var rowEl = el('div', 'disc-row');
      rowEl.appendChild(el('span', 'badge error', 'failed'));
      rowEl.appendChild(el('span', 'row-key', '#' + row.id + ' ' + row.target));
      rowEl.appendChild(el('span', 'dim', row.error));
      panel.appendChild(rowEl);
    });
  }
}

function fetchOutbox() {
  var panel = document.getElementById('panel-outbox');
  return fetch('/api/outbox')
    .then(function(res) { return res.json(); })
    .then(function(data) { renderOutbox(panel, data); })
    .catch(function(err) { showError(panel, err.message); });
}

function renderErrors(panel, data) {
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  if (!data || data.length === 0) {
    panel.appendChild(el('div', 'no-errors', 'No active errors'));
    return;
  }

  var table = el('table', 'error-table');
  var thead = el('thead');
  var hrow = el('tr');
  ['Category', 'Message', 'Count', 'First Seen', 'Last Seen'].forEach(function(h) {
    hrow.appendChild(el('th', '', h));
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = el('tbody');
  for (var i = 0; i < data.length; i++) {
    var err = data[i];
    var row = el('tr');

    var catCell = el('td');
    var badge = el('span', 'cat-badge cat-' + err.category, err.category.replace('_', ' '));
    catCell.appendChild(badge);
    row.appendChild(catCell);

    row.appendChild(el('td', '', err.message));
    row.appendChild(el('td', '', String(err.count)));
    row.appendChild(el('td', 'dim', new Date(err.first_seen).toLocaleTimeString()));
    row.appendChild(el('td', '', new Date(err.last_seen).toLocaleTimeString()));

    var contextId = 'ctx-' + i;
    row.dataset.contextId = contextId;
    row.addEventListener('click', (function(cid) {
      return function() {
        var ctxEl = document.getElementById(cid);
        if (ctxEl) ctxEl.classList.toggle('open');
      };
    })(contextId));

    tbody.appendChild(row);

    if (err.sample_context) {
      var ctxRow = el('tr');
      var ctxCell = el('td');
      ctxCell.colSpan = 5;
      var ctxDiv = el('div', 'error-context');
      ctxDiv.id = contextId;
      ctxDiv.textContent = JSON.stringify(err.sample_context, null, 2);
      ctxCell.appendChild(ctxDiv);
      ctxRow.appendChild(ctxCell);
      tbody.appendChild(ctxRow);
    }
  }

  table.appendChild(tbody);
  panel.appendChild(table);
}

function fetchErrors() {
  var panel = document.getElementById('panel-errors');
  return fetch('/api/errors')
    .then(function(res) { return res.json(); })
    .then(function(data) { renderErrors(panel, data); })
    .catch(function(err) { showError(panel, err.message); });
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
    fetchPanel('projects'),
    fetchOutbox(),
    fetchErrors()
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

      if (path === "/api/outbox") {
        return await handleOutbox();
      }

      if (path === "/api/errors") {
        return await handleErrors();
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
