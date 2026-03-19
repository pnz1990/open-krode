// Self-contained browser UI bundle for open-krode
// Served as a single HTML page; communicates with the plugin via WebSocket.

export function getHtmlBundle(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>open-krode — kro explorer</title>
<style>
/* ── reset & tokens ─────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0d1117;
  --bg2: #161b22;
  --bg3: #21262d;
  --border: #30363d;
  --text: #e6edf3;
  --text2: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --purple: #bc8cff;
  --cyan: #39d353;
  --orange: #ffa657;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
}
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; }

/* ── layout ─────────────────────────────────────────────────────────── */
#app { display: grid; grid-template-rows: 48px 1fr; grid-template-columns: 280px 1fr; height: 100vh; }
#topbar { grid-column: 1 / -1; background: var(--bg2); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; padding: 0 16px; gap: 12px; }
#sidebar { background: var(--bg2); border-right: 1px solid var(--border); overflow-y: auto;
  display: flex; flex-direction: column; }
#main { overflow: hidden; display: flex; flex-direction: column; position: relative; }

/* ── topbar ─────────────────────────────────────────────────────────── */
.logo { font-weight: 700; font-size: 15px; letter-spacing: 0.5px; color: var(--accent); }
.logo span { color: var(--text2); font-weight: 400; }
.ctx-badge { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  padding: 3px 8px; font-size: 11px; color: var(--text2); white-space: nowrap; overflow: hidden;
  max-width: 360px; text-overflow: ellipsis; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text2); flex-shrink: 0; }
.status-dot.connected { background: var(--green); }
.ml-auto { margin-left: auto; }

/* ── sidebar ─────────────────────────────────────────────────────────── */
.sidebar-section { padding: 10px 12px 4px; font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text2); border-top: 1px solid var(--border); }
.sidebar-section:first-child { border-top: none; }
.view-item { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer;
  border-radius: 4px; margin: 1px 6px; transition: background 0.1s; overflow: hidden; }
.view-item:hover { background: var(--bg3); }
.view-item.active { background: var(--bg3); outline: 1px solid var(--border); }
.view-icon { font-size: 14px; flex-shrink: 0; }
.view-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.view-mode { font-size: 10px; color: var(--text2); flex-shrink: 0; margin-left: auto; }
.sidebar-empty { padding: 16px 12px; color: var(--text2); font-size: 12px; font-style: italic; }

/* ── main panels ─────────────────────────────────────────────────────── */
#view-container { flex: 1; overflow: hidden; position: relative; }
.panel { position: absolute; inset: 0; display: none; flex-direction: column; overflow: hidden; }
.panel.visible { display: flex; }

/* ── home panel ─────────────────────────────────────────────────────── */
#home-panel { padding: 24px; overflow-y: auto; }
.home-title { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.home-sub { color: var(--text2); margin-bottom: 24px; }
.rgd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.rgd-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px;
  cursor: pointer; transition: border-color 0.15s; }
.rgd-card:hover { border-color: var(--accent); }
.rgd-card-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.rgd-card-kind { font-size: 11px; color: var(--accent); margin-bottom: 8px; }
.rgd-card-meta { font-size: 11px; color: var(--text2); display: flex; gap: 12px; }
.rgd-card-condition { width: 8px; height: 8px; border-radius: 50%; }

