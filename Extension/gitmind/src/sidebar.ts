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
                    const folders = vscode.workspace.workspaceFolders;
                    const rootPath = folders && folders.length > 0 ? folders[0].uri.fsPath : '.';
                    await sendCommand('start', { path: rootPath });
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
                case 'push':
                    await sendCommand('push');
                    break;
                case 'clear_cache':
                    await sendCommand('clear_cache');
                    break;
                case 'set_tone':
                    await sendCommand('set_tone', { tone: msg.value });
                    break;
                case 'toggle_auto_mode':
                    await sendCommand('toggle_auto_mode');
                    break;
                case 'set_interval':
                    await sendCommand('set_interval', { interval: msg.value });
                    break;
            }
        });

        // Polling loop
        const interval = setInterval(async () => {
            if (!this._view) { return; }
            const status = await getStatus();
            const log = await getLog();
            this._view.webview.postMessage({ type: 'update', status, log });
        }, 3000);

        webviewView.onDidDispose(() => clearInterval(interval));
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval';">
<style>
  :root {
    --bg-color: #0d1117;
    --card-bg: #161b22;
    --border-color: #30363d;
    --text-primary: #c9d1d9;
    --text-secondary: #8b949e;
    --accent-color: #2f81f7;
    --btn-primary-bg: #238636;
    --btn-primary-hover: #2ea043;
    --btn-secondary-bg: #21262d;
    --btn-secondary-hover: #30363d;
    --btn-danger-bg: #da3633;
    --radius: 6px;
    --font-family: -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
  }

  body {
    font-family: var(--font-family);
    background-color: var(--bg-color);
    color: var(--text-primary);
    margin: 0;
    padding: 12px;
    font-size: 13px;
  }

  .section {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    padding: 12px;
    margin-bottom: 12px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
  }
  .dot.online { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .dot.offline { background: var(--btn-danger-bg); box-shadow: 0 0 6px var(--btn-danger-bg); }
  .dot.paused { background: #d29922; box-shadow: 0 0 6px #d29922; }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .row:last-child { margin-bottom: 0; }

  .label { color: var(--text-secondary); }

  .countdown-display {
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 24px;
    font-weight: 300;
    color: var(--accent-color);
    text-align: center;
    margin: 10px 0;
  }

  select, input[type="text"] {
    background: var(--bg-color);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    padding: 4px 8px;
    border-radius: var(--radius);
    font-size: 12px;
    outline: none;
  }

  button {
    background: var(--btn-secondary-bg);
    color: var(--text-primary);
    border: 1px solid rgba(240, 246, 252, 0.1);
    padding: 5px 12px;
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: 0.2s;
  }
  button:hover { background: var(--btn-secondary-hover); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-primary {
    background: var(--btn-primary-bg);
    color: #ffffff;
    border-color: rgba(240, 246, 252, 0.1);
    width: 100%;
    padding: 8px;
    font-weight: 600;
    margin-top: 8px;
  }
  .btn-primary:hover { background: var(--btn-primary-hover); }

  .btn-group { display: flex; gap: 6px; }
  .btn-group button { flex: 1; }

  .commit-feed {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .commit-card {
    background: var(--bg-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    padding: 10px;
  }

  .commit-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .commit-hash {
    color: var(--accent-color);
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 11px;
  }
  .commit-time {
    color: var(--text-secondary);
    font-size: 11px;
  }
  .commit-subject {
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 4px;
    font-size: 13px;
  }
  .commit-body {
    color: var(--text-secondary);
    font-size: 12px;
    white-space: pre-wrap;
    line-height: 1.4;
  }
  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    background: rgba(47, 129, 247, 0.15);
    color: var(--accent-color);
    border: 1px solid rgba(47, 129, 247, 0.3);
    margin-right: 4px;
    margin-bottom: 4px;
  }
  .badge-fallback {
    background: rgba(210, 153, 34, 0.15);
    color: #d29922;
    border-color: rgba(210, 153, 34, 0.3);
  }

  /* Toggle Switch */
  .switch {
    position: relative;
    display: inline-block;
    width: 34px;
    height: 18px;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background-color: var(--border-color);
    transition: .2s; border-radius: 18px;
  }
  .slider:before {
    position: absolute; content: "";
    height: 14px; width: 14px; left: 2px; bottom: 2px;
    background-color: white; transition: .2s; border-radius: 50%;
  }
  input:checked + .slider { background-color: var(--btn-primary-bg); }
  input:checked + .slider:before { transform: translateX(16px); }

  .offline-overlay {
    text-align: center;
    padding: 20px 0;
    color: var(--text-secondary);
  }
</style>
</head>
<body>

<div class="section">
  <div class="section-title">
    GitMind Agent
    <div class="status-indicator">
      <div id="status-dot" class="dot offline"></div>
      <span id="status-text">Offline</span>
    </div>
  </div>
  
  <div class="row">
    <span class="label">Auto-Commit</span>
    <label class="switch">
      <input type="checkbox" id="auto-mode-toggle" onchange="send('toggle_auto_mode')">
      <span class="slider"></span>
    </label>
  </div>

  <div class="countdown-display" id="countdown">--:--</div>
  
  <div class="row">
    <span class="label">Pending Changes</span>
    <span id="pending-count">0</span>
  </div>
</div>

<div class="section">
  <div class="section-title">Controls</div>
  
  <div class="row">
    <span class="label">Interval</span>
    <select id="interval-select" onchange="sendVal('set_interval', this.value)">
      <option value="60">1 minute</option>
      <option value="300">5 minutes</option>
      <option value="600">10 minutes</option>
      <option value="1800">30 minutes</option>
    </select>
  </div>

  <div class="row">
    <span class="label">Tone</span>
    <select id="tone-select" onchange="sendVal('set_tone', this.value)">
      <option value="professional">Professional</option>
      <option value="casual">Casual</option>
      <option value="concise">Concise</option>
      <option value="conventional">Conventional</option>
      <option value="detailed">Detailed</option>
    </select>
  </div>

  <div class="btn-group" style="margin-top: 12px;">
    <button id="btn-start" onclick="send('start')">Start</button>
    <button id="btn-pause" onclick="send('pause')">Pause</button>
    <button id="btn-stop" onclick="send('stop')">Stop</button>
  </div>
</div>

<div class="section">
  <div class="btn-group" style="margin-bottom: 8px;">
    <button onclick="send('push')">Push</button>
    <button onclick="send('clear_cache')">Clear Cache</button>
  </div>
  <button class="btn-primary" onclick="send('commit_now')">Commit Now</button>
</div>

<div class="section">
  <div class="section-title">Recent Commits</div>
  <div id="commit-feed" class="commit-feed">
    <div class="offline-overlay">Waiting for connection...</div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(command) { vscode.postMessage({ command }); }
  function sendVal(command, value) { vscode.postMessage({ command, value }); }

  let countdownValue = 0;
  let isRunning = false;
  let isPaused = false;
  let timerInterval = null;

  function startLiveCountdown() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (isRunning && !isPaused && countdownValue > 0) {
        countdownValue--;
        updateCountdownUI();
      }
    }, 1000);
  }

  function updateCountdownUI() {
    const el = document.getElementById('countdown');
    if (!isRunning || isPaused) {
      el.textContent = isPaused ? 'PAUSED' : '--:--';
      return;
    }
    const m = Math.floor(countdownValue / 60);
    const s = String(countdownValue % 60).padStart(2, '0');
    el.textContent = \`\${m}:\${s}\`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return Math.floor(diff/86400) + 'd ago';
  }

  function parseCommitMessage(msg) {
    if (!msg) return { subject: '', body: '', type: '' };
    const lines = msg.split('\\n');
    const subject = lines[0];
    const body = lines.slice(1).join('\\n').trim();
    
    // Extract type (e.g., "feat(ui): ...")
    let typeMatch = subject.match(/^(\\w+)(?:\\([^)]+\\))?:/);
    let type = typeMatch ? typeMatch[1] : '';

    return { subject, body, type };
  }

  window.addEventListener('message', e => {
    const { type, status, log } = e.data;
    if (type !== 'update') return;

    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');

    if (!status) {
      dot.className = 'dot offline';
      text.textContent = 'Offline';
      isRunning = false;
      isPaused = false;
      updateCountdownUI();
      return;
    }

    isRunning = status.running;
    isPaused = status.paused;

    if (isRunning) {
      if (isPaused) {
        dot.className = 'dot paused';
        text.textContent = 'Paused';
      } else {
        dot.className = 'dot online';
        text.textContent = 'Running';
      }
    } else {
      dot.className = 'dot offline';
      text.textContent = 'Stopped';
    }

    // Sync countdown only if it's drifting (e.g. diff > 2 seconds) to avoid jitter
    if (Math.abs(countdownValue - status.next_commit_in) > 2) {
      countdownValue = status.next_commit_in || 0;
    }
    updateCountdownUI();

    document.getElementById('pending-count').textContent = status.pending_changes ?? '0';
    
    const autoToggle = document.getElementById('auto-mode-toggle');
    if (autoToggle.checked !== status.auto_mode) {
      autoToggle.checked = status.auto_mode;
    }

    const intervalSel = document.getElementById('interval-select');
    if (intervalSel.value != status.commit_interval) {
      // only update if not actively focused, or just set it
      intervalSel.value = status.commit_interval;
    }

    const toneSel = document.getElementById('tone-select');
    if (toneSel.value != status.message_tone) {
      toneSel.value = status.message_tone;
    }

    // Render Commit Feed
    if (log && log.commits && log.commits.length > 0) {
      const feed = document.getElementById('commit-feed');
      feed.innerHTML = log.commits.slice(0, 10).map(c => {
        const parsed = parseCommitMessage(c.message);
        const isFallback = c.message.includes('[fallback]');
        const fallbackBadge = isFallback ? '<span class="badge badge-fallback">Fallback</span>' : '';
        const typeBadge = parsed.type ? \`<span class="badge">\${parsed.type}</span>\` : '';
        
        return \`
          <div class="commit-card">
            <div class="commit-header">
              <span class="commit-hash">\${c.hash}</span>
              <span class="commit-time">\${timeAgo(c.time)}</span>
            </div>
            <div class="commit-subject">\${fallbackBadge}\${typeBadge} \${parsed.subject}</div>
            \${parsed.body ? \`<div class="commit-body">\${parsed.body}</div>\` : ''}
          </div>
        \`;
      }).join('');
    } else {
      document.getElementById('commit-feed').innerHTML = '<div class="offline-overlay">No commits yet</div>';
    }
  });

  startLiveCountdown();
</script>
</body>
</html>`;
    }
}