// Self-contained browser UI bundle for open-krode
// Served as a single HTML page; communicates with the plugin via WebSocket.

import { BUILD_TIME } from "@/build-stamp";

const VERSION = "0.2.0";

// ─── kro concept definitions (defined in TS so they're safely JSON-serialised) ─
const KRO_CONCEPTS_DATA = {
  root: {
    title: "Root CR",
    what: "The single Custom Resource the user creates. kro watches it and reconciles all child resources whenever its spec changes.",
    how: "kro generates a CRD from the RGD schema. Users create instances of that CRD. Every field in spec.schema becomes a typed input.",
  },
  resource: {
    title: "Managed Resource",
    what: "A Kubernetes resource (ConfigMap, Deployment, CRD, etc.) that kro creates and owns on behalf of the root CR.",
    how: "Defined in spec.resources[].template. kro applies it, sets ownerReferences for GC, and re-reconciles when the root CR changes.",
  },
  includeWhen: {
    title: "includeWhen — Conditional Lifecycle",
    what: "A CEL expression that must be true for kro to create (and keep) this resource. When it becomes false, kro deletes the resource.",
    how: "Evaluated on every reconcile. Can reference schema.spec.*, schema.status.*, or kr.resources.<id>.status.* of sibling resources.",
    example: "includeWhen: [\"${schema.spec.difficulty == 'easy'}\"]",
  },
  readyWhen: {
    title: "readyWhen — Readiness Gate",
    what: "CEL expressions that must ALL be true before kro considers this resource Ready and unblocks downstream resources that depend on it.",
    how: "Until readyWhen is satisfied, kro marks the resource as pending and holds off on creating any resources that reference kr.resources.<id>.",
    example: "readyWhen: [\"${kr.resources.ns.status.phase == 'Active'}\"]\n=> wait for Namespace to be Active before creating Pods inside it",
  },
  forEach: {
    title: "forEach — Dynamic Fan-out",
    what: "Creates one copy of this resource for each item in a list. The list is a CEL expression evaluated at reconcile time.",
    how: "Each iteration exposes cel.item and cel.index. The resource is named with an index suffix. Perfect for creating N replicas from a spec field.",
    example: 'forEach:\n  in: "${schema.spec.regions}"\ntemplate:\n  metadata:\n    name: "${schema.metadata.name}-${cel.item}"',
  },
  external: {
    title: "External Reference",
    what: "A virtual resource with no template. Instead of creating a K8s resource, it writes computed values back into the root CR status using CEL.",
    how: 'state.fields defines a map of status field path to CEL expression. kro evaluates the CEL and patches the CR status. Enables state machines in pure YAML.',
    example: 'state:\n  fields:\n    "summary.readyCount": "${size(schema.status.replicas.filter(r, r.ready == true))}"\n=> counts ready replicas and writes to status',
  },
  cel: {
    title: "CEL — Common Expression Language",
    what: "The expression language used throughout kro for conditionals, computed values, and state writes. Runs inside ${...} blocks.",
    how: "kro extends standard CEL with: kr.resources.<id>.* for sibling access, cel.bind() for variable binding, random.seededInt() for RNG, cel.item/cel.index for forEach.",
    example: "${cel.bind(base, schema.spec.difficulty == 'hard' ? 800 : 400,\n  base * 125 / 100)}",
  },
};

export function getHtmlBundle(): string {
  // Safely serialise concept definitions so all quote/newline chars are escaped
  const KRO_CONCEPTS_JSON = JSON.stringify(KRO_CONCEPTS_DATA);

  const html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>open-krode — kro explorer</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<style>
/* ── reset & tokens ─────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:     #0d1117;
  --bg2:    #161b22;
  --bg3:    #21262d;
  --border: #30363d;
  --text:   #e6edf3;
  --text2:  #8b949e;
  --accent: #58a6ff;
  --green:  #3fb950;
  --red:    #f85149;
  --yellow: #d29922;
  --purple: #bc8cff;
  --cyan:   #39d353;
  --orange: #ffa657;
  --font:   -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
  /* live state colors */
  --alive:        #3fb950;
  --alive-bg:     #0d2010;
  --reconciling:  #58a6ff;
  --reconciling-bg: #0d1a30;
  --pending:      #d29922;
  --pending-bg:   #1f1600;
  --notfound:     #30363d;
  --notfound-bg:  #0d1117;
  --error:        #f85149;
  --error-bg:     #200d0d;
  --ok:           #2a6496;
  --ok-bg:        #0a1420;
  --meta:         #bc8cff;
  --meta-bg:      #1a0d33;
  --root:         #58a6ff;
  --root-bg:      #0d1f40;
  --external-node: #8b5cf6;  /* externalRef nodes */
  --state-bg:     #150d2a;
}
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; }

/* ── layout ─────────────────────────────────────────────────────────── */
#app { display: grid; grid-template-rows: 48px 1fr; grid-template-columns: 260px 1fr; height: 100vh; }
#topbar { grid-column: 1 / -1; background: var(--bg2); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; padding: 0 16px; gap: 12px; }
#sidebar { background: var(--bg2); border-right: 1px solid var(--border); overflow-y: auto;
  display: flex; flex-direction: column; }
#main { overflow: hidden; display: flex; flex-direction: column; position: relative; }

/* ── topbar ─────────────────────────────────────────────────────────── */
.logo { display: flex; align-items: center; gap: 8px; text-decoration: none; }
#topbar-logo { height: 28px; width: auto; display: block; flex-shrink: 0; }
.logo-text { font-weight: 700; font-size: 15px; letter-spacing: 0.5px; color: var(--accent); }
.logo-text span { color: var(--text2); font-weight: 400; }
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

/* ── dag panel ─────────────────────────────────────────────────────── */
#dag-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap;
  background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.dag-title { font-weight: 600; font-size: 13px; }
#dag-legend { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text2); }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.legend-dashed { width: 14px; height: 0; border-top: 2px dashed var(--notfound); flex-shrink: 0; }
#dag-wrap { display: flex; flex: 1; overflow: hidden; }
#dag-svg-wrap { flex: 1; overflow: auto; background: var(--bg); }
#dag-svg { display: block; }

/* ── detail panel (right side of DAG) ───────────────────────────────── */
#detail-panel { width: 380px; border-left: 1px solid var(--border); background: var(--bg2);
  display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0; transition: width 0.2s; }
#detail-panel.hidden { display: none; }
.detail-header { padding: 10px 12px; font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.detail-close { margin-left: auto; cursor: pointer; color: var(--text2); font-size: 16px; line-height: 1; }
.detail-close:hover { color: var(--text); }
.detail-body { flex: 1; overflow-y: auto; padding: 12px; }
.detail-section { margin-bottom: 14px; }
.detail-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--text2); margin-bottom: 6px; }
.cel-chip { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  padding: 5px 8px; font-family: monospace; font-size: 11px; color: var(--orange); margin-bottom: 4px;
  word-break: break-all; cursor: pointer; transition: border-color 0.1s; }
.cel-chip:hover { border-color: var(--orange); }
.kubectl-cmd { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  padding: 6px 10px; font-family: monospace; font-size: 11px; color: var(--accent); margin-bottom: 10px;
  word-break: break-all; cursor: pointer; }
.kubectl-cmd:hover { border-color: var(--accent); }
.yaml-inspect { font-family: monospace; font-size: 11px; line-height: 1.6; white-space: pre;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 10px; overflow-x: auto; }
.inspect-loading { color: var(--text2); font-size: 12px; font-style: italic; padding: 8px 0; }

/* ── live state tags ─────────────────────────────────────────────────── */
.state-tag { font-size: 10px; padding: 2px 7px; border-radius: 10px; font-weight: 600; display: inline-block; }
.state-alive        { background: var(--alive-bg);       color: var(--alive); }
.state-reconciling  { background: var(--reconciling-bg); color: var(--reconciling); }
.state-pending      { background: var(--pending-bg);     color: var(--pending); }
.state-not-found    { background: var(--notfound-bg);    color: var(--notfound); }
.state-error        { background: var(--error-bg);       color: var(--error); }
.state-ok           { background: var(--ok-bg);          color: var(--ok); }
.state-meta         { background: var(--meta-bg);        color: var(--meta); }
.state-unknown      { background: var(--bg3);            color: var(--text2); }

/* ── tag strip ───────────────────────────────────────────────────────── */
.tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; display: inline-block; }
.tag-root     { background: var(--root-bg);    color: var(--root); }
.tag-resource { background: var(--alive-bg);   color: var(--alive); }
.tag-state    { background: var(--state-bg);   color: var(--external-node); }
.tag-cond     { background: var(--pending-bg); color: var(--pending); }
.tag-foreach  { background: #001a20;           color: var(--cyan); }

/* ── reconciling banner ──────────────────────────────────────────────── */
@keyframes kro-blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
.reconciling-banner { display: flex; align-items: center; gap: 8px; padding: 6px 14px;
  background: #0d1a30; border-bottom: 1px solid var(--reconciling);
  font-size: 11px; color: var(--reconciling); flex-shrink: 0; }
.reconciling-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--reconciling);
  animation: kro-blink 0.8s step-end infinite; }

/* ── pulse animation (SVG nodes use this class on their glow rect) ──── */
@keyframes kro-pulse { 0%,100%{opacity:0.15} 50%{opacity:0.55} }

/* ── instance panel ─────────────────────────────────────────────────── */
#instance-panel { overflow: hidden; }
.instance-dag-wrap { flex-shrink: 0; border-bottom: 1px solid var(--border);
  overflow-x: auto; background: var(--bg); max-height: 360px; }
.instance-body { display: flex; flex: 1; overflow: hidden; }
.instance-left { flex: 1; overflow-y: auto; padding: 14px 16px; }
.instance-right { width: 300px; border-left: 1px solid var(--border); overflow-y: auto; padding: 12px; }

/* ── instance detail panel (YAML side panel in live view) ──────────── */
#instance-detail-panel { width: 380px; border-left: 1px solid var(--border); background: var(--bg2);
  display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0; transition: width 0.2s; }
#instance-detail-panel.hidden { display: none; }
/* instance-dag-body: fixed height DAG strip + optional side panel, above the spec/conditions area */
#instance-dag-body { display: flex; flex-shrink: 0; overflow: hidden;
  height: 340px; border-bottom: 1px solid var(--border); }
