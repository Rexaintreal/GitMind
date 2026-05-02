import * as vscode from 'vscode';
import { sendCommand, getStatus, getLog } from './agentClient';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'start':
                    await sendCommand('start', { interval_minutes: 5 });
                    break;
                case 'stop':
                    await sendCommand('stop');
                    break;
                case 'pause':
                    await sendCommand('pause');
                    break;
                case 'commit_now':
                    await sendCommand('commit_now');
                    break;
            }
        });

        const interval = setInterval(async () => {
            if (!this._view) { return; }
            const status = await getStatus();
            const log = await getLog();
            this._view.webview.postMessage({ type: 'update', status, log });
        }, 5000);

        webviewView.onDidDispose(() => clearInterval(interval));
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 12px;
  }
  .card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 10px;
  }
  .card-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
  }
  .status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .badge-running { background: #1a7f3c22; color: #3fb950; border: 1px solid #3fb95044; }
  .badge-paused  { background: #9e6a0322; color: #d29922; border: 1px solid #d2992244; }
  .badge-offline { background: #f8514922; color: #f85149; border: 1px solid #f8514944; }
  .countdown { font-size: 22px; font-weight: 700; color: var(--vscode-foreground); }
  .sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .stats-row { display: flex; gap: 8px; margin-bottom: 10px; }
  .stat {
    flex: 1;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 8px;
    text-align: center;
  }
  .stat-num { font-size: 20px; font-weight: 700; }
  .stat-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  button {
    padding: 7px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { opacity: 0.85; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    grid-column: span 2;
  }
  .commit-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .commit-item:last-child { border-bottom: none; }
  .commit-msg {
    font-size: 12px;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .commit-meta { font-size: 10px; color: var(--vscode-descriptionForeground); display: flex; gap: 6px; flex-wrap: wrap; }
  .hash { font-family: monospace; color: var(--vscode-textLink-foreground); }
  .ai-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #8957e522;
    color: #bc8cff;
    border: 1px solid #8957e544;
    font-weight: 600;
  }
  .ins { color: #3fb950; }
  .del { color: #f85149; }
  .last-cmd {
    font-family: monospace;
    font-size: 10px;
    color: var(--vscode-textLink-foreground);
    background: var(--vscode-editor-background);
    padding: 4px 8px;
    border-radius: 4px;
    margin-top: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border: 1px solid var(--vscode-panel-border);
  }
</style>
</head>
<body>

<div class="card">
  <div class="card-title">Status</div>
  <div class="status-row">
    <span id="status-badge" class="badge badge-offline">Offline</span>
    <span class="countdown" id="countdown">--:--</span>
  </div>
  <div class="sub" id="last-commit-msg">No commits yet</div>
  <div class="last-cmd" id="last-cmd" style="display:none"></div>
</div>

<div class="stats-row">
  <div class="stat">
    <div class="stat-num" id="pending">0</div>
    <div class="stat-label">Pending</div>
  </div>
  <div class="stat">
    <div class="stat-num" id="streak">0</div>
    <div class="stat-label">Day streak 🔥</div>
  </div>
  <div class="stat">
    <div class="stat-num" id="total-commits">0</div>
    <div class="stat-label">Commits</div>
  </div>
</div>

<div class="btn-grid">
  <button onclick="send('start')">▶ Start</button>
  <button onclick="send('stop')">■ Stop</button>
  <button onclick="send('pause')">⏸ Pause</button>
  <button class="btn-primary" onclick="send('commit_now')">⚡ Commit Now</button>
</div>

<div class="card">
  <div class="card-title">Recent Commits</div>
  <div id="commit-list"><div class="sub">No commits yet</div></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(command) { vscode.postMessage({ command }); }

  function formatTime(iso) {
    try {
      const d = new Date(iso);
      const diff = Math.floor((Date.now() - d) / 1000);
      if (diff < 60) { return diff + 's ago'; }
      if (diff < 3600) { return Math.floor(diff/60) + 'm ago'; }
      if (diff < 86400) { return Math.floor(diff/3600) + 'h ago'; }
      return Math.floor(diff/86400) + 'd ago';
    } catch { return iso; }
  }

  window.addEventListener('message', e => {
    const { type, status, log } = e.data;
    if (type !== 'update') { return; }

    const badge = document.getElementById('status-badge');
    const countdown = document.getElementById('countdown');
    const lastMsg = document.getElementById('last-commit-msg');
    const lastCmd = document.getElementById('last-cmd');

    if (!status) {
      badge.className = 'badge badge-offline';
      badge.textContent = 'Offline';
      countdown.textContent = '--:--';
      lastCmd.style.display = 'none';
      return;
    }

    badge.className = status.running ? 'badge badge-running' : 'badge badge-paused';
    badge.textContent = status.running ? 'Running' : 'Paused';

    const m = Math.floor(status.next_commit_in / 60);
    const s = String(status.next_commit_in % 60).padStart(2, '0');
    countdown.textContent = m + 'm ' + s + 's';

    lastMsg.textContent = status.last_commit || 'No commits yet';

    if (status.last_command) {
      lastCmd.style.display = 'block';
      lastCmd.textContent = '$ ' + status.last_command;
    } else {
      lastCmd.style.display = 'none';
    }

    document.getElementById('pending').textContent = status.pending_changes ?? '0';
    document.getElementById('streak').textContent = status.streak_days ?? '0';

    if (log && log.commits) {
      document.getElementById('total-commits').textContent = log.commits.length;

      if (log.commits.length > 0) {
        document.getElementById('commit-list').innerHTML = log.commits.slice(0, 10).map(c => {
          const aiTag = c.is_gitmind ? '<span class="ai-badge">AI</span>' : '';
          const ins = c.insertions ? '<span class="ins">+' + c.insertions + '</span>' : '';
          const del = c.deletions ? '<span class="del">-' + c.deletions + '</span>' : '';
          return '<div class="commit-item">' +
            '<div class="commit-msg">' + aiTag + ' ' + c.message + '</div>' +
            '<div class="commit-meta">' +
              '<span class="hash">' + c.hash + '</span>' +
              '<span>' + formatTime(c.time) + '</span>' +
              '<span>' + (c.files_changed ?? 0) + ' files</span>' +
              ins + del +
              '<span style="color:var(--vscode-descriptionForeground)">' + (c.author || '') + '</span>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    }
  });
</script>
</body>
</html>`;
    }
}