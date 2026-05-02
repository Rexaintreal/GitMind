import * as vscode from 'vscode';

let terminal: vscode.Terminal | undefined;

function getTerminal(): vscode.Terminal {
    if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({
            name: 'GitMind',
            isTransient: true
        });
    }
    return terminal;
}

export function echoCommand(cmd: string) {
    const t = getTerminal();
    t.sendText(`echo "[GitMind] $ ${cmd}"`, true);
}

export function echoInfo(msg: string) {
    const t = getTerminal();
    t.sendText(`echo "[GitMind] ${msg}"`, true);
}