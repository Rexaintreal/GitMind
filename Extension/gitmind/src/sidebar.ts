/**
 * sidebar.ts
 *
 * Webview sidebar — redesigned UI with auto-commit toggle.
 * Accepts both full AgentStatus and SSEUpdatePayload.
 * All state is pushed in; the sidebar never fetches anything itself.
 */

import * as vscode from 'vscode';
import { AgentStatus, SSEUpdatePayload, CommitEntry, ActivityEntry } from './agentClient';
import { ProcessState } from './processManager';

export class GitMindSidebarProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'gitmind.sidebar';

  private view?: vscode.WebviewView;
  private lastStatus?: AgentStatus | SSEUpdatePayload;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage((msg: { command: string; data?: unknown }) => {
      if (msg.command === 'setTimer') {
        vscode.commands.executeCommand('gitmind.start');
        return;
      }
      vscode.commands.executeCommand(`gitmind.${msg.command}`, msg.data);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.lastStatus) {
        this._post('status', this.lastStatus);
      }
    });
  }

  updateStatus(s: AgentStatus): void {
    this.lastStatus = s;
    this._post('status', s);
  }

  updateFromSSE(p: SSEUpdatePayload): void {
    this.lastStatus = p;
    this._post('sseUpdate', p);
  }

  updateLog(commits: CommitEntry[], activity: ActivityEntry[]): void {
    this._post('log', { commits, activity });
  }

  setOffline(): void {
    this._post('offline', {});
  }

  setProcessState(s: ProcessState): void {
    this._post('processState', { state: s });
  }

  notifyCommit(hash: string, message: string): void {
    this._post('commitConfirm', { hash, message });
  }

  notifyPush(): void {
    this._post('pushConfirm', {});
  }

  /** Push the saved commit interval (seconds) to the webview */
  updateInterval(seconds: number): void {
    this._post('interval', { seconds });
  }

  private _post(type: string, payload: unknown): void {
    this.view?.webview.postMessage({ type, payload });
  }

  private _getHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>GitMind</title>
