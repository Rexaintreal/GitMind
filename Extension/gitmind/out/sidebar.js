"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidebarProvider = void 0;
const agentClient_1 = require("./agentClient");
class SidebarProvider {
    _extensionUri;
    _view;
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlContent();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'start':
                    await (0, agentClient_1.sendCommand)('start', { interval_minutes: 5 });
                    break;
                case 'stop':
                    await (0, agentClient_1.sendCommand)('stop');
                    break;
                case 'pause':
                    await (0, agentClient_1.sendCommand)('pause');
                    break;
                case 'commit_now':
                    await (0, agentClient_1.sendCommand)('commit_now');
                    break;
            }
        });
        const interval = setInterval(async () => {
            if (!this._view) {
                return;
            }
            const status = await (0, agentClient_1.getStatus)();
            const log = await (0, agentClient_1.getLog)();
            this._view.webview.postMessage({ type: 'update', status, log });
        }, 5000);
        webviewView.onDidDispose(() => clearInterval(interval));
    }
    _getHtmlContent() {
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
  .commit-msg { font-size: 12px; margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .commit-meta { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .hash { font-family: monospace; color: var(--vscode-textLink-foreground); }
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
</div>

<div class="stats-row">
  <div class="stat">
    <div class="stat-num" id="pending">0</div>
    <div class="stat-label">Pending changes</div>
  </div>
  <div class="stat">
    <div class="stat-num" id="streak">0</div>
    <div class="stat-label">Day streak 🔥</div>
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

  window.addEventListener('message', e => {
    const { type, status, log } = e.data;
    if (type !== 'update') { return; }

    const badge = document.getElementById('status-badge');
    const countdown = document.getElementById('countdown');
    const lastMsg = document.getElementById('last-commit-msg');

    if (!status) {
      badge.className = 'badge badge-offline';
      badge.textContent = 'Offline';
      countdown.textContent = '--:--';
      return;
    }

    badge.className = status.running ? 'badge badge-running' : 'badge badge-paused';
    badge.textContent = status.running ? 'Running' : 'Paused';

    const m = Math.floor(status.next_commit_in / 60);
    const s = String(status.next_commit_in % 60).padStart(2, '0');
    countdown.textContent = m + 'm ' + s + 's';
    lastMsg.textContent = status.last_commit || 'No commits yet';

    document.getElementById('pending').textContent = status.pending_changes ?? '0';
    document.getElementById('streak').textContent = status.streak_days ?? '0';

    if (log && log.commits && log.commits.length > 0) {
      document.getElementById('commit-list').innerHTML = log.commits.slice(0, 8).map(c =>
        '<div class="commit-item">' +
          '<div class="commit-msg">' + c.message + '</div>' +
          '<div class="commit-meta"><span class="hash">' + c.hash + '</span> · ' + c.time + ' · ' + (c.files_changed ?? 0) + ' files</div>' +
        '</div>'
      ).join('');
    }
  });
</script>
</body>
</html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
//# sourceMappingURL=sidebar.js.map