#instance-dag-wrap { flex: 1; overflow-x: auto; overflow-y: hidden; background: var(--bg); }
.section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--text2); margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
.kv-grid { display: grid; grid-template-columns: 140px 1fr; gap: 2px 8px; font-size: 12px; margin-bottom: 6px; }
.kv-key { color: var(--text2); font-family: monospace; }
.kv-val { color: var(--text); font-family: monospace; word-break: break-all; }
.condition-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.cond-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.cond-true    { background: var(--green); }
.cond-false   { background: var(--red); }
.cond-unknown { background: var(--text2); }
.cond-label  { font-size: 12px; }
.cond-reason { font-size: 11px; color: var(--text2); }
.event-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
.event-row:last-child { border-bottom: none; }
.event-type { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
.event-normal  { background: #1a3828; color: var(--green); }
.event-warning { background: #3a1a0a; color: var(--orange); }
.event-reason { font-size: 11px; color: var(--accent); margin: 3px 0 2px; font-family: monospace; }
.event-msg  { font-size: 11px; color: var(--text); word-break: break-word; }
.event-meta { font-size: 10px; color: var(--text2); margin-top: 2px; }
.refresh-bar { display: flex; align-items: center; gap: 6px; padding: 5px 12px;
  background: var(--bg2); border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text2);
  flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; animation: spin 1s linear infinite; }

/* ── child resource rows ─────────────────────────────────────────────── */
.child-resource-row { display: flex; align-items: center; gap: 8px; padding: 4px 0;
  border-bottom: 1px solid var(--border); }
.child-resource-row:last-child { border-bottom: none; }
.child-kind-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: var(--bg3); color: var(--accent); font-family: monospace; flex-shrink: 0; }
.child-name { font-size: 11px; font-family: monospace; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.child-status { font-size: 10px; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
.csr-ready   { background: var(--alive-bg);  color: var(--alive); }
.csr-unknown { background: var(--bg3);       color: var(--text2); }
.csr-other   { background: #3a1a0a;          color: var(--orange); }

/* ── events panel ───────────────────────────────────────────────────── */
#events-panel { overflow: hidden; }
#events-body { flex: 1; overflow-y: auto; padding: 12px 16px; }

/* ── yaml panel ─────────────────────────────────────────────────────── */
#yaml-panel { flex: 1; overflow: auto; }
.yaml-wrap { padding: 16px; font-family: monospace; font-size: 12px; line-height: 1.6;
  white-space: pre; color: var(--text); }
.yaml-key    { color: var(--accent); }
.yaml-string { color: var(--green); }
.yaml-number { color: var(--orange); }
.yaml-bool   { color: var(--purple); }
.yaml-null   { color: var(--text2); }
.yaml-comment{ color: var(--text2); font-style: italic; }

/* ── DAG SVG node/edge styles ────────────────────────────────────────── */
.dag-node { cursor: pointer; }
.dag-node:hover .node-bg { stroke-width: 2.5 !important; }
.dag-edge { fill: none; stroke-width: 1.5; }

/* ── empty state ─────────────────────────────────────────────────────── */
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; color: var(--text2); gap: 8px; }
.empty-icon { font-size: 48px; opacity: 0.4; }
.empty-msg { font-size: 14px; }
.empty-sub  { font-size: 12px; opacity: 0.7; }

/* ── concept box (node detail panel) ─────────────────────────────────── */
.concept-box { background: #0d1a0d; border: 1px solid #1a3a1a; border-radius: 6px;
  padding: 10px 12px; margin: 8px 0; }
.concept-title { font-size: 11px; font-weight: 700; color: var(--green); margin-bottom: 5px;
  text-transform: uppercase; letter-spacing: 0.04em; }
.concept-what { font-size: 12px; color: var(--text); line-height: 1.5; margin-bottom: 5px; }
.concept-how { font-size: 11px; color: var(--text2); line-height: 1.4; margin-bottom: 5px; }
.concept-example { font-size: 10px; font-family: monospace; background: var(--bg3);
  border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px;
  color: var(--orange); white-space: pre-wrap; word-break: break-all; margin-top: 4px; }

/* ── state field rows ─────────────────────────────────────────────────── */
.state-field-row { margin-bottom: 6px; }
.state-field-key { display: block; font-family: monospace; font-size: 10px;
  color: var(--purple); margin-bottom: 2px; }

/* ── cel chip enhancements ────────────────────────────────────────────── */
.cel-copy { float: right; color: var(--text2); font-size: 10px; opacity: 0.5; }
.cel-chip:hover .cel-copy { opacity: 1; }

/* ── clickable cards & buttons ───────────────────────────────────────── */
.rgd-card { cursor: pointer; }
.rgd-card-actions { display: flex; gap: 6px; margin-top: 10px; }
.card-btn { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px;
  padding: 3px 8px; font-size: 11px; color: var(--text2); cursor: pointer; transition: all 0.1s; }
.card-btn:hover { border-color: var(--accent); color: var(--accent); }
.card-btn-live { border-color: var(--alive); color: var(--alive); }
.card-btn-live:hover { background: var(--alive-bg); }

/* ── view close button ───────────────────────────────────────────────── */
.view-close { margin-left: 4px; color: var(--text2); font-size: 11px; opacity: 0;
  padding: 0 3px; border-radius: 3px; flex-shrink: 0; }
.view-item:hover .view-close { opacity: 1; }
.view-close:hover { color: var(--red) !important; opacity: 1 !important; }

/* ── instance picker overlay ─────────────────────────────────────────── */
#instance-picker-overlay { display: none; position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.7); align-items: center; justify-content: center; }
.picker-modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
  width: 560px; max-height: 480px; display: flex; flex-direction: column; overflow: hidden; }
.picker-header { display: flex; align-items: center; padding: 12px 16px;
  border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13px; }
.picker-header .detail-close { margin-left: auto; cursor: pointer; font-size: 16px; color: var(--text2); }
.picker-header .detail-close:hover { color: var(--text); }
#picker-list { overflow-y: auto; padding: 8px; }
.picker-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; }
.picker-row:hover { background: var(--bg3); }

/* ── deep instance panel ─────────────────────────────────────────────── */
#deep-panel { overflow: hidden; }
.deep-header { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.deep-title { font-weight: 600; font-size: 13px; flex: 1; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.deep-body { display: flex; flex: 1; overflow: hidden; }
.deep-graph-wrap { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
#deep-info-panel { width: 340px; border-left: 1px solid var(--border); background: var(--bg2);
  display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0; }
#deep-info-panel.hidden { display: none; }
</style>
</head>
<body>
<div id="app">
  <!-- TOPBAR -->
  <div id="topbar">
    <div class="logo"><img src="/logo.png" alt="open-krode" id="topbar-logo" /><span class="logo-text">open-krode <span>/ kro explorer</span></span></div>
    <div class="ctx-badge" id="ctx-badge">connecting…</div>
    <div style="font-size:10px;color:var(--text2);white-space:nowrap;flex-shrink:0">__VERSION_STAMP__</div>
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
          <div id="dag-reconciling" style="display:none" class="reconciling-banner">
            <div class="reconciling-dot"></div><span>reconciling</span>
          </div>
          <div style="flex:1"></div>
          <div id="dag-legend">
            <span class="legend-item" title="Root CR: the single Custom Resource a user creates. kro watches it and reconciles all child resources whenever its spec changes."><span class="legend-dot" style="background:var(--root)"></span>root CR</span>
            <span class="legend-item" title="Alive: resource exists and is Ready=True"><span class="legend-dot" style="background:var(--alive)"></span>alive</span>
            <span class="legend-item" title="Reconciling: kro is actively updating this resource right now"><span class="legend-dot" style="background:var(--reconciling)"></span>reconciling</span>
            <span class="legend-item" title="Pending: resource exists but readyWhen conditions are not yet satisfied — downstream resources are blocked"><span class="legend-dot" style="background:var(--pending)"></span>pending</span>
            <span class="legend-item" title="Locked / not-found: resource has not been created yet (includeWhen=false, or not yet reached in reconcile order)"><span class="legend-dashed"></span>locked</span>
            <span class="legend-item" title="externalRef: references an existing resource not managed by this RGD"><span class="legend-dot" style="background:var(--external-node)"></span>externalRef</span>
            <span class="legend-item" title="forEach: creates one copy of this resource for each item in a CEL list expression, named with an index suffix"><span class="legend-dot" style="background:var(--cyan)"></span>forEach</span>
            <span class="legend-item" title="includeWhen: conditional resource — kro only creates (and keeps) this resource while its CEL expression evaluates to true; deletes it when false"><span class="legend-dot" style="background:var(--yellow)"></span>includeWhen</span>
            <span class="legend-item" title="Error: resource reconciliation failed (Ready=False with error condition)"><span class="legend-dot" style="background:var(--error)"></span>error</span>
          </div>
        </div>
        <div id="dag-wrap">
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
          <span class="spin" id="refresh-spin" style="display:none">⟳</span>
          <span id="refresh-label">Watching…</span>
          <span style="margin-left:auto;font-size:10px;" id="refresh-time"></span>
        </div>
        <div id="instance-reconciling" class="reconciling-banner" style="display:none">
          <div class="reconciling-dot"></div>
          <span>kro is reconciling this instance</span>
          <span style="margin-left:auto;font-size:10px;opacity:0.7">nodes pulsing = actively updating</span>
        </div>
        <!-- DAG + side detail panel, side by side -->
        <div id="instance-dag-body">
          <div id="instance-dag-wrap">
            <svg id="instance-dag-svg" xmlns="http://www.w3.org/2000/svg" style="display:block"></svg>
          </div>
          <div id="instance-detail-panel" class="hidden">
            <div class="detail-header">
              <span id="instance-detail-title">Node</span>
              <span class="detail-close" id="instance-detail-close">✕</span>
            </div>
            <div class="detail-body" id="instance-detail-body"></div>
          </div>
        </div>
        <div class="instance-body">
          <div class="instance-left" id="instance-left"></div>
          <div class="instance-right" id="instance-right"></div>
        </div>
      </div>

      <!-- EVENTS VIEW -->
      <div class="panel" id="events-panel">
        <div style="padding:10px 16px;font-weight:600;font-size:13px;border-bottom:1px solid var(--border);flex-shrink:0" id="events-title">Events</div>
        <div id="events-body"></div>
      </div>

      <!-- YAML VIEW -->
      <div class="panel" id="yaml-panel-wrap">
        <div style="padding:8px 12px;font-size:11px;color:var(--text2);border-bottom:1px solid var(--border);flex-shrink:0" id="yaml-header"></div>
        <div id="yaml-panel"><div class="yaml-wrap" id="yaml-body"></div></div>
      </div>

      <!-- DEEP INSTANCE VIEW -->
      <div class="panel" id="deep-panel">
        <div class="deep-header">
          <span class="deep-title" id="deep-title">Deep Instance</span>
          <span id="deep-refresh-label" style="font-size:11px;color:var(--text2);margin-left:8px"></span>
        </div>
        <div class="deep-body">
          <div class="deep-graph-wrap" id="deep-graph-wrap">
            <div class="empty-state"><div class="empty-icon">🔭</div><div class="empty-msg">Loading…</div></div>
          </div>
          <div id="deep-info-panel" class="hidden">
            <div class="detail-header">
              <span id="deep-info-title" style="font-size:12px;font-weight:600">Node</span>
              <span class="detail-close" id="deep-info-close">✕</span>
            </div>
            <div class="detail-body" id="deep-info-body"></div>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- INSTANCE PICKER OVERLAY -->
<div id="instance-picker-overlay">
  <div class="picker-modal">
    <div class="picker-header">
      <span id="picker-title">Instances</span>
      <span class="detail-close" onclick="document.getElementById('instance-picker-overlay').style.display='none'">✕</span>
    </div>
    <div id="picker-list"></div>
  </div>
</div>

<script>
// ════════════════════════════════════════════════════════════════════════
// State
// ════════════════════════════════════════════════════════════════════════
const views = new Map();
let activeViewId = null;
let ws = null;
// Current view+node for which we're waiting for a node.yaml response
let pendingInspect = null;
// Pulse animation frame ticker
let pulseFrame = 0;
let pulseTimer = null;

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
    try { handleMessage(JSON.parse(e.data)); } catch(err) { console.error('WS parse error', err); }
  };
}

function viewRequest(action, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'view.request', action, payload: payload || {} }));
  }
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
    activateView(msg.view.id);
    return;
  }
  if (msg.type === 'view.update') {
    const v = views.get(msg.viewId);
    if (v) { v.data = msg.data; }
    renderSidebar();
    if (activeViewId === msg.viewId) renderActiveView();
    return;
  }
  if (msg.type === 'view.close') {
    views.delete(msg.viewId);
    if (activeViewId === msg.viewId) {
      const remaining = [...views.keys()];
      activateView(remaining[remaining.length - 1] || null);
    } else {
      renderSidebar();
      renderActiveView();
    }
    return;
  }
  if (msg.type === 'node.yaml') {
    handleNodeYaml(msg);
    return;
  }
  if (msg.type === 'instances.list') {
    handleInstancesList(msg);
    return;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Pulse ticker (for reconciling animation)
// ════════════════════════════════════════════════════════════════════════
function startPulse() {
  if (pulseTimer) return;
  pulseTimer = setInterval(() => {
    pulseFrame = (pulseFrame + 1) % 60;
    // Re-render pulse rects in all visible SVGs
    updatePulseRects();
  }, 100);
}
function stopPulse() {
  if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
}
function updatePulseRects() {
  const opacity = 0.15 + Math.abs(Math.sin(pulseFrame * Math.PI / 30)) * 0.45;
  for (const el of document.querySelectorAll('.pulse-rect')) {
    el.setAttribute('opacity', opacity);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Sidebar
// ════════════════════════════════════════════════════════════════════════
const MODE_ICONS = {
  'rgd-graph':       '⬡',
  'instance-graph':  '⚡',
  'deep-instance':   '🔭',
  'instance-events': '📋',
  'instance-yaml':   '📄',
};
const MODE_LABELS = {
  'rgd-graph':       'graph',
  'instance-graph':  'live',
  'deep-instance':   'deep',
  'instance-events': 'events',
  'instance-yaml':   'yaml',
};

function renderSidebar() {
  const list = document.getElementById('view-list');
  if (views.size === 0) {
    list.innerHTML = '<div class="sidebar-empty">No views open yet.<br>Ask the agent or click an RGD card.</div>';
    return;
  }
  list.innerHTML = '';
  for (const [id, v] of views) {
    const el = document.createElement('div');
    el.className = 'view-item' + (id === activeViewId ? ' active' : '');
    el.innerHTML =
      '<span class="view-icon">' + (MODE_ICONS[v.mode] || '□') + '</span>' +
      '<span class="view-label">' + esc(shortTarget(v.target)) + '</span>' +
      '<span class="view-mode">' + (MODE_LABELS[v.mode] || v.mode) + '</span>' +
      '<span class="view-close" title="Close">✕</span>';
    el.querySelector('.view-label').onclick = (e) => { e.stopPropagation(); activateView(id); };
    el.querySelector('.view-icon').onclick = (e) => { e.stopPropagation(); activateView(id); };
    el.querySelector('.view-mode').onclick = (e) => { e.stopPropagation(); activateView(id); };
    el.onclick = () => activateView(id);
    el.querySelector('.view-close').onclick = (e) => { e.stopPropagation(); closeView(id); };
    list.appendChild(el);
  }
}

function closeView(id) {
  viewRequest('close-view', { viewId: id });
}

function shortTarget(t) {
  if (t === '__home__') return 'Home';
  return t.split('/').pop() || t;
}

function activateView(id) {
  activeViewId = id;
  // Close the detail panel when switching views so stale data isn't shown
  document.getElementById('detail-panel').classList.add('hidden');
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
    renderDagView(v.data, 'dag-svg', false);
    document.getElementById('dag-panel').classList.add('visible');
    // Show/hide reconciling banner
    const recBanner = document.getElementById('dag-reconciling');
    recBanner.style.display = v.data.reconciling ? 'flex' : 'none';
    return;
  }
  if (v.mode === 'instance-graph') {
    renderInstance(v.data);
    document.getElementById('instance-panel').classList.add('visible');
    return;
  }
  if (v.mode === 'deep-instance') {
    renderDeepInstance(v.data);
    document.getElementById('deep-panel').classList.add('visible');
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
  const rgds = (data && data.rgds) || [];
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
        '<span style="width:8px;height:8px;border-radius:50%;background:' + (healthy ? 'var(--green)' : 'var(--yellow)') + ';display:inline-block"></span>' +
      '</div>' +
      '<div class="rgd-card-actions">' +
        '<button class="card-btn" data-action="graph" title="View RGD graph">⬡ Graph</button>' +
        '<button class="card-btn card-btn-live" data-action="instances" title="Browse live instances">⚡ Instances</button>' +
      '</div>';
    card.querySelector('[data-action="graph"]').onclick = (e) => {
      e.stopPropagation();
      viewRequest('open-rgd-graph', { rgdName: r.name });
    };
    card.querySelector('[data-action="instances"]').onclick = (e) => {
      e.stopPropagation();
      showInstancePicker(r.name);
    };
    grid.appendChild(card);
  }
}

// ─── Instance picker ─────────────────────────────────────────────────────────
let instancePickerRgd = null;

function showInstancePicker(rgdName) {
  instancePickerRgd = rgdName;
  const overlay = document.getElementById('instance-picker-overlay');
  const title = document.getElementById('picker-title');
  const list = document.getElementById('picker-list');
  title.textContent = 'Instances of ' + rgdName;
  list.innerHTML = '<div style="color:var(--text2);font-style:italic;padding:8px">Loading…</div>';
  overlay.style.display = 'flex';
  // request from server
  viewRequest('list-instances', { rgdName, viewId: activeViewId || '' });
}

function handleInstancesList(msg) {
  if (!document.getElementById('instance-picker-overlay').style.display.includes('flex')) return;
  const list = document.getElementById('picker-list');
  const instances = msg.instances || [];
  if (instances.length === 0) {
    list.innerHTML = '<div style="color:var(--text2);font-style:italic;padding:8px">No instances found.</div>';
    return;
  }
  list.innerHTML = '';
  for (const inst of instances) {
    const row = document.createElement('div');
    row.className = 'picker-row';
    const ready = inst.conditions.find(c => c.type === 'Ready');
    const stateColor = ready?.status === 'True' ? 'var(--alive)' : ready?.status === 'False' ? 'var(--error)' : 'var(--text2)';
    row.innerHTML =
      '<span style="width:8px;height:8px;border-radius:50%;background:' + stateColor + ';flex-shrink:0;display:inline-block"></span>' +
      '<span style="font-family:monospace;font-size:12px;flex:1">' + esc(inst.namespace + '/' + inst.name) + '</span>' +
      '<span style="font-size:10px;color:var(--text2)">' + esc(inst.age) + '</span>' +
      '<button class="card-btn card-btn-live" style="margin-left:6px" title="Deep multi-level resource tree (one-shot)">🔭 Deep</button>' +
      '<button class="card-btn" style="margin-left:4px" title="Live view with 5s auto-refresh + events">⚡ Live</button>';
    row.querySelector('.card-btn-live').onclick = () => {
      document.getElementById('instance-picker-overlay').style.display = 'none';
      viewRequest('open-deep-instance', { rgdName: msg.rgdName, namespace: inst.namespace, name: inst.name });
    };
    row.querySelectorAll('.card-btn')[1].onclick = () => {
      document.getElementById('instance-picker-overlay').style.display = 'none';
      viewRequest('open-live-instance', { rgdName: msg.rgdName, namespace: inst.namespace, name: inst.name });
    };
    list.appendChild(row);
  }
}

// ════════════════════════════════════════════════════════════════════════
// DAG layout & rendering
// ════════════════════════════════════════════════════════════════════════
const NODE_W = 124;
const NODE_H = 44;
const H_GAP  = 28;   // gap between nodes in same row
const V_GAP  = 72;   // vertical gap between rows

// Compute per-node color based on liveState (instance mode) or graph kind (RGD mode)
function nodeColors(n, nodeStates) {
  const live = nodeStates && nodeStates[n.id];
  if (live) {
    switch (live) {
      case 'alive':       return { border: 'var(--alive)',       bg: 'var(--alive-bg)',       text: 'var(--alive)' };
      case 'reconciling': return { border: 'var(--reconciling)', bg: 'var(--reconciling-bg)', text: 'var(--reconciling)' };
      case 'pending':     return { border: 'var(--pending)',     bg: 'var(--pending-bg)',     text: 'var(--pending)' };
      case 'not-found':   return { border: 'var(--notfound)',    bg: 'var(--notfound-bg)',    text: 'var(--text2)' };
      case 'error':       return { border: 'var(--error)',       bg: 'var(--error-bg)',       text: 'var(--error)' };
      case 'ok':          return { border: 'var(--ok)',          bg: 'var(--ok-bg)',          text: '#5dade2' };
      case 'meta':        return { border: 'var(--meta)',        bg: 'var(--meta-bg)',        text: 'var(--meta)' };
    }
  }
  // Static RGD-only coloring by node type
  if (n.kind === 'root')    return { border: 'var(--root)',       bg: 'var(--root-bg)',    text: 'var(--root)' };
  if (n.isExternal || n.isExternalCollection) return { border: 'var(--external-node)', bg: 'rgba(139,92,246,0.08)', text: 'var(--external-node)' };
  if (n.isConditional)      return { border: 'var(--pending)',    bg: 'var(--pending-bg)', text: 'var(--pending)' };
  if (n.isForEach)          return { border: 'var(--cyan)',       bg: '#001a20',           text: 'var(--cyan)' };
  return { border: '#2a4a6a', bg: '#0a1420', text: 'var(--text)' };
}

function nodeIcon(n, liveState) {
  const live = liveState;
  if (live === 'reconciling') return '⟳';
  if (live === 'not-found')   return '○';
  if (live === 'error')       return '✕';
  if (n.kind === 'root')   return '⬡';
  if (n.isExternal || n.isExternalCollection) return '⬡';
  if (n.isForEach)         return '∀';
  if (n.isConditional)     return '?';
  return '▪';
}

function renderDagView(data, svgId, isInstance) {
  if (!data || !data.graph) {
    const svg = document.getElementById(svgId);
    if (svg) svg.innerHTML = '';
    return;
  }
  const { graph, rgdName, nodeStates, reconciling } = data;

  // Close stale detail panel only when switching views (not on live refresh)
  if (svgId === 'dag-svg') {
    document.getElementById('detail-panel').classList.add('hidden');
  }
  // Note: instance-detail-panel is NOT reset here — renderDagView is called on
  // every 5s watcher tick for the live view and we don't want to close the panel.

  // Update title (only for main DAG panel)
  if (svgId === 'dag-svg') {
    document.getElementById('dag-title').textContent = rgdName || 'RGD Graph';
  }

  const { nodes, edges } = graph;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const ns = nodeStates || {};

  // ── BFS layout ──────────────────────────────────────────────────────
  // Build adjacency list from edges
  const childrenOf = {};
  for (const e of edges) {
    if (!childrenOf[e.from]) childrenOf[e.from] = [];
    childrenOf[e.from].push(e.to);
  }

  // BFS to determine depth
  const depthOf = {};
  const queue = [];
  for (const n of nodes) {
    if (n.kind === 'root') { depthOf[n.id] = 0; queue.push(n.id); }
  }
  const visited = new Set(Object.keys(depthOf));
  while (queue.length) {
    const id = queue.shift();
    const d = depthOf[id] || 0;
    for (const child of (childrenOf[id] || [])) {
      if (!visited.has(child)) {
        visited.add(child);
        depthOf[child] = d + 1;
        queue.push(child);
      }
    }
  }
  // Unvisited nodes (no edges back to root) go at depth 1
  for (const n of nodes) if (depthOf[n.id] === undefined) depthOf[n.id] = 1;

  // Group by depth
  const byDepth = {};
  for (const n of nodes) {
    const d = depthOf[n.id];
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(n);
  }

  // Sort within each depth: root first, state nodes last, conditional in middle
  for (const row of Object.values(byDepth)) {
    row.sort((a, b) => {
      const rankA = a.kind === 'root' ? 0 : (a.isExternal || a.isExternalCollection) ? 3 : a.isConditional ? 2 : 1;
      const rankB = b.kind === 'root' ? 0 : (b.isExternal || b.isExternalCollection) ? 3 : b.isConditional ? 2 : 1;
      return rankA - rankB;
    });
  }

  // Assign x/y positions
  const pos = {};
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));
  // Find widest row to determine canvas width
  let maxRowW = 0;
  for (const row of Object.values(byDepth)) {
    const w = row.length * (NODE_W + H_GAP) - H_GAP;
    if (w > maxRowW) maxRowW = w;
  }
  const svgW = Math.max(maxRowW + H_GAP * 2, 500);

  for (const [dStr, row] of Object.entries(byDepth)) {
    const d = Number(dStr);
    row.forEach((n, i) => {
      pos[n.id] = {
        x: H_GAP + i * (NODE_W + H_GAP),
        y: H_GAP / 2 + d * (NODE_H + V_GAP),
      };
    });
  }

  const svgH = (maxDepth + 1) * (NODE_H + V_GAP) + H_GAP;

  const svg = document.getElementById(svgId);
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);
  svg.setAttribute('viewBox', '0 0 ' + svgW + ' ' + svgH);
  svg.innerHTML = '';

  // ── Arrow markers ───────────────────────────────────────────────────
  const defs = svgEl('defs');
  defs.innerHTML =
    '<marker id="arr-' + svgId + '" markerWidth="7" markerHeight="7" refX="3.5" refY="7" orient="auto">' +
      '<path d="M0,0 L7,0 L3.5,7 z" fill="#2a4a6a"/></marker>' +
    '<marker id="arr-active-' + svgId + '" markerWidth="7" markerHeight="7" refX="3.5" refY="7" orient="auto">' +
      '<path d="M0,0 L7,0 L3.5,7 z" fill="#58a6ff"/></marker>' +
    '<marker id="arr-dashed-' + svgId + '" markerWidth="7" markerHeight="7" refX="3.5" refY="7" orient="auto">' +
      '<path d="M0,0 L7,0 L3.5,7 z" fill="#444"/></marker>';
  svg.appendChild(defs);

  // ── Draw edges ──────────────────────────────────────────────────────
  const edgeGroup = svgEl('g');
  for (const e of edges) {
    const fp = pos[e.from];
    const tp = pos[e.to];
    if (!fp || !tp) continue;

    const fromNode = nodeMap.get(e.from);
    const toNode   = nodeMap.get(e.to);
    const fromLive = ns[e.from];
    const toLive   = ns[e.to];
    const isActive = reconciling && (fromLive === 'reconciling' || toLive === 'reconciling');
    const isDashed = e.dashed || e.conditional;
    const toExists = (toNode && toNode.exists !== false) && (toLive !== 'not-found');

    const x1 = fp.x + NODE_W / 2;
    const y1 = fp.y + NODE_H;
    const x2 = tp.x + NODE_W / 2;
    const y2 = tp.y;
    const my = (y1 + y2) / 2;
    const pathD = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2;

    const stroke = isActive ? '#58a6ff' : isDashed ? '#333' : '#1e3a5f';
    const markerId = isActive ? ('arr-active-' + svgId) : isDashed ? ('arr-dashed-' + svgId) : ('arr-' + svgId);

    // Wrap edge path + invisible hit-area in a group for click/hover
    const eGroup = svgEl('g');
    eGroup.style.cursor = 'pointer';

    const path = svgEl('path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', stroke);
    path.setAttribute('stroke-width', isActive ? '2' : '1.5');
    if (isDashed) path.setAttribute('stroke-dasharray', '5,3');
    path.setAttribute('opacity', toExists ? '1' : '0.25');
    path.setAttribute('marker-end', 'url(#' + markerId + ')');
    eGroup.appendChild(path);

    // Invisible wider hit area so the edge is easy to click
    const hitPath = svgEl('path');
    hitPath.setAttribute('d', pathD);
    hitPath.setAttribute('fill', 'none');
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', '12');
    eGroup.appendChild(hitPath);

    // Edge label
    if (e.label) {
      const lx = (x1 + x2) / 2 + 4;
      const ly = my - 4;
      const lbl = svgEl('text');
      lbl.setAttribute('x', lx);
      lbl.setAttribute('y', ly);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('font-size', '9');
      lbl.setAttribute('fill', isActive ? '#58a6ff' : isDashed ? '#555' : '#2a4a6a');
      lbl.setAttribute('font-family', 'var(--font)');
      for (const [li, line] of e.label.split('\\n').entries()) {
        const ts = svgEl('tspan');
        ts.setAttribute('x', lx);
        ts.setAttribute('dy', li === 0 ? '0' : '10');
        ts.textContent = line;
        lbl.appendChild(ts);
      }
      eGroup.appendChild(lbl);
    }

    // Click: show edge detail panel
    eGroup.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onEdgeClick(e, fromNode, toNode, svgId);
    });

    // Hover: highlight
    eGroup.addEventListener('mouseenter', () => { path.setAttribute('stroke-width', '3'); path.setAttribute('stroke', isActive ? '#79bfff' : isDashed ? '#5a6a7a' : '#2a6aaf'); });
    eGroup.addEventListener('mouseleave', () => { path.setAttribute('stroke-width', isActive ? '2' : '1.5'); path.setAttribute('stroke', stroke); });

    edgeGroup.appendChild(eGroup);
  }
  svg.appendChild(edgeGroup);

  // ── Draw nodes ──────────────────────────────────────────────────────
  const nodeGroup = svgEl('g');
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;

    const live = ns[n.id];
    const colors = nodeColors(n, ns);
    const icon = nodeIcon(n, live);
    const isLocked = live === 'not-found' || n.exists === false;
    const isPulsing = live === 'reconciling' && reconciling;

    const g = svgEl('g');
    g.setAttribute('class', 'dag-node');
    g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    g.setAttribute('data-node-id', n.id);

    // Pulse glow rect (behind the node)
    if (isPulsing) {
      const glow = svgEl('rect');
      glow.setAttribute('class', 'pulse-rect');
      glow.setAttribute('x', '-4');
      glow.setAttribute('y', '-4');
      glow.setAttribute('width', NODE_W + 8);
      glow.setAttribute('height', NODE_H + 8);
      glow.setAttribute('rx', '8');
      glow.setAttribute('fill', colors.border);
      glow.setAttribute('opacity', '0.15');
      g.appendChild(glow);
    }

    // Background rect
    const rect = svgEl('rect');
    rect.setAttribute('class', 'node-bg');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', '5');
    rect.setAttribute('fill', colors.bg);
    rect.setAttribute('stroke', colors.border);
    rect.setAttribute('stroke-width', '1.5');
    if (isLocked) {
      rect.setAttribute('stroke-dasharray', '4,2');
      rect.setAttribute('opacity', '0.4');
    }
    g.appendChild(rect);

    // Kind label (small, top center)
    const kindLbl = svgEl('text');
    kindLbl.setAttribute('x', NODE_W / 2);
    kindLbl.setAttribute('y', '12');
    kindLbl.setAttribute('text-anchor', 'middle');
    kindLbl.setAttribute('font-size', '8');
    kindLbl.setAttribute('font-family', 'var(--font)');
    kindLbl.setAttribute('fill', isLocked ? '#333' : '#6e7681');
    kindLbl.textContent = truncate(n.resourceKind || n.kind, 16);
    g.appendChild(kindLbl);

    // Main label (bold, center)
    const mainLbl = svgEl('text');
    mainLbl.setAttribute('x', '10');
    mainLbl.setAttribute('y', '25');
    mainLbl.setAttribute('font-size', '11');
    mainLbl.setAttribute('font-weight', '600');
    mainLbl.setAttribute('font-family', 'monospace');
    mainLbl.setAttribute('fill', isLocked ? '#333' : colors.text);
    mainLbl.textContent = truncate(n.label, 13);
    g.appendChild(mainLbl);

    // Icon (right of label)
    const iconEl = svgEl('text');
    iconEl.setAttribute('x', NODE_W - 14);
    iconEl.setAttribute('y', '26');
    iconEl.setAttribute('font-size', '11');
    iconEl.setAttribute('fill', isLocked ? '#333' : colors.text);
    iconEl.textContent = icon;
    g.appendChild(iconEl);

    // Locked label
    if (isLocked) {
      const lockedLbl = svgEl('text');
      lockedLbl.setAttribute('x', NODE_W / 2);
      lockedLbl.setAttribute('y', '38');
      lockedLbl.setAttribute('text-anchor', 'middle');
      lockedLbl.setAttribute('font-size', '8');
      lockedLbl.setAttribute('fill', '#444');
      lockedLbl.setAttribute('font-family', 'var(--font)');
      lockedLbl.textContent = live === 'not-found' ? 'not found' : 'locked';
      g.appendChild(lockedLbl);
    } else {
      // State dot (top right)
      const dot = svgEl('circle');
      dot.setAttribute('cx', NODE_W - 6);
      dot.setAttribute('cy', '6');
      dot.setAttribute('r', '3');
      dot.setAttribute('fill', colors.border);
      g.appendChild(dot);
    }

    // Hover tooltip + click handler
    const hasYaml = isInstance && !isLocked;
    g.style.cursor = 'pointer';
    g.addEventListener('mouseenter', () => showHoverTooltip(g, n, live, hasYaml, p));
    g.addEventListener('mouseleave', () => removeHoverTooltip(svgId));
    g.addEventListener('click', () => onNodeClick(n, live, data));

    nodeGroup.appendChild(g);
  }
  svg.appendChild(nodeGroup);

  // Start/stop pulse ticker based on reconciling state
  if (reconciling) startPulse();
  else stopPulse();
}