<style>
  :root {
    --gh-bg:           #0d1117;
    --gh-surface:      #161b22;
    --gh-surface-2:    #1c2128;
    --gh-border:       #30363d;
    --gh-border-muted: #21262d;
    --gh-text:         #e6edf3;
    --gh-text-muted:   #7d8590;
    --gh-text-subtle:  #484f58;
    --gh-green:        #238636;
    --gh-green-light:  #2ea043;
    --gh-green-text:   #3fb950;
    --gh-blue:         #1f6feb;
    --gh-blue-light:   #388bfd;
    --gh-orange:       #9e6a03;
    --gh-orange-text:  #e3b341;
    --gh-red:          #da3633;
    --gh-red-light:    #f85149;
    --gh-purple:       #8957e5;
    --gh-purple-text:  #a371f7;
    --radius-sm:       4px;
    --radius:          6px;
    --font-mono:       'SF Mono', 'Cascadia Code', Consolas, 'Courier New', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 12px;
    line-height: 1.5;
    color: var(--vscode-foreground, var(--gh-text));
    background: var(--vscode-sideBar-background, var(--gh-bg));
  }

  /* ── Header ────────────────────────────────────────────────── */
  #header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 9px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, var(--gh-border));
  }
  #header-icon { width: 16px; height: 16px; flex-shrink: 0; }
  #header-title {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
    flex: 1;
    color: var(--vscode-foreground, var(--gh-text));
  }

  /* ── Status pill ────────────────────────────────────────────── */
  #status-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    border: 1px solid transparent;
    transition: all 0.2s ease;
  }
  #status-pill .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  #status-pill.active  { background: rgba(35,134,54,.15); border-color: rgba(46,160,67,.4); color: var(--gh-green-text); }
  #status-pill.active .dot  { background: var(--gh-green-text); box-shadow: 0 0 4px var(--gh-green-text); }
  #status-pill.paused  { background: rgba(158,106,3,.15); border-color: rgba(227,179,65,.4); color: var(--gh-orange-text); }
  #status-pill.paused .dot  { background: var(--gh-orange-text); }
  #status-pill.stopped { background: rgba(125,133,144,.1); border-color: var(--gh-border); color: var(--gh-text-muted); }
  #status-pill.stopped .dot { background: var(--gh-text-muted); }
  #status-pill.error   { background: rgba(218,54,51,.15); border-color: rgba(248,81,73,.4); color: var(--gh-red-light); }
  #status-pill.error .dot   { background: var(--gh-red-light); }
  #status-pill.starting{ background: rgba(31,111,235,.15); border-color: rgba(56,139,253,.4); color: var(--gh-blue-light); }
  #status-pill.starting .dot{ background: var(--gh-blue-light); animation: pulse 1.2s infinite; }

  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

  /* ── Push banner ────────────────────────────────────────────── */
  #push-banner {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: rgba(139,87,229,.1);
    border-bottom: 1px solid rgba(139,87,229,.25);
    font-size: 11px;
    color: var(--gh-purple-text);
  }
  #push-banner.visible { display: flex; }
  #push-banner button {
    margin-left: auto;
    padding: 2px 8px;
    background: rgba(139,87,229,.2);
    color: var(--gh-purple-text);
    border: 1px solid rgba(139,87,229,.4);
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
  }
  #push-banner button:hover { background: rgba(139,87,229,.35); }

  /* ── Stat row ───────────────────────────────────────────────── */
  #stat-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--vscode-editorGroup-border, var(--gh-border));
    border-top: 1px solid var(--vscode-editorGroup-border, var(--gh-border));
    border-bottom: 1px solid var(--vscode-editorGroup-border, var(--gh-border));
  }
  .stat-block {
    background: var(--vscode-sideBar-background, var(--gh-bg));
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stat-block:hover { background: var(--vscode-list-hoverBackground, rgba(177,186,196,.06)); }
  .stat-label {
    font-size: 10px;
    color: var(--gh-text-muted);
    text-transform: uppercase;
    letter-spacing: .06em;
    font-weight: 500;
  }
  .stat-value {
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground, var(--gh-text));
    line-height: 1.2;
  }
  .stat-value.countdown { color: var(--gh-blue-light); font-family: var(--font-mono); font-size: 13px; }
  .stat-value.streak    { color: var(--gh-orange-text); }
  .stat-value.pending   { color: var(--gh-purple-text); }

  /* ── Auto-commit toggle row ─────────────────────────────────── */
  #auto-commit-row {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-editorGroup-border, var(--gh-border));
    gap: 8px;
    cursor: pointer;
    user-select: none;
    transition: background .12s;
  }
  #auto-commit-row:hover { background: var(--vscode-list-hoverBackground, rgba(177,186,196,.06)); }
  .auto-icon {
    width: 14px; height: 14px;
    color: var(--gh-text-muted);
    flex-shrink: 0;
  }
  .auto-label-group { flex: 1; }
  .auto-label-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-foreground, var(--gh-text));
  }
  .auto-label-sub {
    font-size: 10px;
    color: var(--gh-text-muted);
    margin-top: 1px;
  }

  /* toggle switch */
  .toggle-wrap { flex-shrink: 0; }
  .toggle-switch {
    position: relative;
    width: 32px;
    height: 18px;
    display: inline-block;
    pointer-events: none; /* row handles click */
  }
  .toggle-switch input { display: none; }
  .toggle-track {
    position: absolute;
    inset: 0;
    border-radius: 9px;
    background: var(--gh-border);
    border: 1px solid var(--gh-text-subtle);
    transition: background .2s, border-color .2s;
  }
  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--gh-text-muted);
    transition: transform .2s, background .2s;
    box-shadow: 0 1px 3px rgba(0,0,0,.4);
  }
  .toggle-switch.on .toggle-track  { background: var(--gh-green); border-color: var(--gh-green-light); }
  .toggle-switch.on .toggle-thumb  { background: #fff; transform: translateX(14px); }

  /* ── Section ────────────────────────────────────────────────── */
  .section { border-bottom: 1px solid var(--vscode-editorGroup-border, var(--gh-border)); }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 12px 6px;
    cursor: pointer;
    user-select: none;
  }
  .section-header:hover { background: var(--vscode-list-hoverBackground, rgba(177,186,196,.06)); }
  .section-header-left { display: flex; align-items: center; gap: 6px; }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .07em;
    color: var(--gh-text-muted);
  }
  .section-chevron {
    color: var(--gh-text-subtle);
    transition: transform .15s;
    flex-shrink: 0;
  }
  .section-chevron.collapsed { transform: rotate(-90deg); }
  .section-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 10px;
    background: var(--vscode-badge-background, rgba(56,139,253,.15));
    color: var(--vscode-badge-foreground, var(--gh-blue-light));
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .section-body { padding: 0 8px 8px; }
  .section-body.collapsed { display: none; }

  /* ── Action buttons ─────────────────────────────────────────── */
  .btn-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5px;
    padding: 8px 0 0;
  }
  .btn-grid.full { grid-template-columns: 1fr; }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all .15s ease;
    white-space: nowrap;
    font-family: inherit;
  }
  .btn svg { flex-shrink: 0; }
  .btn-primary {
    background: var(--vscode-button-background, var(--gh-green));
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, var(--gh-green));
  }
  .btn-primary:hover {
    background: var(--vscode-button-hoverBackground, var(--gh-green-light));
    border-color: var(--vscode-button-hoverBackground, var(--gh-green-light));
    filter: brightness(1.1);
  }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, rgba(48,54,61,.9));
    color: var(--vscode-button-secondaryForeground, var(--gh-text));
    border-color: var(--vscode-editorGroup-border, var(--gh-border));
  }
  .btn-secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(56,139,253,.1));
    border-color: var(--gh-blue);
    color: var(--gh-blue-light);
  }
  .btn-danger {
    background: transparent;
    color: var(--gh-red-light);
    border-color: rgba(218,54,51,.4);
  }
  .btn-danger:hover { background: rgba(218,54,51,.1); }
  .btn-push {
    background: rgba(139,87,229,.12);
    color: var(--gh-purple-text);
    border-color: rgba(139,87,229,.35);
  }
  .btn-push:hover { background: rgba(139,87,229,.22); border-color: rgba(139,87,229,.6); }

  /* ── Divider ─────────────────────────────────────────────────── */
  .btn-divider {
    height: 1px;
    background: var(--vscode-editorGroup-border, var(--gh-border-muted));
    margin: 8px 0 0;
    opacity: .6;
  }

  /* ── Commit list ────────────────────────────────────────────── */
  .commit-list { list-style: none; padding: 4px 0 0; }
  .commit-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    margin: 1px 0;
    transition: background .1s;
  }
  .commit-item:hover { background: var(--vscode-list-hoverBackground, rgba(177,186,196,.06)); }
  .commit-dot-track {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 4px;
    flex-shrink: 0;
  }
  .commit-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    border: 2px solid var(--gh-blue-light);
    background: var(--vscode-sideBar-background, var(--gh-bg));
    flex-shrink: 0;
  }
  .commit-dot.gitmind { border-color: var(--gh-green-text); background: rgba(63,185,80,.2); }
  .commit-line {
    width: 1px;
    flex: 1;
    min-height: 6px;
    background: var(--vscode-editorGroup-border, var(--gh-border));
    margin-top: 2px;
  }
  .commit-body { flex: 1; min-width: 0; }
  .commit-msg {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-foreground, var(--gh-text));
    line-height: 1.4;
  }
  .commit-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    flex-wrap: wrap;
  }
  .commit-hash {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--gh-blue-light);
    background: rgba(56,139,253,.1);
    padding: 0 4px;
    border-radius: 3px;
    border: 1px solid rgba(56,139,253,.2);
  }
  .commit-time { font-size: 10px; color: var(--gh-text-muted); }
  .commit-diff { font-size: 10px; color: var(--gh-text-muted); }
  .commit-diff .add { color: var(--gh-green-text); }
  .commit-diff .del { color: var(--gh-red-light); }

  .badge {
    display: inline-flex;
    align-items: center;
    font-size: 9px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 10px;
    letter-spacing: .02em;
    text-transform: uppercase;
    vertical-align: middle;
    margin-left: 4px;
  }
  .badge-gitmind {
    background: rgba(63,185,80,.15);
    color: var(--gh-green-text);
    border: 1px solid rgba(63,185,80,.3);
  }
  .badge-fallback {
    background: rgba(158,106,3,.15);
    color: var(--gh-orange-text);
    border: 1px solid rgba(227,179,65,.25);
  }

  /* ── Activity log ───────────────────────────────────────────── */
  .activity-list {
    list-style: none;
    max-height: 130px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--gh-border) transparent;
  }
  .activity-item {
    display: flex;
    gap: 6px;
    padding: 3px 10px;
    font-size: 11px;
    border-radius: var(--radius-sm);
    line-height: 1.4;
  }
  .activity-item:hover { background: var(--vscode-list-hoverBackground, rgba(177,186,196,.04)); }
  .activity-time {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--gh-text-subtle);
    flex-shrink: 0;
    padding-top: 1px;
  }
  .activity-msg            { color: var(--gh-text-muted); flex: 1; }
  .activity-item.error   .activity-msg { color: var(--gh-red-light); }
  .activity-item.warning .activity-msg { color: var(--gh-orange-text); }

  /* ── Empty state ─────────────────────────────────────────────── */
  .empty-state { text-align: center; padding: 16px 12px; color: var(--gh-text-muted); }
  .empty-state svg { opacity: .3; margin-bottom: 6px; }
  .empty-state p { font-size: 11px; }

  /* ── Scrollbar ───────────────────────────────────────────────── */
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--gh-border); border-radius: 2px; }

  /* ── Toast ───────────────────────────────────────────────────── */
  #toast {
    position: fixed;
    bottom: 10px;
    left: 8px; right: 8px;
    padding: 8px 10px;
    border-radius: var(--radius);
    font-size: 11px;
    display: none;
    align-items: center;
    gap: 6px;
    z-index: 100;
    border: 1px solid transparent;
    animation: slideUp .2s ease;
  }
  #toast.success { background: rgba(35,134,54,.92); border-color: var(--gh-green); color: #fff; display: flex; }
  #toast.warn    { background: rgba(158,106,3,.92); border-color: var(--gh-orange); color: #fff; display: flex; }
  #toast.error   { background: rgba(218,54,51,.92); border-color: var(--gh-red);   color: #fff; display: flex; }
  @keyframes slideUp { from{transform:translateY(8px);opacity:0} to{transform:translateY(0);opacity:1} }
