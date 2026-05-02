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
  :root {
    --card-bg: var(--vscode-sideBar-background);
    --item-bg: var(--vscode-editor-background);
    --border: var(--vscode-panel-border);
    --accent: var(--vscode-button-background);
    --radius: 8px;
    --shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--card-bg);
    padding: 16px;
    line-height: 1.4;
  }

  /* --- STATUS CARD --- */
  .card-glass {
    background: var(--item-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 20px;
    box-shadow: var(--shadow);
    position: relative;
    overflow: hidden;
  }

  .card-glass::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0; height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.5;
  }

  .card-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
  }

  .status-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .countdown {
    font-size: 28px;
    font-weight: 300;
    letter-spacing: -0.02em;
    color: var(--vscode-foreground);
  }

  .badge {
    font-size: 10px;
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .badge-running { background: #1a7f3c33; color: #3fb950; border: 1px solid #3fb95044; }
  .badge-paused  { background: #9e6a0333; color: #d29922; border: 1px solid #d2992244; }
  .badge-offline { background: #f8514933; color: #f85149; border: 1px solid #f8514944; }

  .description {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  /* --- STATS GRID --- */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 20px;
  }

  .stat-card {
    background: var(--item-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 4px;
    text-align: center;
    transition: transform 0.2s ease;
  }

  .stat-card:hover { transform: translateY(-2px); }

  .stat-value { font-size: 18px; font-weight: 700; margin-bottom: 2px; }
  .stat-label { font-size: 9px; text-transform: uppercase; color: var(--vscode-descriptionForeground); font-weight: 600; }

  /* --- DEPTH BUTTONS --- */
  .btn-group {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 20px;
  }

  button {
    padding: 10px;
    border-radius: var(--radius);
    border: 1px solid rgba(255, 255, 255, 0.1);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    background: linear-gradient(180deg, var(--vscode-button-secondaryBackground) 0%, rgba(0,0,0,0.1) 100%);
    color: var(--vscode-button-secondaryForeground);
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    transition: all 0.1s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  button:active {
    transform: translateY(1px);
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }

  .btn-primary {
    grid-column: span 2;
    background: linear-gradient(180deg, var(--accent) 0%, rgba(0,0,0,0.2) 100%);
    color: var(--vscode-button-foreground);
    padding: 12px;
    font-size: 13px;
    margin-top: 4px;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  button:hover { filter: brightness(1.1); }

  /* --- COMMIT LIST --- */
  .section-header {
    font-size: 11px;
    font-weight: 700;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    margin-bottom: 12px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }

  .commit-item {
    padding: 10px;
    border-radius: var(--radius);
    margin-bottom: 8px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid transparent;
    transition: all 0.2s ease;
  }

  .commit-item:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--border);
  }

  .commit-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 4px;
  }

  .commit-msg {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .commit-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .hash {
    font-family: 'SF Mono', monospace;
    color: var(--vscode-textLink-foreground);
    background: rgba(0,0,0,0.2);
    padding: 1px 4px;
    border-radius: 4px;
  }

  .diff-stat { display: flex; gap: 4px; font-weight: 700; }
  .ins { color: #3fb950; }
  .del { color: #f85149; }

  .last-cmd {
    font-family: 'SF Mono', monospace;
    font-size: 9px;
    color: #bc8cff;
    background: rgba(137, 87, 229, 0.1);
    padding: 6px 10px;
    border-radius: 6px;
    margin-top: 10px;
    border: 1px solid rgba(137, 87, 229, 0.2);
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>

<div class="card-glass">
  <div class="card-title">
    <span>Agent Lifecycle</span>
    <span id="status-badge" class="badge badge-offline">Offline</span>
  </div>
  <div class="status-main">
    <span class="countdown" id="countdown">--:--</span>
  </div>
  <div class="description" id="last-commit-msg">Ready to synchronize</div>
  <div class="last-cmd" id="last-cmd" style="display:none"></div>
</div>

<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-value" id="pending">0</div>
    <div class="stat-label">Changes</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" id="streak">0</div>
    <div class="stat-label">Streak</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" id="total-commits">0</div>
    <div class="stat-label">Commits</div>
  </div>
</div>

<div class="btn-group">
  <button onclick="send('start')">Start</button>
  <button onclick="send('stop')">Stop</button>
  <button onclick="send('pause')">Pause</button>
  <button class="btn-primary" onclick="send('commit_now')">Commit Changes Now</button>
</div>

<div class="section-header">Activity Timeline</div>
<div id="commit-list">
  <div class="description" style="text-align:center; padding: 20px;">Waiting for connection...</div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(command) { vscode.postMessage({ command }); }

  function formatTime(iso) {
    try {
      const d = new Date(iso);
      const diff = Math.floor((Date.now() - d) / 1000);
      if (diff < 60) return diff + 's';
      if (diff < 3600) return Math.floor(diff/60) + 'm';
      if (diff < 86400) return Math.floor(diff/3600) + 'h';
      return Math.floor(diff/86400) + 'd';
    } catch { return ''; }
  }

  window.addEventListener('message', e => {
    const { type, status, log } = e.data;
    if (type !== 'update') return;

    const badge = document.getElementById('status-badge');
    const countdown = document.getElementById('countdown');
    const lastMsg = document.getElementById('last-commit-msg');
    const lastCmd = document.getElementById('last-cmd');

    if (!status) {
      badge.className = 'badge badge-offline';
      badge.textContent = 'Offline';
      return;
    }

    badge.className = status.running ? 'badge badge-running' : 'badge badge-paused';
    badge.textContent = status.running ? 'Running' : 'Paused';

    const m = Math.floor(status.next_commit_in / 60);
    const s = String(status.next_commit_in % 60).padStart(2, '0');
    countdown.textContent = m + ':' + s;

    lastMsg.textContent = status.last_commit || 'Ready to synchronize';

    if (status.last_command) {
      lastCmd.style.display = 'block';
      lastCmd.textContent = '> ' + status.last_command;
    } else {
      lastCmd.style.display = 'none';
    }

    document.getElementById('pending').textContent = status.pending_changes ?? '0';
    document.getElementById('streak').textContent = status.streak_days ?? '0';

    if (log && log.commits) {
      document.getElementById('total-commits').textContent = log.commits.length;
      if (log.commits.length > 0) {
        document.getElementById('commit-list').innerHTML = log.commits.slice(0, 10).map(c => {
          const ins = c.insertions ? '<span class="ins">+' + c.insertions + '</span>' : '';
          const del = c.deletions ? '<span class="del">-' + c.deletions + '</span>' : '';
          return \`
            <div class="commit-item">
              <div class="commit-header">
                <div class="commit-msg">\${c.message}</div>
              </div>
              <div class="commit-meta">
                <span class="hash">\${c.hash}</span>
                <span>\${formatTime(c.time)} ago</span>
                <div class="diff-stat">\${ins}\${del}</div>
              </div>
            </div>\`;
        }).join('');
      }
    }
  });
</script>
</body>
</html>`;
    }
}