// ── Hover tooltip ──────────────────────────────────────────────────────
let hoverTooltip = null;
function removeHoverTooltip(svgId) {
  const svg = document.getElementById(svgId);
  const old = svg && svg.querySelector('.hover-tooltip');
  if (old) old.remove();
}
function showHoverTooltip(nodeG, n, live, hasYaml, pos) {
  const svgEl2 = nodeG.ownerSVGElement;
  if (!svgEl2) return;
  const old = svgEl2.querySelector('.hover-tooltip');
  if (old) old.remove();

  const tx = pos.x + NODE_W / 2;
  const ty = pos.y + NODE_H + 8;

  const detail = n.detail || (n.resourceKind || n.kind);
  const hint = hasYaml ? 'click → inspect YAML' : 'click → view CEL';

  const g = svgEl('g');
  g.setAttribute('class', 'hover-tooltip');
  g.setAttribute('pointer-events', 'none');

  const lines = [truncate(detail, 40), hint];
  const boxW = 180;
  const boxH = lines.length * 14 + 8;

  const bg = svgEl('rect');
  bg.setAttribute('x', tx - boxW / 2);
  bg.setAttribute('y', ty);
  bg.setAttribute('width', boxW);
  bg.setAttribute('height', boxH);
  bg.setAttribute('rx', '3');
  bg.setAttribute('fill', '#0a0e1a');
  bg.setAttribute('stroke', hasYaml ? '#58a6ff' : '#30363d');
  bg.setAttribute('stroke-width', '1');
  g.appendChild(bg);

  lines.forEach((line, i) => {
    const t = svgEl('text');
    t.setAttribute('x', tx);
    t.setAttribute('y', ty + 14 + i * 14);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '9');
    t.setAttribute('font-family', 'var(--font)');
    t.setAttribute('fill', i === 1 ? (hasYaml ? '#58a6ff' : '#8b949e') : '#ccc');
    t.textContent = line;
    g.appendChild(t);
  });

  svgEl2.appendChild(g);
}