/* ── dag panel ─────────────────────────────────────────────────────── */
#dag-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.dag-title { font-weight: 600; font-size: 13px; }
.dag-badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
.badge-root { background: #1f3a5f; color: var(--accent); }
.badge-resource { background: #1a3828; color: var(--green); }
.badge-state { background: #2d1f4f; color: var(--purple); }
.badge-cond { background: #3a2a0a; color: var(--yellow); }
.badge-foreach { background: #1f3050; color: var(--cyan); }
#dag-svg-wrap { flex: 1; overflow: auto; background: var(--bg); }
#dag-svg { display: block; }
#detail-panel { width: 340px; border-left: 1px solid var(--border); background: var(--bg2);
  display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0; }
#detail-panel.hidden { display: none; }
.detail-header { padding: 10px 12px; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px; }
.detail-close { margin-left: auto; cursor: pointer; color: var(--text2); font-size: 16px; }
.detail-close:hover { color: var(--text); }
.detail-body { flex: 1; overflow-y: auto; padding: 12px; }
.detail-section { margin-bottom: 14px; }
.detail-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--text2); margin-bottom: 6px; }
.cel-chip { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  padding: 4px 8px; font-family: monospace; font-size: 11px; color: var(--orange); margin-bottom: 4px;
  word-break: break-all; }
.dag-row { display: flex; }

/* ── instance panel ─────────────────────────────────────────────────── */
.instance-layout { display: flex; flex: 1; overflow: hidden; }
.instance-left { flex: 1; overflow-y: auto; padding: 16px; }
.instance-right { width: 320px; border-left: 1px solid var(--border); overflow-y: auto; padding: 12px; }
.section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--text2); margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.kv-grid { display: grid; grid-template-columns: 140px 1fr; gap: 2px 8px; font-size: 12px; }
.kv-key { color: var(--text2); font-family: monospace; }
.kv-val { color: var(--text); font-family: monospace; word-break: break-all; }
.condition-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.cond-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.cond-true { background: var(--green); }
.cond-false { background: var(--red); }
.cond-unknown { background: var(--text2); }
.cond-label { font-size: 12px; }
.cond-reason { font-size: 11px; color: var(--text2); }
.event-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
.event-row:last-child { border-bottom: none; }
.event-type { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
.event-normal { background: #1a3828; color: var(--green); }
.event-warning { background: #3a1a0a; color: var(--orange); }
.event-reason { font-size: 11px; color: var(--accent); margin: 3px 0 2px; font-family: monospace; }
.event-msg { font-size: 11px; color: var(--text); word-break: break-word; }
.event-meta { font-size: 10px; color: var(--text2); margin-top: 2px; }
.refresh-bar { display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  background: var(--bg2); border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text2); }
.pulse { animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ── yaml panel ─────────────────────────────────────────────────────── */
#yaml-panel { flex: 1; overflow: auto; }
.yaml-wrap { padding: 16px; font-family: monospace; font-size: 12px; line-height: 1.6;
  white-space: pre; color: var(--text); }
.yaml-key { color: var(--accent); }
.yaml-string { color: var(--green); }
.yaml-number { color: var(--orange); }
.yaml-bool { color: var(--purple); }
.yaml-null { color: var(--text2); }
.yaml-comment { color: var(--text2); font-style: italic; }

/* ── DAG node styles ─────────────────────────────────────────────────── */
.dag-node { cursor: pointer; }
.dag-node:hover rect { stroke-width: 2.5; }
.dag-edge { fill: none; stroke: var(--border); stroke-width: 1.5; }
.dag-edge.conditional { stroke-dasharray: 6 3; stroke: var(--yellow); }
.dag-edge.foreach { stroke: var(--cyan); }
.dag-edge.state { stroke: var(--purple); stroke-dasharray: 4 2; }
.dag-edge-label { fill: var(--text2); font-size: 9px; font-family: var(--font); }

/* ── empty state ─────────────────────────────────────────────────────── */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; color: var(--text2); gap: 8px; }
.empty-icon { font-size: 48px; opacity: 0.4; }
.empty-msg { font-size: 14px; }
.empty-sub { font-size: 12px; opacity: 0.7; }

/* ── misc ─────────────────────────────────────────────────────────────── */
.tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
.tag-root { background: #1f3a5f; color: var(--accent); }
.tag-resource { background: #1a3828; color: var(--green); }
.tag-state { background: #2d1f4f; color: var(--purple); }
pre { overflow-x: auto; }
</style>
</head>
<body>
<div id="app">
  <!-- TOPBAR -->
  <div id="topbar">
    <div class="logo">open-krode <span>/ kro explorer</span></div>
    <div class="ctx-badge" id="ctx-badge">connecting…</div>
    <div class="ml-auto" style="display:flex;align-items:center;gap:8px;">
      <span id="status-label" style="font-size:11px;color:var(--text2)">connecting</span>
      <div class="status-dot" id="status-dot"></div>
    </div>
  </div>

  <!-- SIDEBAR -->
  <div id="sidebar">
    <div class="sidebar-section">Views</div>
    <div id="view-list">
      <div class="sidebar-empty">No views open yet.<br>Ask the agent to explore an RGD.</div>
    </div>
  </div>

  <!-- MAIN -->
  <div id="main">
    <div id="view-container">
      <!-- HOME -->
      <div class="panel visible" id="home-panel">
        <div class="home-title">kro Resource Graph Definitions</div>
        <div class="home-sub">Ask the agent to explore an RGD or a live instance.</div>
        <div id="rgd-grid" class="rgd-grid"></div>
      </div>

      <!-- DAG VIEW -->
      <div class="panel" id="dag-panel">
        <div id="dag-toolbar">
          <span class="dag-title" id="dag-title">RGD Graph</span>
          <span class="dag-badge badge-root">root</span>
          <span class="dag-badge badge-resource">resource</span>
          <span class="dag-badge badge-state">specPatch</span>
          <span class="dag-badge badge-cond">includeWhen</span>
          <span class="dag-badge badge-foreach">forEach</span>
        </div>
        <div class="dag-row" style="flex:1;overflow:hidden;">
          <div id="dag-svg-wrap">
            <svg id="dag-svg" xmlns="http://www.w3.org/2000/svg"></svg>
          </div>
          <div id="detail-panel" class="hidden">
            <div class="detail-header">
              <span id="detail-title">Node</span>
              <span class="detail-close" id="detail-close">✕</span>
            </div>
            <div class="detail-body" id="detail-body"></div>
          </div>
        </div>
      </div>

      <!-- INSTANCE VIEW -->
      <div class="panel" id="instance-panel">
        <div class="refresh-bar">
          <span class="pulse" id="refresh-pulse">⟳</span>
          <span id="refresh-label">Watching…</span>
          <span style="margin-left:auto;" id="refresh-time"></span>
        </div>
        <div class="instance-layout">
          <div class="instance-left" id="instance-left"></div>
          <div class="instance-right" id="instance-right"></div>
        </div>
      </div>

      <!-- EVENTS VIEW -->
      <div class="panel" id="events-panel">
        <div style="padding:12px 16px;font-weight:600;border-bottom:1px solid var(--border);" id="events-title">Events</div>
        <div style="flex:1;overflow-y:auto;padding:12px 16px;" id="events-body"></div>
      </div>

      <!-- YAML VIEW -->
      <div class="panel" id="yaml-panel-wrap">
        <div style="padding:8px 12px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);" id="yaml-header"></div>
        <div id="yaml-panel"><div class="yaml-wrap" id="yaml-body"></div></div>
      </div>
    </div>
  </div>
</div>

<script>
// ════════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════════
const views = new Map();   // viewId → view
let activeViewId = null;
let ws = null;

// ════════════════════════════════════════════════════════════════════════
// WebSocket
// ════════════════════════════════════════════════════════════════════════
function connect() {
  const url = 'ws://' + location.host + '/ws';
  ws = new WebSocket(url);
  ws.onopen = () => {
    setStatus(true);
    ws.send(JSON.stringify({ type: 'connected' }));
  };
  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch {}
  };
}

function setStatus(connected) {
  document.getElementById('status-dot').className = 'status-dot' + (connected ? ' connected' : '');
  document.getElementById('status-label').textContent = connected ? 'connected' : 'reconnecting…';
}

function handleMessage(msg) {
  if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
  if (msg.type === 'view.open') {
    views.set(msg.view.id, msg.view);
    renderSidebar();
    if (!activeViewId) activateView(msg.view.id);
    renderActiveView();
  }
  if (msg.type === 'view.update') {
    const v = views.get(msg.viewId);
    if (v) { v.data = msg.data; }
    renderSidebar();
    if (activeViewId === msg.viewId) renderActiveView();
  }
  if (msg.type === 'view.close') {
    views.delete(msg.viewId);
    if (activeViewId === msg.viewId) {
      const remaining = [...views.keys()];
      activateView(remaining[0] || null);
    }
    renderSidebar();
    renderActiveView();
  }
}

// ════════════════════════════════════════════════════════════════════════
// Sidebar
// ════════════════════════════════════════════════════════════════════════
const MODE_ICONS = {
  'rgd-graph':       '⬡',
  'instance-graph':  '⚡',
  'instance-events': '📋',
  'instance-yaml':   '📄',
};
const MODE_LABELS = {
  'rgd-graph':       'graph',
  'instance-graph':  'live',
  'instance-events': 'events',
  'instance-yaml':   'yaml',
};

function renderSidebar() {
  const list = document.getElementById('view-list');
  if (views.size === 0) {
    list.innerHTML = '<div class="sidebar-empty">No views open yet.<br>Ask the agent to explore an RGD.</div>';
    return;
  }
  list.innerHTML = '';
  for (const [id, v] of views) {
    const el = document.createElement('div');
    el.className = 'view-item' + (id === activeViewId ? ' active' : '');
    el.innerHTML =
      '<span class="view-icon">' + (MODE_ICONS[v.mode] || '□') + '</span>' +
      '<span class="view-label">' + esc(shortTarget(v.target)) + '</span>' +
      '<span class="view-mode">' + (MODE_LABELS[v.mode] || v.mode) + '</span>';
    el.onclick = () => activateView(id);
    list.appendChild(el);
  }
}

function shortTarget(t) {
  if (t === '__home__') return 'Home';
  return t.split('/').pop() || t;
}

function activateView(id) {
  activeViewId = id;
  renderSidebar();
  renderActiveView();
}

// ════════════════════════════════════════════════════════════════════════
// View rendering dispatcher
// ════════════════════════════════════════════════════════════════════════
function hideAllPanels() {
  for (const el of document.querySelectorAll('.panel')) el.classList.remove('visible');
}

function renderActiveView() {
  hideAllPanels();
  if (!activeViewId) {
    document.getElementById('home-panel').classList.add('visible');
    return;
  }
  const v = views.get(activeViewId);
  if (!v) {
    document.getElementById('home-panel').classList.add('visible');
    return;
  }
  if (v.mode === 'rgd-graph' && v.target === '__home__') {
    renderHome(v.data);
    document.getElementById('home-panel').classList.add('visible');
    return;
  }
  if (v.mode === 'rgd-graph') {
    renderDag(v.data);
    document.getElementById('dag-panel').classList.add('visible');
    return;
  }
  if (v.mode === 'instance-graph') {
    renderInstance(v.data);
    document.getElementById('instance-panel').classList.add('visible');
    return;
  }
  if (v.mode === 'instance-events') {
    renderEvents(v.data);
    document.getElementById('events-panel').classList.add('visible');
    return;
  }
  if (v.mode === 'instance-yaml') {
    renderYaml(v.data);
    document.getElementById('yaml-panel-wrap').classList.add('visible');
    return;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Home view
// ════════════════════════════════════════════════════════════════════════
function renderHome(data) {
  if (data && data.currentContext) {
    document.getElementById('ctx-badge').textContent = data.currentContext;
  }
  const grid = document.getElementById('rgd-grid');
  const rgds = data && data.rgds || [];
  if (rgds.length === 0) {
    grid.innerHTML = '<div style="color:var(--text2);font-style:italic;">No RGDs found in cluster.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const r of rgds) {
    const healthy = r.conditions.some(c => c.type === 'Ready' && c.status === 'True');
    const card = document.createElement('div');
    card.className = 'rgd-card';
    card.innerHTML =
      '<div class="rgd-card-name">' + esc(r.name) + '</div>' +
      '<div class="rgd-card-kind">' + esc(r.kind) + ' <span style="color:var(--text2)">(' + esc(r.group) + ')</span></div>' +
      '<div class="rgd-card-meta">' +
        '<span>📦 ' + r.resourceCount + ' resources</span>' +
        '<span>⏱ ' + r.age + '</span>' +
        '<span class="rgd-card-condition" style="background:' + (healthy ? 'var(--green)' : 'var(--yellow)') + '"></span>' +
      '</div>';
    grid.appendChild(card);
  }
}

// ════════════════════════════════════════════════════════════════════════
// DAG view
// ════════════════════════════════════════════════════════════════════════
const NODE_W = 160;
const NODE_H = 40;
const H_GAP = 40;
const V_GAP = 60;

function renderDag(data) {
  if (!data || !data.graph) {
    document.getElementById('dag-svg').innerHTML = '';
    return;
  }
  const { graph, rgdName } = data;
  document.getElementById('dag-title').textContent = rgdName || 'RGD Graph';

  const { nodes, edges } = graph;

  // Layout: BFS rows
  const rowOf = {};
  const queue = [];
  const roots = nodes.filter(n => n.kind === 'root');
  for (const r of roots) { rowOf[r.id] = 0; queue.push(r.id); }
  
  const children = {};
  for (const e of edges) {
    if (!children[e.from]) children[e.from] = [];
    children[e.from].push(e.to);
  }
  
  const visited = new Set(roots.map(r => r.id));
  while (queue.length) {
    const id = queue.shift();
    const row = rowOf[id] || 0;
    for (const child of (children[id] || [])) {
      if (!visited.has(child)) {
        visited.add(child);
        rowOf[child] = row + 1;
        queue.push(child);
      }
    }
  }
  // any unvisited nodes go to row 1
  for (const n of nodes) if (rowOf[n.id] === undefined) rowOf[n.id] = 1;

  // Group by row
  const rows = {};
  for (const n of nodes) {
    const r = rowOf[n.id];
    if (!rows[r]) rows[r] = [];
    rows[r].push(n);
  }

  // Assign x/y
  const pos = {};
  const maxRow = Math.max(...Object.keys(rows).map(Number));
  const maxCols = Math.max(...Object.values(rows).map(a => a.length));
  const svgW = Math.max(maxCols * (NODE_W + H_GAP) + H_GAP, 600);
  const svgH = (maxRow + 1) * (NODE_H + V_GAP) + V_GAP;

  for (const [rowStr, rowNodes] of Object.entries(rows)) {
    const row = Number(rowStr);
    const colW = NODE_W + H_GAP;
    const totalW = rowNodes.length * colW - H_GAP;
    const startX = (svgW - totalW) / 2;
    rowNodes.forEach((n, i) => {
      pos[n.id] = {
        x: startX + i * colW,
        y: V_GAP / 2 + row * (NODE_H + V_GAP),
      };
    });
  }

  const svg = document.getElementById('dag-svg');
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);
  svg.setAttribute('viewBox', '0 0 ' + svgW + ' ' + svgH);
  svg.innerHTML = '';

  // Draw edges first
  const edgeGroup = svgEl('g');
  for (const e of edges) {
    const from = pos[e.from];
    const to = pos[e.to];
    if (!from || !to) continue;
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    const mid = (y1 + y2) / 2;
    const path = svgEl('path');
    path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + mid + ' ' + x2 + ',' + mid + ' ' + x2 + ',' + y2);
    let cls = 'dag-edge';
    if (e.label === 'specPatch') cls += ' state';
    else if (e.label === 'forEach') cls += ' foreach';
    else if (e.conditional) cls += ' conditional';
    path.setAttribute('class', cls);
    edgeGroup.appendChild(path);
    if (e.label && e.label !== 'specPatch') {
      const lx = (x1 + x2) / 2;
      const ly = mid - 4;
      const lbl = svgEl('text');
      lbl.setAttribute('x', lx); lbl.setAttribute('y', ly);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('class', 'dag-edge-label');
      lbl.textContent = e.label;
      edgeGroup.appendChild(lbl);
    }
  }
  svg.appendChild(edgeGroup);

  // Draw nodes
  const nodeGroup = svgEl('g');
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const g = svgEl('g');
    g.setAttribute('class', 'dag-node');
    g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    g.dataset.nodeId = n.id;

    const { fill, stroke, textColor } = nodeColors(n);
    const rect = svgEl('rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 6);
    rect.setAttribute('fill', fill);
    rect.setAttribute('stroke', stroke);
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);

    // Icon
    const icon = nodeIcon(n);
    const iconEl = svgEl('text');
    iconEl.setAttribute('x', 10);
    iconEl.setAttribute('y', NODE_H / 2 + 4);
    iconEl.setAttribute('font-size', '13');
    iconEl.textContent = icon;
    g.appendChild(iconEl);

    const label = svgEl('text');
    label.setAttribute('x', 26);
    label.setAttribute('y', NODE_H / 2 - 3);
    label.setAttribute('font-size', '11');
    label.setAttribute('font-family', 'monospace');
    label.setAttribute('fill', textColor);
    label.textContent = truncate(n.label, 16);
    g.appendChild(label);

    if (n.resourceKind && n.resourceKind !== n.label) {
      const sub = svgEl('text');
      sub.setAttribute('x', 26);
      sub.setAttribute('y', NODE_H / 2 + 10);
      sub.setAttribute('font-size', '9');
      sub.setAttribute('fill', '#8b949e');
      sub.textContent = truncate(n.resourceKind, 18);
      g.appendChild(sub);
    }

    // Badges
    let bx = NODE_W - 8;
    if (n.isConditional) {
      const b = badge('?', '#d29922', '#3a2a0a', bx - 14, 4);
      g.appendChild(b); bx -= 18;
    }
    if (n.isForEach) {
      const b = badge('∀', '#39d353', '#0d2416', bx - 14, 4);
      g.appendChild(b); bx -= 18;
    }

    g.addEventListener('click', () => showNodeDetail(n));
    nodeGroup.appendChild(g);
  }
  svg.appendChild(nodeGroup);
}

function nodeColors(n) {
  if (n.kind === 'root')     return { fill: '#0d2040', stroke: '#58a6ff', textColor: '#58a6ff' };
  if (n.isStateNode)          return { fill: '#1a0d33', stroke: '#bc8cff', textColor: '#bc8cff' };
  if (n.isConditional)        return { fill: '#1f1400', stroke: '#d29922', textColor: '#d29922' };
  if (n.isForEach)            return { fill: '#001a20', stroke: '#39d353', textColor: '#39d353' };
  return { fill: '#0d1f0d', stroke: '#3fb950', textColor: '#e6edf3' };
}
function nodeIcon(n) {
  if (n.kind === 'root') return '⬡';
  if (n.isStateNode) return '⟳';
  if (n.isForEach) return '∀';
  if (n.isConditional) return '?';
  return '▪';
}

function showNodeDetail(n) {
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');
  document.getElementById('detail-title').textContent = n.label;
  const body = document.getElementById('detail-body');
  const rows = [];
  rows.push(detailSection('Kind', n.kind + (n.resourceKind && n.resourceKind !== n.label ? ' → ' + n.resourceKind : '')));
  if (n.isConditional) rows.push(detailSection('includeWhen', 'conditional — only created when CEL is true'));
  if (n.isStateNode) rows.push(detailSection('Type', 'specPatch (state node)'));
  if (n.isForEach) rows.push(detailSection('Type', 'forEach fan-out'));
  if (n.readyWhen && n.readyWhen.length) {
    rows.push('<div class="detail-section"><div class="detail-section-title">readyWhen</div>' +
      n.readyWhen.map(e => '<div class="cel-chip">' + esc(e) + '</div>').join('') + '</div>');
  }
  if (n.celExpressions && n.celExpressions.length) {
    rows.push('<div class="detail-section"><div class="detail-section-title">CEL expressions</div>' +
      n.celExpressions.slice(0, 6).map(e => '<div class="cel-chip">' + esc(e.slice(0, 120)) + (e.length > 120 ? '…' : '') + '</div>').join('') + '</div>');
  }
  body.innerHTML = rows.join('');
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.add('hidden');
});

function detailSection(label, value) {
  return '<div class="detail-section"><div class="detail-section-title">' + esc(label) + '</div>' +
    '<div style="font-size:12px;color:var(--text)">' + esc(value) + '</div></div>';
}

// ════════════════════════════════════════════════════════════════════════
// Instance view
// ════════════════════════════════════════════════════════════════════════
function renderInstance(data) {
  if (!data || !data.instance) return;
  const { instance, events, rgd, lastRefresh } = data;

  document.getElementById('refresh-label').textContent =
    'Live — ' + (rgd ? rgd.kind + ' ' : '') + instance.namespace + '/' + instance.name;
  if (lastRefresh) {
    document.getElementById('refresh-time').textContent = 'updated ' + relTime(lastRefresh);
  }

  // Left: spec + status
  const left = document.getElementById('instance-left');
  const specEntries = flattenObj(instance.spec, '');
  const statusEntries = flattenObj(instance.status, '');
  const conditions = instance.status && instance.status.conditions ? instance.status.conditions : [];

  left.innerHTML =
    '<div class="section-title">Spec</div>' +
    renderKV(specEntries) +
    '<div class="section-title" style="margin-top:16px">Status</div>' +
    (conditions.length ? '<div style="margin-bottom:8px">' + conditions.map(c =>
      '<div class="condition-row">' +
        '<div class="cond-dot ' + condClass(c.status) + '"></div>' +
        '<span class="cond-label">' + esc(c.type) + '</span>' +
        (c.reason ? '<span class="cond-reason">(' + esc(c.reason) + ')</span>' : '') +
      '</div>'
    ).join('') + '</div>' : '') +
    renderKV(statusEntries);

  // Right: events
  const right = document.getElementById('instance-right');
  right.innerHTML = '<div class="section-title">Events (' + (events ? events.length : 0) + ')</div>';
  if (!events || events.length === 0) {
    right.innerHTML += '<div style="color:var(--text2);font-size:11px;font-style:italic;">No events</div>';
  } else {
    for (const ev of events.slice(0, 15)) {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML =
        '<span class="event-type ' + (ev.type === 'Warning' ? 'event-warning' : 'event-normal') + '">' + esc(ev.type) + '</span>' +
        '<div class="event-reason">' + esc(ev.reason) + '</div>' +
        '<div class="event-msg">' + esc(ev.message.slice(0, 140)) + '</div>' +
        '<div class="event-meta">×' + ev.count + ' — ' + relTime(ev.lastTime) + '</div>';
      right.appendChild(row);
    }
  }
}

function renderKV(entries) {
  if (!entries || entries.length === 0) return '<div style="color:var(--text2);font-size:11px;">empty</div>';
  return '<div class="kv-grid">' + entries.slice(0, 40).map(([k, v]) =>
    '<span class="kv-key">' + esc(k) + '</span><span class="kv-val">' + esc(String(v).slice(0, 80)) + '</span>'
  ).join('') + '</div>';
}

function condClass(s) {
  if (s === 'True') return 'cond-true';
  if (s === 'False') return 'cond-false';
  return 'cond-unknown';
}

function flattenObj(obj, prefix) {
  const result = [];
  if (!obj || typeof obj !== 'object') return result;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result.push(...flattenObj(v, key));
    } else {
      result.push([key, Array.isArray(v) ? JSON.stringify(v) : v]);
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// Events view
// ════════════════════════════════════════════════════════════════════════
function renderEvents(data) {
  if (!data) return;
  document.getElementById('events-title').textContent =
    'Events — ' + (data.namespace || '') + '/' + (data.name || '');
  const body = document.getElementById('events-body');
  const events = data.events || [];
  if (events.length === 0) {
    body.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-msg">No events found</div></div>';
    return;
  }
  body.innerHTML = '';
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML =
      '<span class="event-type ' + (ev.type === 'Warning' ? 'event-warning' : 'event-normal') + '">' + esc(ev.type) + '</span>' +
      '<div class="event-reason">' + esc(ev.reason) + '</div>' +
      '<div class="event-msg">' + esc(ev.message) + '</div>' +
      '<div class="event-meta">Count: ' + ev.count + ' — first: ' + relTime(ev.firstTime) + ' — last: ' + relTime(ev.lastTime) + '</div>';
    body.appendChild(row);
  }
}

// ════════════════════════════════════════════════════════════════════════
// YAML view
// ════════════════════════════════════════════════════════════════════════
function renderYaml(data) {
  if (!data) return;
  document.getElementById('yaml-header').textContent =
    (data.kind || '') + ' — ' + (data.namespace || '') + '/' + (data.name || '');
  document.getElementById('yaml-body').innerHTML = highlightYaml(data.rawYaml || '');
}

function highlightYaml(yaml) {
  return yaml.split('\\n').map(line => {
    const escaped = esc(line);
    // key: value lines
    const keyVal = escaped.match(/^(\\s*)(\\S+:)(\\s+)(.*)$/);
    if (keyVal) {
      const [, indent, key, sp, val] = keyVal;
      let valHtml = '<span class="yaml-string">' + val + '</span>';
      if (val === 'true' || val === 'false') valHtml = '<span class="yaml-bool">' + val + '</span>';
      else if (val === 'null' || val === '~') valHtml = '<span class="yaml-null">' + val + '</span>';
      else if (/^-?\\d+(\\.\\d+)?$/.test(val)) valHtml = '<span class="yaml-number">' + val + '</span>';
      else if (val === '') valHtml = '';
      return indent + '<span class="yaml-key">' + key + '</span>' + sp + valHtml;
    }
    if (escaped.trimStart().startsWith('#')) return '<span class="yaml-comment">' + escaped + '</span>';
    return escaped;
  }).join('\\n');
}

// ════════════════════════════════════════════════════════════════════════
// Utils
// ════════════════════════════════════════════════════════════════════════
function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function badge(text, color, bg, x, y) {
  const g = svgEl('g');
  const rect = svgEl('rect');
  rect.setAttribute('x', x - 2); rect.setAttribute('y', y);
  rect.setAttribute('width', 16); rect.setAttribute('height', 13);
  rect.setAttribute('rx', 3); rect.setAttribute('fill', bg);
  const t = svgEl('text');
  t.setAttribute('x', x + 6); t.setAttribute('y', y + 10);
  t.setAttribute('font-size', '9'); t.setAttribute('text-anchor', 'middle');
  t.setAttribute('fill', color); t.textContent = text;
  g.appendChild(rect); g.appendChild(t);
  return g;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// ════════════════════════════════════════════════════════════════════════
// Boot
// ════════════════════════════════════════════════════════════════════════
connect();
</script>
</body>
</html>`;
}
