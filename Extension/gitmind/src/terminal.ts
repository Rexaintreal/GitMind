/**
 * terminal.ts
 *
 * Manages a VS Code pseudo-terminal that shows GitMind's activity log.
 * This is the human-readable timeline; raw process output goes to the
 * Output channel instead.
 */

import * as vscode from 'vscode';

type LogLevel = 'info' | 'warn' | 'error' | 'success';

export class GitMindTerminal {
  private readonly terminal: vscode.Terminal;
  private readonly pty: GitMindPTY;

  constructor() {
    this.pty = new GitMindPTY();
    this.terminal = vscode.window.createTerminal({
      name: 'GitMind',
      pty: this.pty,
      iconPath: new vscode.ThemeIcon('git-commit'),
    });
    this.pty.writeln(
      '\x1b[1;36m╔════════════════════════════════╗\x1b[0m'
    );
    this.pty.writeln(
      '\x1b[1;36m║        GitMind Activity        ║\x1b[0m'
    );
    this.pty.writeln(
      '\x1b[1;36m╚════════════════════════════════╝\x1b[0m'
    );
    this.pty.writeln('');
  }

  log(level: LogLevel, message: string): void {
    const ts = new Date().toLocaleTimeString();
    const color = {
      info:    '\x1b[0m',
      warn:    '\x1b[33m',
      error:   '\x1b[31m',
      success: '\x1b[32m',
    }[level];
    this.pty.writeln(`\x1b[90m${ts}\x1b[0m ${color}${message}\x1b[0m`);
  }

  onAgentEvent(event: 'started' | 'stopped' | 'paused' | 'resumed', path?: string): void {
    switch (event) {
      case 'started':
        this.log('success', `▶ Agent started${path ? ' — watching: ' + path : ''}`);
        break;
      case 'stopped':
        this.log('warn', '■ Agent stopped');
        break;
      case 'paused':
        this.log('warn', '⏸ Agent paused');
        break;
      case 'resumed':
        this.log('info', '▶ Agent resumed');
        break;
    }
  }

  onCommit(hash: string, message: string, isFallback: boolean): void {
    const tag = isFallback ? '\x1b[33m[fallback]\x1b[0m ' : '';
    const shortHash = hash.slice(0, 7);
    this.log('success', `✔ ${tag}\x1b[90m${shortHash}\x1b[0m ${message}`);
  }

  onCommandUpdate(command: string): void {
    this.log('info', `⚡ ${command}`);
  }

  show(): void {
    this.terminal.show();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

// ─── Custom PTY ──────────────────────────────────────────────────────────────

class GitMindPTY implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;

  open(): void {}
  close(): void { this.closeEmitter.fire(); }
  handleInput(_data: string): void {} // read-only terminal

  writeln(text: string): void {
    this.writeEmitter.fire(text + '\r\n');
  }
}
