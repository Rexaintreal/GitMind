/**
 * statusBar.ts
 *
 * Single status bar item that reflects the agent's current state.
 * Accepts both full AgentStatus (on initial load) and the lean
 * SSEUpdatePayload (on every stream event) so no conversion is needed.
 */

import * as vscode from 'vscode';
import { AgentStatus, SSEUpdatePayload } from './agentClient';
import { ProcessState } from './processManager';

export class GitMindStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'gitmind.openSidebar';
    this.item.text = '$(sync~spin) GitMind: starting…';
    this.item.tooltip = 'GitMind — spawning agent';
    this.item.show();
  }

  /** Called with full status on initial fetch */
  update(s: AgentStatus): void {
    if (!s.running) {
      this.item.text = '$(circle-slash) GitMind: idle';
      this.item.tooltip = 'GitMind agent is not running';
      this.item.backgroundColor = undefined;
      return;
    }
    if (s.paused) {
      this.item.text = '$(debug-pause) GitMind: paused';
      this.item.tooltip = `Paused — ${s.pending_changes} pending changes`;
      this.item.backgroundColor = undefined;
      return;
    }
    const next = s.next_commit_in > 0 ? ` (next: ${fmtSeconds(s.next_commit_in)})` : '';
    this.item.text = `$(git-commit) GitMind: active${next}`;
    this.item.tooltip =
      `Watching: ${s.repo_path}\n` +
      `Pending: ${s.pending_changes} changes\n` +
      `Streak: ${s.streak_days} days\n` +
      `Last commit: ${s.last_commit ?? 'none'}`;
    this.item.backgroundColor = undefined;
  }

  /** Called on every SSE update event — lean payload, no full status needed */
  updateFromSSE(p: SSEUpdatePayload): void {
    if (!p.running) {
      this.item.text = '$(circle-slash) GitMind: idle';
      this.item.tooltip = 'GitMind agent is not running';
      this.item.backgroundColor = undefined;
      return;
    }
    if (p.paused) {
      this.item.text = '$(debug-pause) GitMind: paused';
      this.item.backgroundColor = undefined;
      return;
    }
    const next = p.next_commit_in > 0 ? ` (${fmtSeconds(p.next_commit_in)})` : '';
    this.item.text = `$(git-commit) GitMind${next}`;
    this.item.tooltip =
      `Streak: ${p.streak_days} days | ` +
      `Last: ${p.last_commit ?? 'none'}`;
    this.item.backgroundColor = undefined;
  }

  setOffline(): void {
    this.item.text = '$(warning) GitMind: offline';
    this.item.tooltip = 'Agent is unreachable — check the GitMind output panel';
    this.item.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
  }

  setProcessState(s: ProcessState): void {
    switch (s) {
      case 'starting':
        this.item.text = '$(sync~spin) GitMind: starting…';
        this.item.tooltip = 'Spawning agent process';
        this.item.backgroundColor = undefined;
        break;
      case 'restarting':
        this.item.text = '$(sync~spin) GitMind: restarting…';
        this.item.tooltip = 'Agent crashed — restarting';
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        break;
      case 'crashed':
        this.item.text = '$(error) GitMind: failed';
        this.item.tooltip = 'Agent failed — see output panel';
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        break;
      case 'stopped':
        this.item.text = '$(circle-slash) GitMind: stopped';
        this.item.backgroundColor = undefined;
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

function fmtSeconds(s: number): string {
  if (s < 60) { return `${s}s`; }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}