// ─── kro concept definitions (injected as safe JSON at build time) ────
const KRO_CONCEPTS = ${KRO_CONCEPTS_JSON};

// ─── Node click handler ────────────────────────────────────────────────
function onNodeClick(n, live, viewData) {
  // isInstance: true only for live instance views (have an actual instance object)
  const isInstance = !!(viewData && viewData.instance);
  if (isInstance && live !== 'not-found') {
    const childResources = viewData.childResources || [];
    const nodeKind = (n.resourceKind || n.label).toLowerCase();
    const instName = viewData.instanceName || (viewData.instance && viewData.instance.name) || '';
    const instNs = (viewData.instance && viewData.instance.namespace) || viewData.namespace || 'default';
    // The managed namespace is typically the instance name (kro creates a NS matching the CR name)
    const managedNs = instNs === 'default' ? instName : instNs;

    // Find ALL child resources whose kind matches this node
    const kindMatches = childResources.filter(cr =>
      cr.kind.toLowerCase() === nodeKind || cr.kind.toLowerCase() === nodeKind + 's'
    );

    // Pick the best match: prefer "alive"/"ready" resources; fall back to first
    const match = kindMatches.find(cr => cr.status === 'alive' || cr.status === 'ready')
      || kindMatches[0]
      || (n.kind === 'root' && viewData.instance
          ? { kind: viewData.instance.kind, name: viewData.instance.name, namespace: viewData.instance.namespace }
          : null);

    showNodeDetailPanel(n, viewData, 'live');

    if (match) {
      requestNodeYaml(n, match, viewData, 'live');
    } else if (n.kind !== 'root' && n.resourceKind && instName && !n.isForEach && !n.isExternal) {
      // Resource not yet in childResources — infer name from node label.
      // kro names resources as {instanceName}-{baseLabel} where baseLabel is the
      // node label with any trailing CR/CRs suffix stripped (case-insensitive).
      const baseLabel = n.label.replace(/CRs?$/i, '').toLowerCase();
      const inferredName = instName + '-' + baseLabel;
      requestNodeYaml(n, { kind: n.resourceKind, name: inferredName, namespace: managedNs }, viewData, 'live');
    }
    // forEach nodes with no match: skip YAML (there are multiple, user should use deep view)
  } else if (!isInstance && n.resourceKind && n.kind !== 'external' && n.kind !== 'externalCollection') {
    // RGD graph view — show CEL detail; no live YAML (no instance context available)
    showNodeDetailPanel(n, viewData, 'graph');
  } else {
    showNodeDetailPanel(n, viewData, 'graph');
  }
}