</style>
</head>
<body>

<!-- Header -->
<div id="header">
  <svg id="header-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.2" opacity="0.4"/>
    <circle cx="8" cy="4.5" r="1.5" fill="#3fb950"/>
    <circle cx="8" cy="11.5" r="1.5" fill="#3fb950"/>
    <line x1="8" y1="6" x2="8" y2="10" stroke="#3fb950" stroke-width="1.5"/>
    <circle cx="4.5" cy="10" r="1.3" fill="#388bfd"/>
    <line x1="5.6" y1="9.3" x2="7.2" y2="7.3" stroke="#388bfd" stroke-width="1.2"/>
  </svg>
  <span id="header-title">GitMind</span>
  <div id="status-pill" class="starting">
    <span class="dot"></span>
    <span id="status-label">starting</span>
  </div>
</div>

<!-- Pending push banner -->
<div id="push-banner">
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75zM8 1a.75.75 0 01.75.75v6.94l2.22-2.22a.75.75 0 011.06 1.06l-3.5 3.5a.75.75 0 01-1.06 0l-3.5-3.5a.75.75 0 111.06-1.06L7.25 8.69V1.75A.75.75 0 018 1z"/>
  </svg>
  1 commit ahead of origin
  <button onclick="send('push')">Push now</button>
</div>

