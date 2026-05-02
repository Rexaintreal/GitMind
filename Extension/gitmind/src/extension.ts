import * as vscode from 'vscode';
import { createStatusBar } from './statusBar';
import { sendCommand } from './agentClient';
import { echoInfo } from './terminal';

export function activate(context: vscode.ExtensionContext) {
    console.log('GitMind is now active');

    createStatusBar(context);

    // Start command — asks for interval first
    context.subscriptions.push(
        vscode.commands.registerCommand('gitmind.start', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Auto-commit every X minutes',
                value: '5',
                validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
            });
            if (!input) { return; }
            await sendCommand('start', { interval_minutes: Number(input) });
            echoInfo('Agent started — committing every ' + input + ' minutes');
            vscode.window.showInformationMessage(`GitMind started ✓ — committing every ${input} min`);
        })
    );

    // Stop command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitmind.stop', async () => {
            await sendCommand('stop');
            echoInfo('Agent stopped');
            vscode.window.showInformationMessage('GitMind stopped');
        })
    );

    // Pause command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitmind.pause', async () => {
            await sendCommand('pause');
            echoInfo('Agent paused');
            vscode.window.showInformationMessage('GitMind paused');
        })
    );

    // Commit now command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitmind.commitNow', async () => {
            await sendCommand('commit_now');
            echoInfo('Manual commit triggered');
            vscode.window.showInformationMessage('GitMind — committing now...');
        })
    );

    // Placeholder for status bar click
    context.subscriptions.push(
        vscode.commands.registerCommand('gitmind.showPanel', () => {
            vscode.window.showInformationMessage('GitMind panel coming soon!');
        })
    );
}

export function deactivate() {}