function requestNodeYaml(n, resource, viewData, mode) {
  pendingInspect = { nodeId: n.id, mode: mode || 'graph' };
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'node.inspect',
      nodeId: n.id,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace || viewData.namespace || 'default',
      kubectlContext: viewData.kubectlContext,
    }));
  }
}

function handleNodeYaml(msg) {
  // Route to the correct panel depending on where the inspect was triggered.
  const mode = pendingInspect?.mode || 'graph';
  const isDeepMode = mode === 'deep';
  pendingInspect = null;

  if (isDeepMode) {
    // Deep instance panel: show YAML in deep-info-body
    const infoPanel = document.getElementById('deep-info-panel');
    infoPanel.classList.remove('hidden');
    const body = document.getElementById('deep-info-body');
    const existingYaml = body.querySelector('.yaml-section');
    if (existingYaml) existingYaml.remove();
    const yamlSection = document.createElement('div');
    yamlSection.className = 'yaml-section';
    if (!msg.yaml) {
      yamlSection.innerHTML =
        '<div class="detail-section-title" style="margin-top:12px">Live YAML</div>' +
        '<div class="inspect-loading">Resource not found in cluster.</div>' +
        (msg.kubectlCmd ? '<div class="kubectl-cmd" title="click to copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(' + JSON.stringify(msg.kubectlCmd) + ')">' + esc(msg.kubectlCmd) + '</div>' : '');
    } else {
      yamlSection.innerHTML =
        '<div class="detail-section-title" style="margin-top:12px">Live YAML</div>' +
        '<div class="kubectl-cmd" title="click to copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(' + JSON.stringify(msg.kubectlCmd) + ')">' + esc(msg.kubectlCmd) + '</div>' +
        '<pre class="yaml-inspect">' + highlightYaml(msg.yaml) + '</pre>';
    }
    body.appendChild(yamlSection);
  } else {
    // RGD graph or live instance panel: replace the yaml-section placeholder
    const { panel, bodyEl } = (mode === 'live')
      ? { panel: document.getElementById('instance-detail-panel'), bodyEl: document.getElementById('instance-detail-body') }
      : { panel: document.getElementById('detail-panel'), bodyEl: document.getElementById('detail-body') };
    panel.classList.remove('hidden');
    const existingYaml = bodyEl.querySelector('.yaml-section');
    const yamlSection = document.createElement('div');
    yamlSection.className = 'yaml-section detail-section';
    if (!msg.yaml) {
      yamlSection.innerHTML =
        '<div class="detail-section-title">Live YAML</div>' +
        '<div class="inspect-loading">Resource not found in cluster.</div>' +
        (msg.kubectlCmd ? '<div class="kubectl-cmd" title="click to copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(' + JSON.stringify(msg.kubectlCmd) + ')">' + esc(msg.kubectlCmd) + '</div>' : '');
    } else {
      yamlSection.innerHTML =
        '<div class="detail-section-title">Live YAML</div>' +
        '<div class="kubectl-cmd" title="click to copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(' + JSON.stringify(msg.kubectlCmd) + ')">' + esc(msg.kubectlCmd) + '</div>' +
        '<pre class="yaml-inspect">' + highlightYaml(msg.yaml) + '</pre>';
    }
    if (existingYaml) existingYaml.replaceWith(yamlSection);
    else bodyEl.appendChild(yamlSection);
  }
}