<!-- Stat row -->
<div id="stat-row">
  <div class="stat-block">
    <div class="stat-label">Next commit</div>
    <div class="stat-value countdown" id="s-next">–</div>
  </div>
  <div class="stat-block">
    <div class="stat-label">Pending</div>
    <div class="stat-value pending" id="s-pending">–</div>
  </div>
  <div class="stat-block">
    <div class="stat-label">Streak</div>
    <div class="stat-value streak" id="s-streak">–</div>
  </div>
</div>

<!-- Auto-commit toggle -->
<div id="auto-commit-row" onclick="toggleAutoCommit()" title="Toggle automatic commits">
  <svg class="auto-icon" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 0111.14-4.55L3.45 12.64A6.47 6.47 0 011.5 8zm1.86 4.55L12.55 3.36A6.5 6.5 0 013.36 12.55z"/>
  </svg>
  <div class="auto-label-group">
    <div class="auto-label-title">Auto-commit</div>
    <div class="auto-label-sub" id="auto-sub">Commits changes automatically on schedule</div>
  </div>
  <div class="toggle-wrap">
    <div class="toggle-switch" id="auto-toggle-switch">
      <div class="toggle-track"></div>
      <div class="toggle-thumb"></div>
    </div>
  </div>
</div>

<!-- Actions -->
<div class="section">
  <div class="section-header" onclick="toggleSection('actions')">
    <div class="section-header-left">
      <span class="section-title">Actions</span>
    </div>
    <svg class="section-chevron" id="chevron-actions" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
    </svg>
  </div>
  <div class="section-body" id="actions-body">
    <div class="btn-grid">
      <button class="btn btn-primary" onclick="send('commitNow')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z"/>
        </svg>
        Commit Now
      </button>
      <button class="btn btn-push" onclick="send('push')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75zM8 1a.75.75 0 01.75.75v6.94l2.22-2.22a.75.75 0 011.06 1.06l-3.5 3.5a.75.75 0 01-1.06 0l-3.5-3.5a.75.75 0 111.06-1.06L7.25 8.69V1.75A.75.75 0 018 1z"/>
        </svg>
        Push
      </button>
    </div>
    <div class="btn-grid" style="margin-top:5px">
      <button class="btn btn-secondary" id="btn-pause" onclick="send('pause')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" id="pause-icon">
          <path d="M6 3.75A.75.75 0 015.25 3h-.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h.5a.75.75 0 00.75-.75v-8.5zm5.5 0A.75.75 0 0110.75 3h-.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h.5a.75.75 0 00.75-.75v-8.5z"/>
        </svg>
        <span id="pause-label">Pause</span>
      </button>
      <button class="btn btn-secondary" onclick="send('restartAgent')">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M1.705 8.005a.75.75 0 01.834.656 5.5 5.5 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.002 7.002 0 011.05 8.84a.75.75 0 01.656-.834zM8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0114.95 7.16a.75.75 0 11-1.49.178A5.5 5.5 0 008 2.5z"/>
        </svg>
        Restart
      </button>
    </div>
    <div class="btn-divider"></div>
    <div class="btn-grid" style="margin-top:8px">
      <button id="btn-set-timer" class="btn btn-secondary" onclick="send('setTimer')" title="Interval: 1h — click to change">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm8-3a.75.75 0 01.75.75v2.53l1.78 1.78a.75.75 0 11-1.06 1.06l-2-2A.75.75 0 017.25 8V5.75A.75.75 0 018 5z"/>
        </svg>
        Timer: <span id="timer-interval-label">1h</span>
      </button>
      <button class="btn btn-secondary" onclick="send('setTone')" title="Set commit message tone">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 1.75A.75.75 0 01.75 1h4.253c1.227 0 2.317.59 3 1.501A3.744 3.744 0 0111.006 1h3.245a.75.75 0 01.75.75v10.5a.75.75 0 01-.75.75h-3.507a2.25 2.25 0 00-1.591.659l-.622.621a.75.75 0 01-1.06 0l-.622-.621A2.25 2.25 0 005.258 13H.75a.75.75 0 01-.75-.75zm7.251 10.324a3.75 3.75 0 012.757-1.075h2.745V2.5h-2.503a2.25 2.25 0 00-2.25 2.25v7.374zm-1.501 0V4.75a2.25 2.25 0 00-2.25-2.25H1.5v9.5h3.757a3.75 3.75 0 012.493 1.074z"/>
        </svg>
        Set Tone
      </button>
    </div>
    <div class="btn-grid full" style="margin-top:5px">
      <button class="btn btn-secondary" onclick="send('showStats')" title="View commit statistics">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 1.75a.75.75 0 00-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 000-1.5H1.5V1.75zm14.28 2.53a.75.75 0 00-1.06-1.06l-4.5 4.5L6.97 5.47a.75.75 0 00-1.06 0L2.22 9.22a.75.75 0 001.06 1.06l3.16-3.16 2.75 2.75a.75.75 0 001.06 0l5-5z"/>
        </svg>
        View Stats
      </button>
    </div>
  </div>
