import * as vscode from 'vscode';
import { getStatus } from './agentClient';
import { echoCommand } from './terminal';

let previousCommand: string | null = null;
let offlineCount = 0;
let offlineNotified = false;

export function createStatusBar(context: vscode.ExtensionContext) {
    const bar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 100
    );

    bar.command = 'gitmind.showPanel';
    bar.text = '$(git-commit) GitMind starting...';
    bar.tooltip = 'GitMind — click to open panel';
    bar.show();

    setInterval(async () => {
        const s = await getStatus();

        // Offline detection
        if (!s) {
            offlineCount++;
            bar.text = '$(warning) GitMind offline';
            bar.tooltip = 'Agent not running. Start it with: python main.py';

            if (offlineCount >= 3 && !offlineNotified) {
                offlineNotified = true;
                const choice = await vscode.window.showWarningMessage(
                    'GitMind agent is not running. Start it with: cd agent && python main.py',
                    'Open Terminal'
                );
                if (choice === 'Open Terminal') {
                    vscode.commands.executeCommand('workbench.action.terminal.new');
                }
            }
            return;
        }

        // Reset offline state when agent comes back
        offlineCount = 0;
        offlineNotified = false;

        // Terminal echo — fires only when last_command changes
        if (s.last_command && s.last_command !== previousCommand) {
            previousCommand = s.last_command;
            echoCommand(s.last_command);
        }

        // Update status bar text
        if (s.running) {
            const mins = Math.floor(s.next_commit_in / 60);
            const secs = String(s.next_commit_in % 60).padStart(2, '0');
            bar.text = `$(git-commit) GitMind ${mins}m ${secs}s`;
            bar.tooltip = `Last commit: ${s.last_commit}`;
        } else {
            bar.text = '$(circle-slash) GitMind paused';
            bar.tooltip = 'GitMind is paused';
        }

    }, 5000);

    context.subscriptions.push(bar);
}