function showDetailLoading(label, subtitle) {
  const { panel, titleEl, bodyEl } = getDetailEls('graph');
  panel.classList.remove('hidden');
  titleEl.textContent = label;
  const existingYaml = bodyEl.querySelector('.yaml-section');
  if (!existingYaml) {
    bodyEl.innerHTML =
      '<div class="inspect-loading">⟳ fetching ' + esc(subtitle) + ' from cluster…</div>';
  }
}

// ─── Panel routing helpers ─────────────────────────────────────────────
// Returns { panel, titleEl, bodyEl } for the correct side panel based on mode.
function getDetailEls(mode) {
  if (mode === 'live') {
    return {
      panel: document.getElementById('instance-detail-panel'),
      titleEl: document.getElementById('instance-detail-title'),
      bodyEl: document.getElementById('instance-detail-body'),
    };
  }
  return {
    panel: document.getElementById('detail-panel'),
    titleEl: document.getElementById('detail-title'),
    bodyEl: document.getElementById('detail-body'),
  };
}

// Show node metadata (CEL, tags, concept) in the appropriate side panel.
function showNodeDetailPanel(n, viewData, mode) {
  const { panel, titleEl, bodyEl } = getDetailEls(mode || 'graph');
  panel.classList.remove('hidden');
  titleEl.textContent = n.label;
  const parts = [];

  // ── Type badges ──────────────────────────────────────────────────────
  const tags = [];
  if (n.kind === 'root')  tags.push(conceptBadge('root', 'root CR'));
  if (n.isExternal)       tags.push(conceptBadge('external', 'externalRef'));
  if (n.isExternalCollection) tags.push(conceptBadge('external', 'externalRef collection'));
  if (n.isConditional)    tags.push(conceptBadge('includeWhen', 'includeWhen'));
  if (n.isForEach)        tags.push(conceptBadge('forEach', 'forEach'));
  if (n.readyWhen?.length) tags.push(conceptBadge('readyWhen', 'readyWhen'));
  if (!n.isExternal && !n.isExternalCollection && !n.isConditional && !n.isForEach && n.kind !== 'root')
    tags.push(conceptBadge('resource', 'managed resource'));
  if (tags.length) parts.push('<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px">' + tags.join('') + '</div>');

  if (n.resourceKind) parts.push(detailRow('Kind', n.resourceKind));

  // Live state badge (only in live mode) — use innerHTML-safe insertion
  if (mode === 'live' && viewData && viewData.nodeStates && viewData.nodeStates[n.id]) {
    const s = viewData.nodeStates[n.id];
    parts.push('<div class="detail-section"><div class="detail-section-title">STATE</div>' +
      '<span class="state-tag state-' + esc(s) + '">' + esc(s) + '</span></div>');
  }

  const conceptKey = n.kind === 'root' ? 'root' : (n.isExternal || n.isExternalCollection) ? 'external' : n.isConditional ? 'includeWhen' : n.isForEach ? 'forEach' : 'resource';
  const concept = KRO_CONCEPTS[conceptKey];
  if (concept) {
    parts.push(
      '<div class="concept-box">' +
        '<div class="concept-title">' + esc(concept.title) + '</div>' +
        '<div class="concept-what">' + esc(concept.what) + '</div>' +
        '<div class="concept-how">' + esc(concept.how) + '</div>' +
        (concept.example ? '<pre class="concept-example">' + esc(concept.example) + '</pre>' : '') +
      '</div>'
    );
  }

  if (n.includeWhen?.length) parts.push(celSection('includeWhen — exists only when true', n.includeWhen));
  if (n.readyWhen?.length) parts.push(celSection('readyWhen — blocks downstream until true', n.readyWhen));
  if (n.forEachExpr) parts.push(celSection('forEach — iterates over', [n.forEachExpr]));
  const knownCel = new Set([...(n.includeWhen||[]), ...(n.readyWhen||[]), n.forEachExpr||'']);
  const otherCel = (n.celExpressions || []).filter(e => e && !knownCel.has(e));
  if (otherCel.length) parts.push(celSection('Other CEL expressions', otherCel));

  // YAML loading placeholder — only shown in live mode where a fetch is actually triggered.
  // In graph (RGD) mode there is no instance context so no YAML can be fetched.
  if (mode === 'live' && n.resourceKind && !n.isExternal && !n.isExternalCollection) {
    parts.push('<div class="detail-section yaml-section"><div class="detail-section-title">Live YAML</div><div class="inspect-loading">⟳ fetching from cluster…</div></div>');
  }

  bodyEl.innerHTML = parts.join('');
}

// ─── CEL/concept detail panel ─────────────────────────────────────────
function showNodeDetailCEL(n) {
  showNodeDetailPanel(n, null, 'graph');
}

// ─── Edge click handler ────────────────────────────────────────────────
function onEdgeClick(e, fromNode, toNode, svgId) {
  // Only show detail panel for the main DAG (not instance-dag-svg which is embedded)
  if (svgId !== 'dag-svg') return;

  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  const fromLabel = fromNode ? fromNode.label : e.from;
  const toLabel = toNode ? toNode.label : e.to;
  const edgeType = e.label || (e.conditional ? 'includeWhen' : 'dependency');
  document.getElementById('detail-title').textContent = fromLabel + ' → ' + toLabel;

  const body = document.getElementById('detail-body');
  const parts = [];

  // Relationship type badge
  const typeColors = {
    'includeWhen': 'var(--yellow)', 'forEach': 'var(--cyan)', 'externalRef': 'var(--external-node)',
    'dependency': 'var(--accent)',
  };
  const tc = typeColors[edgeType] || 'var(--text2)';
  parts.push('<div style="margin-bottom:10px"><span class="tag" style="color:' + tc + '">' + esc(edgeType) + '</span></div>');

  // Source → target summary
  parts.push(
    '<div class="detail-section">' +
      '<div class="detail-section-title">From</div>' +
      '<div style="font-size:12px;color:var(--text)">' + esc(fromLabel) +
        (fromNode?.resourceKind ? ' <span style="color:var(--text2)">(' + esc(fromNode.resourceKind) + ')</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="detail-section">' +
      '<div class="detail-section-title">To</div>' +
      '<div style="font-size:12px;color:var(--text)">' + esc(toLabel) +
        (toNode?.resourceKind ? ' <span style="color:var(--text2)">(' + esc(toNode.resourceKind) + ')</span>' : '') +
      '</div>' +
    '</div>'
  );

  // Concept explanation for this edge type
  const conceptKey = edgeType === 'dependency' ? 'resource' : edgeType;
  const concept = KRO_CONCEPTS[conceptKey];
  if (concept) {
    parts.push(
      '<div class="concept-box">' +
        '<div class="concept-title">' + esc(concept.title) + '</div>' +
        '<div class="concept-what">' + esc(concept.what) + '</div>' +
        '<div class="concept-how">' + esc(concept.how) + '</div>' +
        (concept.example ? '<pre class="concept-example">' + esc(concept.example) + '</pre>' : '') +
      '</div>'
    );
  }

  // For dependency edges: show what CEL in toNode references fromNode
  if (edgeType === 'dependency' && toNode) {
    const allCel = [
      ...(toNode.includeWhen || []),
      ...(toNode.readyWhen || []),
      ...(toNode.forEachExpr ? [toNode.forEachExpr] : []),
      // externalRef has no CEL expressions to show here
      ...(toNode.celExpressions || []),
    ];
    const relevant = allCel.filter(expr => expr && expr.includes(fromNode?.label || ''));
    if (relevant.length) {
      parts.push(celSection('CEL expressions referencing ' + fromLabel, relevant));
    } else if (allCel.length) {
      parts.push(celSection('CEL expressions in ' + toLabel, allCel.slice(0, 4)));
    }
  }

  // For includeWhen edges: show the actual condition expressions
  if (edgeType === 'includeWhen' && toNode?.includeWhen?.length) {
    parts.push(celSection('includeWhen condition — must be true for "' + toLabel + '" to exist', toNode.includeWhen));
  }

  // For forEach edges: show the iterator expression
  if (edgeType === 'forEach' && toNode?.forEachExpr) {
    parts.push(celSection('forEach iterates over', [toNode.forEachExpr]));
  }

  // For externalRef: show ref details
  if (edgeType === 'externalRef' && toNode?.resourceKind) {
    parts.push('<div class="detail-section"><div class="detail-section-title">References existing</div><div class="cel-chip">' + esc(toNode.resourceKind) + '</div></div>');
  }

  body.innerHTML = parts.join('');
}

function celSection(title, exprs) {
  return '<div class="detail-section"><div class="detail-section-title">' + esc(title) + '</div>' +
    exprs.map(e => celChip(e)).join('') + '</div>';
}

function conceptBadge(key, label) {
  const colors = {
    'root': 'var(--root)', 'external': 'var(--external-node)', 'includeWhen': 'var(--pending)',
    'forEach': 'var(--cyan)', 'readyWhen': 'var(--accent)', 'resource': 'var(--text2)',
  };
  const c = colors[key] || 'var(--text2)';
  const concept = KRO_CONCEPTS[key];
  const tip = concept ? concept.title + ': ' + concept.what.slice(0,80) + '…' : label;
  return '<span class="tag" style="border-color:' + c + ';color:' + c + '" title="' + esc(tip) + '">' + esc(label) + '</span>';
}

function celChip(expr) {
  const short = expr.length > 220 ? expr.slice(0, 217) + '…' : expr;
  return '<div class="cel-chip" title="Click to copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(' + JSON.stringify(expr) + ')">' + esc(short) + '<span class="cel-copy">⎘</span></div>';
}

function detailRow(label, value) {
  return '<div class="detail-section"><div class="detail-section-title">' + esc(label) + '</div>' +
    '<div style="font-size:12px;color:var(--text)">' + esc(String(value)) + '</div></div>';
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.add('hidden');
});
document.getElementById('instance-detail-close').addEventListener('click', () => {
  document.getElementById('instance-detail-panel').classList.add('hidden');
});
document.getElementById('deep-info-close').addEventListener('click', () => {
  document.getElementById('deep-info-panel').classList.add('hidden');
});