</div>

<!-- Recent Commits -->
<div class="section">
  <div class="section-header" onclick="toggleSection('commits')">
    <div class="section-header-left">
      <span class="section-title">Commits</span>
      <span class="section-badge" id="commit-count">0</span>
    </div>
    <svg class="section-chevron" id="chevron-commits" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
    </svg>
  </div>
  <div class="section-body" id="commits-body">
    <ul class="commit-list" id="commit-list">
      <li class="empty-state">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" style="display:block;margin:0 auto 4px">
          <path fill-rule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z"/>
        </svg>
        <p>No commits yet</p>
      </li>
    </ul>
  </div>
</div>

<!-- Activity Log -->
<div class="section" style="border-bottom:none">
  <div class="section-header" onclick="toggleSection('activity')">
    <div class="section-header-left">
      <span class="section-title">Activity</span>
    </div>
    <svg class="section-chevron" id="chevron-activity" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
    </svg>
  </div>
  <div class="section-body" id="activity-body">
    <ul class="activity-list" id="activity-list">
      <li class="activity-item info">
        <span class="activity-time">–</span>
        <span class="activity-msg">Waiting for events…</span>
      </li>
    </ul>
  </div>
</div>

<!-- Toast -->
<div id="toast"></div>

<script>
  const vscode = acquireVsCodeApi();

  function send(command, data) {
    vscode.postMessage({ command, data });
  }

  // ── Section toggle ────────────────────────────────────────────────────────
  const sectionState = { actions: true, commits: true, activity: true };

  function toggleSection(id) {
    sectionState[id] = !sectionState[id];
    const body    = document.getElementById(id + '-body');
    const chevron = document.getElementById('chevron-' + id);
    if (body)    body.classList.toggle('collapsed', !sectionState[id]);
    if (chevron) chevron.classList.toggle('collapsed', !sectionState[id]);
  }

  // ── Auto-commit toggle ────────────────────────────────────────────────────
  let autoModeState   = false;
  let intervalSeconds = 3600; // kept in sync via 'interval' messages

  function fmtInterval(s) {
    if (s < 60)   { return s + 's'; }
    if (s < 3600) { const m = Math.floor(s/60), r = s%60; return r===0 ? m+'m' : m+'m '+r+'s'; }
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return m === 0 ? h+'h' : h+'h '+m+'m';
  }

  function setAutoToggle(on) {
    autoModeState = on;
    const sw  = document.getElementById('auto-toggle-switch');
    const sub = document.getElementById('auto-sub');
    sw.classList.toggle('on', on);
    sub.textContent = on
      ? 'Commits every ' + fmtInterval(intervalSeconds) + ' automatically'
      : 'Manual mode — click Commit Now to commit';
  }

  function applyInterval(seconds) {
    intervalSeconds = seconds;
    if (autoModeState) {
      document.getElementById('auto-sub').textContent =
        'Commits every ' + fmtInterval(seconds) + ' automatically';
    }
    const span = document.getElementById('timer-interval-label');
    if (span) { span.textContent = fmtInterval(seconds); }
    const btn = document.getElementById('btn-set-timer');
    if (btn)  { btn.title = 'Interval: ' + fmtInterval(seconds) + ' — click to change'; }
  }

  function toggleAutoCommit() {
    send('toggleAutoMode');
    setAutoToggle(!autoModeState);
    showToast(!autoModeState ? 'Auto-commit enabled' : 'Auto-commit disabled', 'success');
  }

  // ── Format seconds ────────────────────────────────────────────────────────
  function fmtSec(s) {
    if (!s || s <= 0) return '–';
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? m + 'm' : m + 'm ' + String(r).padStart(2, '0') + 's';
  }

  // ── Relative time ─────────────────────────────────────────────────────────
  function relTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // ── Escape HTML ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  const ICONS = {
    success: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>',
    warn:    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.544 4.26a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0v-3zm.76 5.5a1 1 0 110-2 1 1 0 010 2z"/></svg>',
    error:   '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z"/></svg>',
  };
  function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.className = type;
    t.innerHTML = (ICONS[type] || ICONS.success) + ' ' + esc(msg);
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
  }

  // ── Apply status ──────────────────────────────────────────────────────────
  function applyStatus(p) {
    const pill  = document.getElementById('status-pill');
    const label = document.getElementById('status-label');
    const pauseLabel = document.getElementById('pause-label');

    if (!p.running) {
      pill.className = 'stopped'; label.textContent = 'idle';
    } else if (p.paused) {
      pill.className = 'paused'; label.textContent = 'paused';
      if (pauseLabel) pauseLabel.textContent = 'Resume';
    } else {
      pill.className = 'active'; label.textContent = 'active';
      if (pauseLabel) pauseLabel.textContent = 'Pause';
    }

    document.getElementById('s-next').textContent    = fmtSec(p.next_commit_in);
    document.getElementById('s-streak').textContent  = (p.streak_days ?? 0) + 'd';
    if ('pending_changes' in p) {
      document.getElementById('s-pending').textContent = p.pending_changes || 0;
    }

    // Auto-mode toggle
    if ('auto_mode' in p) {
      setAutoToggle(!!p.auto_mode);
    }

    // Push banner
    const pushBanner = document.getElementById('push-banner');
    p.pending_push
      ? pushBanner.classList.add('visible')
      : pushBanner.classList.remove('visible');
  }

  // ── Apply log ─────────────────────────────────────────────────────────────
  function applyLog({ commits, activity }) {
    const list       = document.getElementById('commit-list');
    const countBadge = document.getElementById('commit-count');

    if (commits && commits.length > 0) {
      countBadge.textContent = commits.length;
      list.innerHTML = commits.slice(0, 15).map((c, i, arr) => {
        const isFallback = c.message.includes('[gitmind-fallback]');
        const cleanMsg   = c.message.replace('[gitmind-fallback]', '').trim();
        const badge      = c.is_gitmind
          ? isFallback
            ? '<span class="badge badge-fallback">fallback</span>'
            : '<span class="badge badge-gitmind">gitmind</span>'
          : '';
        const diffStr = (c.insertions || c.deletions)
          ? \`<span class="commit-diff"><span class="add">+\${c.insertions}</span> <span class="del">-\${c.deletions}</span></span>\`
          : '';
        const hasNext = i < arr.length - 1;
        return \`<li class="commit-item">
          <div class="commit-dot-track">
            <div class="commit-dot \${c.is_gitmind ? 'gitmind' : ''}"></div>
            \${hasNext ? '<div class="commit-line"></div>' : ''}
          </div>
          <div class="commit-body">
            <div class="commit-msg">\${esc(cleanMsg)}\${badge}</div>
            <div class="commit-meta">
              <span class="commit-hash">\${esc(c.hash)}</span>
              <span class="commit-time">\${esc(relTime(c.time))}</span>
              \${diffStr}
            </div>
          </div>
        </li>\`;
      }).join('');
    } else {
      countBadge.textContent = '0';
      list.innerHTML = \`<li class="empty-state">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor" style="display:block;margin:0 auto 4px">
          <path fill-rule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z"/>
        </svg>
        <p>No commits yet</p>
      </li>\`;
    }

    const aList = document.getElementById('activity-list');
    if (activity && activity.length > 0) {
      aList.innerHTML = activity.slice(0, 25).map(a => {
        const cls     = a.level === 'error' ? 'error' : a.level === 'warning' ? 'warning' : 'info';
        const timeStr = a.time ? a.time.slice(11, 19) : '–';
        return \`<li class="activity-item \${cls}">
          <span class="activity-time">\${esc(timeStr)}</span>
          <span class="activity-msg">\${esc(a.message)}</span>
        </li>\`;
      }).join('');
    }
  }

  // ── Message handler ───────────────────────────────────────────────────────
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'status':
      case 'sseUpdate':
        applyStatus(msg.payload);
        break;
      case 'log':
        applyLog(msg.payload);
        break;
      case 'commitConfirm': {
        const { hash, message } = msg.payload;
        showToast(\`Committed \${hash}: \${message.slice(0, 40)}\${message.length > 40 ? '…' : ''}\`);
        break;
      }
      case 'pushConfirm':
        showToast('Pushed to origin ✓');
        document.getElementById('push-banner').classList.remove('visible');
        break;
      case 'interval':
        applyInterval(msg.payload.seconds);
        break;
      case 'offline': {
        const pill  = document.getElementById('status-pill');
        const label = document.getElementById('status-label');
        pill.className = 'error'; label.textContent = 'offline';
        break;
      }
      case 'processState': {
        const s     = msg.payload.state;
        const pill  = document.getElementById('status-pill');
        const label = document.getElementById('status-label');
        if (s === 'starting' || s === 'restarting') {
          pill.className = 'starting'; label.textContent = s + '…';
        } else if (s === 'crashed') {
          pill.className = 'error'; label.textContent = 'crashed';
        } else if (s === 'stopped') {
          pill.className = 'stopped'; label.textContent = 'stopped';
        }
        break;
      }
    }
  });
</script>
</body>
</html>`;
  }
}
