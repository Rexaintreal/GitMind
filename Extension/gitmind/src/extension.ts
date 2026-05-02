/**
 * extension.ts — GitMind entry point
 *
 * Activation flow:
 *  1. Create OutputChannel + ProcessManager
 *  2. ProcessManager.start() → spawns python main.py on a free port
 *  3. ProcessManager emits 'ready' → agentClient.setPort(), SSE stream connects
 *  4. AgentEventStream drives all UI updates (no polling)
 *  5. On deactivate → stop stream, kill process cleanly
 *
 * Changes:
 *  - Rich commit confirmation toast via sidebar + VS Code notification
 *  - Auto-push after every auto-commit (configurable)
 *  - .gitignore injection handled by backend on start
 */

import * as vscode from 'vscode';
import { ProcessManager } from './processManager';
import { agentClient, agentEventStream, AgentStatus, SSEUpdatePayload } from './agentClient';
import { GitMindStatusBar } from './statusBar';
import { GitMindSidebarProvider } from './sidebar';
import { GitMindTerminal } from './terminal';

// ─── Activation ──────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {

  // ── Output channel ────────────────────────────────────────────────────────
  const outputChannel = vscode.window.createOutputChannel('GitMind', { log: true });
  context.subscriptions.push(outputChannel);

  // ── UI components ─────────────────────────────────────────────────────────
  const statusBar = new GitMindStatusBar();
  const terminal  = new GitMindTerminal();
  const sidebar   = new GitMindSidebarProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitMindSidebarProvider.VIEW_ID,
      sidebar,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Process manager ───────────────────────────────────────────────────────
  const pm = new ProcessManager(context.extensionPath, outputChannel);

  pm.on('stdout', (line: string) => terminal.log('info', line));
  pm.on('stderr', (line: string) => terminal.log('warn', line));

  pm.on('stateChange', (s) => {
    outputChannel.appendLine(`[ProcessManager] state → ${s}`);
    statusBar.setProcessState(s);
    sidebar.setProcessState(s);
  });

  pm.on('ready', async (port: number) => {
    agentClient.setPort(port);
    terminal.onAgentEvent('started', pm['_workspacePath']?.() ?? '');

    try {
      const s = await agentClient.status();
      applyStatus(s, statusBar, sidebar, terminal, null);
      lastHash = s.last_commit_hash;
      lastCommand = s.last_command;
    } catch {
      // Non-fatal — SSE will catch up
    }

    refreshLog();
    agentEventStream.connect();
  });

  pm.on('crashed', (_code: number | null, restartIn: number) => {
    statusBar.setOffline();
    sidebar.setOffline();
    terminal.log('error', `Agent crashed. Restarting in ${restartIn}ms…`);
    agentEventStream.disconnect();
  });

  pm.on('fatalError', (reason: string) => {
    statusBar.setOffline();
    sidebar.setOffline();
    agentEventStream.disconnect();
    vscode.window
      .showErrorMessage(reason, 'Open Output', 'Settings')
      .then((choice) => {
        if (choice === 'Open Output') {
          outputChannel.show();
        } else if (choice === 'Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'gitmind');
        }
      });
  });

  // ── SSE event handler ─────────────────────────────────────────────────────

  let lastHash: string | null = null;
  let lastCommand: string | null = null;

  agentEventStream.on('event', async (ev) => {
    switch (ev.type) {
      case 'connected':
        terminal.log('info', 'Live event stream connected.');
        break;

      case 'disconnected':
        terminal.log('warn', 'Event stream disconnected — reconnecting…');
        statusBar.setOffline();
        break;

      case 'update':
      case 'commit': {
        const payload = ev.data as SSEUpdatePayload;
        statusBar.updateFromSSE(payload);
        sidebar.updateFromSSE(payload);

        if (ev.type === 'commit' && payload.last_commit_hash !== lastHash) {
          lastHash = payload.last_commit_hash;
          const commitMsg = payload.last_commit ?? '';
          const commitHash = payload.last_commit_hash ?? '';
          const isFallback = commitMsg.includes('[gitmind-fallback]');
          const cleanMsg = commitMsg.replace('[gitmind-fallback]', '').trim();

          terminal.onCommit(commitHash, commitMsg, isFallback);

          // ── Rich commit confirmation notification ─────────────────────────
          const shortMsg = cleanMsg.length > 60
            ? cleanMsg.slice(0, 57) + '…'
            : cleanMsg;

          const notifMsg = isFallback
            ? `⚡ GitMind committed [fallback] ${commitHash}`
            : `✔ GitMind committed ${commitHash}`;

          vscode.window
            .showInformationMessage(
              notifMsg,
              { detail: shortMsg },
              'Push Now',
              'View Log'
            )
            .then(async (choice) => {
              if (choice === 'Push Now') {
                await doPush();
              } else if (choice === 'View Log') {
                refreshLog();
                vscode.commands.executeCommand('workbench.view.extension.gitmind');
              }
            });

          // Also notify the sidebar webview so it shows its own toast
          sidebar.notifyCommit(commitHash, cleanMsg);

          // ── Auto-push after auto-commit ───────────────────────────────────
          const cfg = vscode.workspace.getConfiguration('gitmind');
          const autoPush = cfg.get<boolean>('autoPushOnCommit', true);
          if (autoPush && payload.pending_push) {
            // Small delay so the commit notification appears first
            setTimeout(() => doPush(/* silent */ true), 1500);
          }

          // Refresh log panel
          refreshLog();
        }
        break;
      }

      case 'heartbeat':
        break;

      case 'error':
        terminal.log('error', `Agent error: ${ev.data.error}`);
        break;
    }
  });

  // ── Auto-push helper ──────────────────────────────────────────────────────

  async function doPush(silent = false): Promise<void> {
    try {
      const r = await agentClient.push();
      if (r.status === 'pushed') {
        if (!silent) {
          vscode.window.showInformationMessage('GitMind: Pushed to origin ✓');
        }
        sidebar.notifyPush();
        terminal.log('info', 'Auto-pushed to origin.');
      } else if (!silent) {
        vscode.window.showWarningMessage(`GitMind push: ${r.message ?? 'failed'}`);
      }
    } catch (e) {
      if (!silent) {
        vscode.window.showErrorMessage(`GitMind push failed: ${errMsg(e)}`);
      }
      terminal.log('error', `Push failed: ${errMsg(e)}`);
    }
  }

  // ── Start backend ─────────────────────────────────────────────────────────
  pm.start().catch((err: Error) => {
    outputChannel.appendLine(`[FATAL] pm.start() threw: ${err.message}`);
  });

  // ── Log refresh helper ────────────────────────────────────────────────────
  async function refreshLog(): Promise<void> {
    try {
      const { commits, activity } = await agentClient.log();
      sidebar.updateLog(commits, activity);
    } catch {
      // Non-critical
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  const commands: Array<[string, () => void | Promise<void>]> = [

    ['gitmind.start', async () => {
      const repoPath = await pickRepoPath();
      if (!repoPath) { return; }

      const intervalStr = await vscode.window.showInputBox({
        prompt: 'Commit interval in seconds',
        value: '300',
        validateInput: (v) =>
          isNaN(Number(v)) || Number(v) < 10 ? 'Must be ≥ 10' : null,
      });
      if (!intervalStr) { return; }

      try {
        await agentClient.start(repoPath, Number(intervalStr));
        vscode.window.showInformationMessage(`GitMind started — watching ${repoPath}`);
      } catch (e) {
        vscode.window.showErrorMessage(`GitMind start failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.stop', async () => {
      try {
        await agentClient.stop();
        terminal.onAgentEvent('stopped');
        vscode.window.showInformationMessage('GitMind stopped.');
      } catch (e) {
        vscode.window.showErrorMessage(`Stop failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.pause', async () => {
      try {
        const r = await agentClient.pause();
        const label = r.status === 'paused' ? 'paused' : 'resumed';
        terminal.onAgentEvent(label as 'paused' | 'resumed');
        vscode.window.showInformationMessage(`GitMind ${label}.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Pause failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.commitNow', async () => {
      try {
        const r = await agentClient.commitNow();
        if (r.status === 'committed') {
          const shortHash = r.hash ?? '?';
          const msg = r.message ?? '';
          const shortMsg = msg.length > 55 ? msg.slice(0, 52) + '…' : msg;

          // Show rich notification with action buttons
          vscode.window
            .showInformationMessage(
              `✔ Committed ${shortHash}`,
              { detail: shortMsg },
              'Push Now',
              'View Log'
            )
            .then(async (choice) => {
              if (choice === 'Push Now') {
                await doPush();
              } else if (choice === 'View Log') {
                refreshLog();
                vscode.commands.executeCommand('workbench.view.extension.gitmind');
              }
            });

          sidebar.notifyCommit(shortHash, msg);

          // Auto-push if enabled
          const cfg = vscode.workspace.getConfiguration('gitmind');
          const autoPush = cfg.get<boolean>('autoPushOnCommit', true);
          if (autoPush) {
            setTimeout(() => doPush(true), 1500);
          }

        } else if (r.status === 'nothing_to_commit') {
          vscode.window.showInformationMessage('GitMind: Nothing to commit — working tree clean.');
        } else {
          vscode.window.showInformationMessage(r.message ?? r.status);
        }
        refreshLog();
      } catch (e) {
        vscode.window.showErrorMessage(`Commit failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.push', async () => {
      await doPush(false);
    }],

    ['gitmind.toggleAutoMode', async () => {
      try {
        const r = await agentClient.toggleAutoMode();
        vscode.window.showInformationMessage(
          `Auto-commit ${r.auto_mode ? 'enabled ✔' : 'disabled'}.`
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Toggle failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.setTone', async () => {
      const tone = await vscode.window.showQuickPick(
        ['conventional', 'casual', 'detailed'],
        { placeHolder: 'Select commit message tone' }
      );
      if (!tone) { return; }
      try {
        await agentClient.setTone(tone);
        vscode.window.showInformationMessage(`Tone → ${tone}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Set tone failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.amendFallbacks', async () => {
      try {
        const r = await agentClient.amend();
        vscode.window.showInformationMessage(r.message ?? 'Amend complete.');
        refreshLog();
      } catch (e) {
        vscode.window.showErrorMessage(`Amend failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.clearCache', async () => {
      try {
        await agentClient.clearCache();
        vscode.window.showInformationMessage('LLM cache cleared.');
      } catch (e) {
        vscode.window.showErrorMessage(`Clear cache failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.resetMemory', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Reset all GitMind memory? This clears all learned preferences.',
        { modal: true },
        'Reset'
      );
      if (answer !== 'Reset') { return; }
      try {
        const r = await agentClient.resetMemory();
        vscode.window.showInformationMessage(r.message);
      } catch (e) {
        vscode.window.showErrorMessage(`Reset failed: ${errMsg(e)}`);
      }
    }],

    ['gitmind.restartAgent', async () => {
      vscode.window.showInformationMessage('Restarting GitMind agent…');
      agentEventStream.disconnect();
      await pm.restart();
    }],

    ['gitmind.showTerminal',  () => terminal.show()],
    ['gitmind.showOutput',    () => outputChannel.show()],
    ['gitmind.openSidebar',   () => vscode.commands.executeCommand('workbench.view.extension.gitmind')],
    ['gitmind.refresh',       () => refreshLog()],

    ['gitmind.showStats', async () => {
      try {
        const s = await agentClient.stats();
        const lines = [
          `Total commits:    ${s.total_commits}`,
          `Accepted:         ${s.accepted_commits}`,
          `Rejected:         ${s.rejected_commits}`,
          `Acceptance rate:  ${pct(s.acceptance_rate)}`,
          `Cache hit rate:   ${pct(s.cache.hit_rate)}  (${s.cache.hits} hits)`,
          `Streak:           ${s.streak_days} day(s)`,
        ].join('\n');
        vscode.window.showInformationMessage(lines, { modal: true });
      } catch (e) {
        vscode.window.showErrorMessage(`Stats failed: ${errMsg(e)}`);
      }
    }],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  context.subscriptions.push({
    dispose: async () => {
      agentEventStream.disconnect();
      await pm.stop();
      statusBar.dispose();
      terminal.dispose();
    },
  });
}

export function deactivate(): void {
  // All cleanup is handled via context.subscriptions above
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function pickRepoPath(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return vscode.window.showInputBox({
      prompt: 'Path to git repository',
      placeHolder: '/path/to/repo',
    });
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
    { placeHolder: 'Select repo to watch' }
  );
  return pick?.fsPath;
}

function applyStatus(
  s: AgentStatus,
  statusBar: GitMindStatusBar,
  sidebar: GitMindSidebarProvider,
  terminal: GitMindTerminal,
  lastHash: string | null
): void {
  statusBar.update(s);
  sidebar.updateStatus(s);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