// ════════════════════════════════════════════════════════════════════════
// Instance view
// ════════════════════════════════════════════════════════════════════════
function renderInstance(data) {
  if (!data || !data.instance) return;
  const { instance, events, childResources, graph, nodeStates, reconciling, rgd, lastRefresh } = data;

  // Refresh bar
  document.getElementById('refresh-label').textContent =
    'Live — ' + (rgd ? rgd.kind + ' ' : '') + instance.namespace + '/' + instance.name;
  if (lastRefresh) {
    document.getElementById('refresh-time').textContent = 'refreshed ' + relTime(lastRefresh);
  }
  document.getElementById('refresh-spin').style.display = reconciling ? 'inline' : 'none';

  // Reconciling banner
  document.getElementById('instance-reconciling').style.display = reconciling ? 'flex' : 'none';

  // Embedded DAG
  if (graph) {
    renderDagView(data, 'instance-dag-svg', true);
  }

  // Left: spec + conditions + status + child resources
  const left = document.getElementById('instance-left');
  const specEntries = flattenObj(instance.spec, '');
  const statusEntries = flattenObj(instance.status, '').filter(([k]) => k !== 'conditions' && !k.startsWith('conditions.'));
  const conditions = (instance.status && instance.status.conditions) ? instance.status.conditions : [];

  left.innerHTML =
    '<div class="section-title">Spec</div>' +
    renderKV(specEntries) +
    '<div class="section-title" style="margin-top:14px">Conditions</div>' +
    (conditions.length
      ? '<div style="margin-bottom:10px">' + conditions.map(c =>
          '<div class="condition-row">' +
            '<div class="cond-dot ' + condClass(c.status) + '"></div>' +
            '<span class="cond-label">' + esc(c.type) + '</span>' +
            (c.reason ? '<span class="cond-reason">(' + esc(c.reason) + ')</span>' : '') +
            (c.message ? '<span class="cond-reason" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(c.message) + '">' + esc(c.message.slice(0,60)) + (c.message.length>60?'…':'') + '</span>' : '') +
          '</div>'
        ).join('') + '</div>'
      : '<div style="color:var(--text2);font-size:11px;margin-bottom:10px">No conditions</div>') +
    '<div class="section-title" style="margin-top:14px">Status</div>' +
    renderKV(statusEntries) +
    renderChildResourcesSection(childResources);

  // Right: events
  const right = document.getElementById('instance-right');
  right.innerHTML = '<div class="section-title">Events (' + (events ? events.length : 0) + ')</div>';
  if (!events || events.length === 0) {
    right.innerHTML += '<div style="color:var(--text2);font-size:11px;font-style:italic;margin-top:4px">No events</div>';
  } else {
    for (const ev of events.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML =
        '<span class="event-type ' + (ev.type === 'Warning' ? 'event-warning' : 'event-normal') + '">' + esc(ev.type) + '</span>' +
        '<div class="event-reason">' + esc(ev.reason) + '</div>' +
        '<div class="event-msg">' + esc(ev.message.slice(0, 160)) + (ev.message.length>160?'…':'') + '</div>' +
        '<div class="event-meta">×' + ev.count + ' — ' + relTime(ev.lastTime) + '</div>';
      right.appendChild(row);
    }
  }
}

function renderChildResourcesSection(childResources) {
  if (!childResources || childResources.length === 0) return '';
  return '<div class="section-title" style="margin-top:14px">Child Resources (' + childResources.length + ')</div>' +
    childResources.map(cr => {
      const s = cr.status || 'unknown';
      const cls = s === 'ready' || s === 'alive' ? 'csr-ready' : s === 'unknown' ? 'csr-unknown' : 'csr-other';
      return '<div class="child-resource-row">' +
        '<span class="child-kind-badge">' + esc(cr.kind) + '</span>' +
        '<span class="child-name" title="' + esc(cr.name) + '">' + esc(cr.name) + '</span>' +
        '<span class="child-status ' + cls + '">' + esc(s) + '</span>' +
        '</div>';
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════
// Deep instance view
// ════════════════════════════════════════════════════════════════════════
function renderDeepInstance(data) {
  const titleEl = document.getElementById('deep-title');
  const graphWrap = document.getElementById('deep-graph-wrap');
  const infoPanel = document.getElementById('deep-info-panel');
  const refreshLabel = document.getElementById('deep-refresh-label');

  const rgdName = data.rgd?.name || '';
  const instName = data.instanceName || '';
  const ns = data.namespace || '';
  titleEl.textContent = (rgdName ? rgdName + ' · ' : '') + ns + '/' + instName;

  if (data.lastRefresh) {
    const t = new Date(data.lastRefresh);
    refreshLabel.textContent = 'Watching · refreshed ' + t.toLocaleTimeString();
  }

  if (data.loading) {
    graphWrap.innerHTML = '<div class="empty-state"><div class="spin" style="font-size:24px">⟳</div><div class="empty-msg">Building deep graph…</div><div class="empty-sub">Scanning cluster resources</div></div>';
    return;
  }
  if (data.error) {
    graphWrap.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠</div><div class="empty-msg">Error building graph</div><div class="empty-sub">' + esc(data.error) + '</div></div>';
    return;
  }

  const deepGraph = data.deepGraph;
  if (!deepGraph || !deepGraph.nodes || deepGraph.nodes.length === 0) {
    graphWrap.innerHTML = '<div class="empty-state"><div class="empty-icon">⬡</div><div class="empty-msg">No graph data</div></div>';
    return;
  }

  // Render the deep graph SVG
  renderDeepDag(deepGraph, data, graphWrap, infoPanel);
}

function renderDeepDag(deepGraph, viewData, graphWrap, infoPanel) {
  const { nodes, edges, yamlCache } = deepGraph;
  const reconciling = viewData.reconciling || false;

  // Layout: group nodes by depth
  const byDepth = {};
  for (const n of nodes) {
    const d = n.depth || 0;
    if (!byDepth[d]) byDepth[d] = [];
    byDepth[d].push(n);
  }
  const maxDepth = Math.max(...Object.keys(byDepth).map(Number));
  const NODE_W = 140, NODE_H = 48, H_GAP = 32, V_GAP = 68;

  let maxRowW = 0;
  for (const row of Object.values(byDepth)) {
    const w = row.length * (NODE_W + H_GAP) - H_GAP;
    if (w > maxRowW) maxRowW = w;
  }
  const svgW = Math.max(maxRowW + H_GAP * 2, 600);
  const svgH = (maxDepth + 1) * (NODE_H + V_GAP) + H_GAP;

  const pos = {};
  for (const [dStr, row] of Object.entries(byDepth)) {
    const d = Number(dStr);
    row.forEach((n, i) => {
      pos[n.id] = { x: H_GAP + i * (NODE_W + H_GAP), y: H_GAP / 2 + d * (NODE_H + V_GAP) };
    });
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const mk = (tag) => document.createElementNS(svgNS, tag);

  const svg = mk('svg');
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);
  svg.setAttribute('viewBox', '0 0 ' + svgW + ' ' + svgH);

  // Arrow marker
  const defs = mk('defs');
  defs.innerHTML = '<marker id="deep-arr" markerWidth="7" markerHeight="7" refX="3.5" refY="7" orient="auto"><path d="M0,0 L7,0 L3.5,7 z" fill="#2a4a6a"/></marker>';
  svg.appendChild(defs);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // Edges
  const eg = mk('g');
  for (const e of edges) {
    const fp = pos[e.from], tp = pos[e.to];
    if (!fp || !tp) continue;
    const x1 = fp.x + NODE_W / 2, y1 = fp.y + NODE_H;
    const x2 = tp.x + NODE_W / 2, y2 = tp.y;
    const my = (y1 + y2) / 2;
    const path = mk('path');
    path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', e.dashed ? '#333' : '#1e3a5f');
    path.setAttribute('stroke-width', '1.5');
    if (e.dashed) path.setAttribute('stroke-dasharray', '5,3');
    path.setAttribute('marker-end', 'url(#deep-arr)');
    if (e.label) {
      const lt = mk('text');
      lt.setAttribute('x', (x1 + x2) / 2 + 4);
      lt.setAttribute('y', my - 4);
      lt.setAttribute('text-anchor', 'middle');
      lt.setAttribute('font-size', '9');
      lt.setAttribute('fill', '#2a4a6a');
      lt.setAttribute('font-family', 'var(--font)');
      lt.textContent = e.label;
      eg.appendChild(lt);
    }
    eg.appendChild(path);
  }
  svg.appendChild(eg);

  // Nodes
  const ng = mk('g');
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const live = n.liveState || 'unknown';
    const isRoot = n.kind === 'root';
    const hasYaml = !!(yamlCache && yamlCache[n.id]);

    // Color
    let border, bg, textColor;
    switch(live) {
      case 'alive':       border='var(--alive)';       bg='var(--alive-bg)';       textColor='var(--alive)'; break;
      case 'reconciling': border='var(--reconciling)'; bg='var(--reconciling-bg)'; textColor='var(--reconciling)'; break;
      case 'error':       border='var(--error)';       bg='var(--error-bg)';       textColor='var(--error)'; break;
      case 'not-found':   border='var(--notfound)';    bg='var(--notfound-bg)';    textColor='var(--text2)'; break;
      default:
        if (isRoot) { border='var(--root)'; bg='var(--root-bg)'; textColor='var(--root)'; }
        else { border='#2a4a6a'; bg='#0a1420'; textColor='var(--text)'; }
    }

    const g = mk('g');
    g.setAttribute('class', 'dag-node');
    g.setAttribute('data-node-id', n.id);
    g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    g.style.cursor = 'pointer';

    const rect = mk('rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill', bg);
    rect.setAttribute('stroke', border);
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);

    // Kind label (small top)
    const kl = mk('text');
    kl.setAttribute('x', NODE_W / 2);
    kl.setAttribute('y', '13');
    kl.setAttribute('text-anchor', 'middle');
    kl.setAttribute('font-size', '8');
    kl.setAttribute('fill', '#6e7681');
    kl.setAttribute('font-family', 'var(--font)');
    kl.textContent = truncate(n.resourceKind || n.kind, 18);
    g.appendChild(kl);

    // Main label
    const ml = mk('text');
    ml.setAttribute('x', '10');
    ml.setAttribute('y', '28');
    ml.setAttribute('font-size', '11');
    ml.setAttribute('font-weight', '600');
    ml.setAttribute('font-family', 'monospace');
    ml.setAttribute('fill', textColor);
    ml.textContent = truncate(n.label, 14);
    g.appendChild(ml);

    // State dot
    const dot = mk('circle');
    dot.setAttribute('cx', NODE_W - 7);
    dot.setAttribute('cy', '8');
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', border);
    g.appendChild(dot);

    // YAML click indicator
    if (hasYaml) {
      const yamlHint = mk('text');
      yamlHint.setAttribute('x', NODE_W - 10);
      yamlHint.setAttribute('y', '38');
      yamlHint.setAttribute('font-size', '9');
      yamlHint.setAttribute('fill', '#2a4a6a');
      yamlHint.setAttribute('text-anchor', 'end');
      yamlHint.textContent = 'yaml ›';
      g.appendChild(yamlHint);
    }

    // Click handler: show node info + YAML in the info panel together
    g.addEventListener('click', () => {
      const yaml = yamlCache && yamlCache[n.id];
      showDeepNodeInfo(n, infoPanel, yaml);
      if (!yaml && n.crName && n.namespace && n.resourceKind) {
        requestNodeYamlDirect(n.id, n.resourceKind, n.crName, n.namespace, viewData.kubectlContext, 'deep');
      }
    });

    // Hover tooltip
    g.addEventListener('mouseenter', () => {
      const tip = mk('text');
      tip.setAttribute('class', 'deep-tip');
      tip.setAttribute('x', p.x + NODE_W / 2);
      tip.setAttribute('y', p.y - 6);
      tip.setAttribute('text-anchor', 'middle');
      tip.setAttribute('font-size', '9');
      tip.setAttribute('fill', '#aaa');
      tip.setAttribute('pointer-events', 'none');
      tip.textContent = truncate(n.detail || n.label, 50);
      svg.appendChild(tip);
    });
    g.addEventListener('mouseleave', () => {
      for (const t of svg.querySelectorAll('.deep-tip')) t.remove();
    });

    ng.appendChild(g);
  }
  svg.appendChild(ng);

  // Only replace SVG if structure changed (first render or node count changed)
  const existingWrap = graphWrap.querySelector('div');
  const existingSvg = existingWrap?.querySelector('svg');
  const existingNodeCount = existingSvg ? existingSvg.querySelectorAll('.dag-node').length : 0;

  if (existingNodeCount === nodes.length && existingSvg) {
    // Incremental update: just patch colors on existing nodes
    patchDeepNodeColors(existingSvg, nodes);
  } else {
    graphWrap.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow:auto;flex:1;background:var(--bg)';
    wrap.appendChild(svg);
    graphWrap.appendChild(wrap);
  }
}

function patchDeepNodeColors(svg, nodes) {
  for (const n of nodes) {
    const g = svg.querySelector('[data-node-id="' + CSS.escape(n.id) + '"]');
    if (!g) continue;
    const live = n.liveState || 'unknown';
    const isRoot = n.kind === 'root';
    let border, bg, textColor;
    switch(live) {
      case 'alive':       border='var(--alive)';       bg='var(--alive-bg)';       textColor='var(--alive)'; break;
      case 'reconciling': border='var(--reconciling)'; bg='var(--reconciling-bg)'; textColor='var(--reconciling)'; break;
      case 'error':       border='var(--error)';       bg='var(--error-bg)';       textColor='var(--error)'; break;
      case 'not-found':   border='var(--notfound)';    bg='var(--notfound-bg)';    textColor='var(--text2)'; break;
      default:
        if (isRoot) { border='var(--root)'; bg='var(--root-bg)'; textColor='var(--root)'; }
        else { border='#2a4a6a'; bg='#0a1420'; textColor='var(--text)'; }
    }
    const rect = g.querySelector('rect');
    if (rect) { rect.setAttribute('fill', bg); rect.setAttribute('stroke', border); }
    const dot = g.querySelector('circle');
    if (dot) dot.setAttribute('fill', border);
    // Update main label color
    const labels = g.querySelectorAll('text');
    if (labels[1]) labels[1].setAttribute('fill', textColor);
  }
}

function showDeepNodeInfo(n, infoPanel, yaml) {
  infoPanel.classList.remove('hidden');
  document.getElementById('deep-info-title').textContent = n.label;

  const stateClass = {
    'alive': 'state-alive', 'reconciling': 'state-reconciling', 'pending': 'state-pending',
    'not-found': 'state-not-found', 'error': 'state-error', 'ok': 'state-ok',
  }[n.liveState] || 'state-unknown';

  const parts = [];

  // State tag + kind
  parts.push(
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">' +
      '<span class="state-tag ' + stateClass + '">' + esc(n.liveState || 'unknown') + '</span>' +
      '<span style="font-size:11px;color:var(--text2)">' + esc(n.resourceKind || n.kind) + (n.kind === 'root' ? ' · root CR' : '') + '</span>' +
    '</div>'
  );

  // Metadata rows
  parts.push(detailRow('Namespace', n.namespace || '—'));
  parts.push(detailRow('Name', n.crName || n.label));
  if (n.rgdName) parts.push(detailRow('Managed by RGD', n.rgdName));

  // Live conditions
  if (n.liveConditions && n.liveConditions.length) {
    parts.push(
      '<div class="detail-section"><div class="detail-section-title">Conditions</div>' +
      n.liveConditions.map(c =>
        '<div class="condition-row">' +
          '<div class="cond-dot ' + condClass(c.status) + '"></div>' +
          '<span class="cond-label">' + esc(c.type) + '</span>' +
          (c.reason ? '<span class="cond-reason">(' + esc(c.reason) + ')</span>' : '') +
        '</div>'
      ).join('') + '</div>'
    );
  }

  // YAML section — inline if pre-fetched, or placeholder if being fetched
  if (yaml) {
    const kubectlCmd = 'kubectl get ' + (n.resourceKind || n.kind) + ' ' + (n.crName || n.label) + ' -n ' + (n.namespace || 'default') + ' -o yaml';
    parts.push(
      '<div class="detail-section yaml-section">' +
        '<div class="detail-section-title">YAML</div>' +
        '<div class="kubectl-cmd" id="deep-yaml-cmd" title="click to copy">' + esc(kubectlCmd) + '</div>' +
        '<pre class="yaml-inspect">' + highlightYaml(yaml) + '</pre>' +
      '</div>'
    );
  } else if (n.crName && n.namespace && n.resourceKind) {
    parts.push('<div class="detail-section yaml-section"><div class="detail-section-title">YAML</div><div class="inspect-loading">⟳ fetching…</div></div>');
  }

  document.getElementById('deep-info-body').innerHTML = parts.join('');

  // Bind kubectl copy safely after innerHTML (inline onclick can't access closures)
  const cmdEl = document.getElementById('deep-yaml-cmd');
  if (cmdEl) {
    const cmd = cmdEl.textContent || '';
    cmdEl.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(cmd); });
  }
}

function showDeepNodeYaml(n, yaml, infoPanel) {
  // Called when async YAML arrives after the info panel is already shown —
  // just replace the yaml-section placeholder in deep-info-body.
  const body = document.getElementById('deep-info-body');
  if (!body) return;
  const existing = body.querySelector('.yaml-section');
  const kubectlCmd = 'kubectl get ' + (n.resourceKind || n.kind) + ' ' + (n.crName || n.label) + ' -n ' + (n.namespace || 'default') + ' -o yaml';
  const section = document.createElement('div');
  section.className = 'detail-section yaml-section';
  section.innerHTML =
    '<div class="detail-section-title">YAML</div>' +
    '<div class="kubectl-cmd" title="click to copy">' + esc(kubectlCmd) + '</div>' +
    '<pre class="yaml-inspect">' + highlightYaml(yaml) + '</pre>';
  section.querySelector('.kubectl-cmd').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(kubectlCmd); });
  if (existing) {
    existing.replaceWith(section);
  } else {
    body.appendChild(section);
  }
}

function requestNodeYamlDirect(nodeId, kind, name, namespace, kubectlContext, mode) {
  pendingInspect = { nodeId, mode: mode || 'deep' };
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'node.inspect', nodeId, kind, name, namespace, kubectlContext }));
  }
}

function renderKV(entries) {
  if (!entries || entries.length === 0) return '<div style="color:var(--text2);font-size:11px;margin-bottom:6px">empty</div>';
  return '<div class="kv-grid" style="margin-bottom:6px">' +
    entries.slice(0, 60).map(([k, v]) =>
      '<span class="kv-key">' + esc(k) + '</span><span class="kv-val">' + esc(String(v).slice(0, 100)) + '</span>'
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
    if (escaped.trimStart().startsWith('#')) return '<span class="yaml-comment">' + escaped + '</span>';
    const keyVal = escaped.match(/^(\\s*)(\\S[^:]*:)(\\s+)(.*)$/);
    if (keyVal) {
      const [, indent, key, sp, val] = keyVal;
      let valHtml = '<span class="yaml-string">' + val + '</span>';
      if (val === 'true' || val === 'false') valHtml = '<span class="yaml-bool">' + val + '</span>';
      else if (val === 'null' || val === '~') valHtml = '<span class="yaml-null">' + val + '</span>';
      else if (val === '') valHtml = '';
      else if (/^-?\\d+(\\.\\d+)?$/.test(val)) valHtml = '<span class="yaml-number">' + val + '</span>';
      return indent + '<span class="yaml-key">' + key + '</span>' + sp + valHtml;
    }
    // list item
    const listItem = escaped.match(/^(\\s*-\\s+)(.*)$/);
    if (listItem) return listItem[1] + '<span class="yaml-string">' + listItem[2] + '</span>';
    return escaped;
  }).join('\\n');
}

// ════════════════════════════════════════════════════════════════════════
// Utils
// ════════════════════════════════════════════════════════════════════════
function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(s, n) {
  if (!s) return '';
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
  return html.replace("__VERSION_STAMP__", "v" + VERSION + " \u00b7 " + BUILD_TIME);
}
