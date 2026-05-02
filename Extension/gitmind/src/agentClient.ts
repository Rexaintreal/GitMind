/**
 * agentClient.ts
 *
 * Clean communication layer between the extension and the Flask backend.
 *
 * Design choices:
 *  - Port is dynamic (set by ProcessManager after spawn, not hardcoded)
 *  - SSE stream replaces 3-second polling for status/commit events
 *  - All HTTP methods go through one typed `request<T>()` helper
 *  - AgentEventStream owns the EventSource lifecycle and reconnects automatically
 */

import { EventEmitter } from 'events';

// ─── HTTP types (identical to old agentClient.ts) ────────────────────────────

export interface AgentStatus {
  running: boolean;
  paused: boolean;
  watcher_active: boolean;
  repo_path: string;
  commit_interval: number;
  next_commit_in: number;
  last_commit: string | null;
  last_commit_time: string | null;
  last_commit_hash: string | null;
  pending_push: boolean;
  last_command: string | null;
  pending_changes: number;
  streak_days: number;
  total_commits: number;
  accepted_commits: number;
  rejected_commits: number;
  auto_mode: boolean;
  rejection_rate: number;
  message_tone: string;
  preferred_commit_size: number;
  avg_commit_interval: number;
  edited_messages: number;
  activity_log: ActivityEntry[];
}

export interface ActivityEntry {
  time: string;
  message: string;
  level: string;
}

export interface CommitLog {
  commits: CommitEntry[];
  activity: ActivityEntry[];
}

export interface CommitEntry {
  hash: string;
  message: string;
  author: string;
  time: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  is_gitmind: boolean;
}

export interface CommandResponse {
  status: string;
  message?: string;
  hash?: string;
  interval?: number;
  auto_mode?: boolean;
  tone?: string;
}

export interface StatsResponse {
  total_commits: number;
  accepted_commits: number;
  rejected_commits: number;
  acceptance_rate: number;
  rejection_rate: number;
  auto_mode: boolean;
  message_tone: string;
  streak_days: number;
  pending_changes: number;
  watcher_active: boolean;
  scheduler_running: boolean;
  cache: {
    size: number;
    capacity: number;
    hits: number;
    misses: number;
    hit_rate: number;
  };
}

// ─── SSE event shapes ────────────────────────────────────────────────────────

export interface SSEUpdatePayload {
  running: boolean;
  paused: boolean;
  next_commit_in: number;
  last_commit: string | null;
  last_commit_hash: string | null;
  last_commit_time: string | null;
  streak_days: number;
  auto_mode: boolean;
  watcher_active: boolean;
  pending_push: boolean;
}

export interface SSEHeartbeat {
  ts: string;
}

// ─── AgentClient ─────────────────────────────────────────────────────────────

export class AgentClient {
  private _baseUrl = '';

  /** Called by ProcessManager.on('ready') */
  setPort(port: number): void {
    this._baseUrl = `http://127.0.0.1:${port}`;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
    timeoutMs = 8_000
  ): Promise<T> {
    if (!this._baseUrl) {
      throw new Error('Agent not ready — baseUrl not set');
    }

    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${this._baseUrl}${path}`, opts);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Public endpoints ──────────────────────────────────────────────────────

  health = () =>
    this.request<{ status: string; version: string }>('GET', '/health');

  status = () =>
    this.request<AgentStatus>('GET', '/status');

  stats = () =>
    this.request<StatsResponse>('GET', '/stats');

  log = () =>
    this.request<CommitLog>('GET', '/log');

  start = (path: string, interval: number) =>
    this.request<CommandResponse>('POST', '/command', { action: 'start', path, interval });

  stop = () =>
    this.request<CommandResponse>('POST', '/command', { action: 'stop' });

  pause = () =>
    this.request<CommandResponse>('POST', '/command', { action: 'pause' });

  commitNow = () =>
    this.request<CommandResponse>('POST', '/command', { action: 'commit_now' });

  push = () =>
    this.request<CommandResponse>('POST', '/command', { action: 'push' });

  clearCache = () =>
    this.request<CommandResponse>('POST', '/command', { action: 'clear_cache' });

  setTone = (tone: string) =>
    this.request<CommandResponse>('POST', '/command', { action: 'set_tone', tone });

  toggleAutoMode = () =>
    this.request<CommandResponse>('POST', '/command', { action: 'toggle_auto_mode' });

  setInterval = (interval: number) =>
    this.request<CommandResponse>('POST', '/command', { action: 'set_interval', interval });

  amend = () =>
    this.request<{ status: string; amended_count?: number; message?: string }>('POST', '/amend');

  cacheStats = () =>
    this.request<{ status: string; cache: StatsResponse['cache'] }>('GET', '/cache/stats');

  cacheClear = () =>
    this.request<{ status: string }>('POST', '/cache/clear');

  resetMemory = () =>
    this.request<{ status: string; message: string }>('POST', '/reset', { confirm: true });

  feedback = (
    action: 'accepted' | 'rejected' | 'edited',
    commitId: string,
    editedMessage?: string
  ) =>
    this.request<{ status: string }>('POST', '/feedback', {
      action,
      commit_id: commitId,
      edited_message: editedMessage ?? '',
    });

  feedbackProfile = () =>
    this.request<{
      total_commits: number;
      accepted_commits: number;
      rejected_commits: number;
      rejection_rate: number;
      auto_mode: boolean;
      message_tone: string;
      streak_days: number;
    }>('GET', '/feedback/profile');

  async isReachable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }
}

// ─── AgentEventStream ─────────────────────────────────────────────────────────
//
// Replaces the 3-second setInterval polling.
// Connects to GET /stream (SSE), emits typed events.
// On disconnect, reconnects with capped exponential back-off.

export type StreamEvent =
  | { type: 'update'; data: SSEUpdatePayload }
  | { type: 'commit'; data: SSEUpdatePayload }
  | { type: 'heartbeat'; data: SSEHeartbeat }
  | { type: 'error'; data: { error: string } }
  | { type: 'connected' }
  | { type: 'disconnected' };

export class AgentEventStream extends EventEmitter {
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private stopped = false;

  constructor(private readonly client: AgentClient) {
    super();
  }

  /** Start streaming. Call once after ProcessManager emits 'ready'. */
  connect(): void {
    this.stopped = false;
    this._connect();
  }

  /** Stop streaming permanently (called on deactivate). */
  disconnect(): void {
    this.stopped = true;
    this._cancelReconnect();
    this.controller?.abort();
    this.controller = null;
  }

  private async _connect(): Promise<void> {
    if (this.stopped || !this.client.baseUrl) {
      return;
    }

    this.controller = new AbortController();
    const url = `${this.client.baseUrl}/stream`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: this.controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: HTTP ${res.status}`);
      }

      this.reconnectDelay = 1_000; // reset on successful connect
      this.emit('event', { type: 'connected' } satisfies StreamEvent);

      await this._readStream(res.body);
    } catch (err: unknown) {
      if (this.stopped) {
        return;
      }
      const isAbort =
        err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        this.emit('event', { type: 'disconnected' } satisfies StreamEvent);
        this._scheduleReconnect();
      }
    }
  }

  private async _readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buf += decoder.decode(value, { stream: true });
        const messages = buf.split('\n\n');
        buf = messages.pop() ?? '';

        for (const msg of messages) {
          this._parseSSEMessage(msg);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended cleanly — reconnect
    if (!this.stopped) {
      this._scheduleReconnect();
    }
  }

  private _parseSSEMessage(raw: string): void {
    let eventType = 'update';
    let dataStr = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataStr = line.slice(5).trim();
      }
    }

    if (!dataStr) {
      return;
    }

    try {
      const data = JSON.parse(dataStr);
      switch (eventType) {
        case 'update':
          this.emit('event', { type: 'update', data } satisfies StreamEvent);
          break;
        case 'commit':
          this.emit('event', { type: 'commit', data } satisfies StreamEvent);
          break;
        case 'heartbeat':
          this.emit('event', { type: 'heartbeat', data } satisfies StreamEvent);
          break;
        case 'error':
          this.emit('event', { type: 'error', data } satisfies StreamEvent);
          break;
      }
    } catch {
      // Malformed JSON — silently skip
    }
  }

  private _scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    this._cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.MAX_RECONNECT_DELAY
      );
      this._connect();
    }, this.reconnectDelay);
  }

  private _cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ─── Singleton exports ────────────────────────────────────────────────────────
// extension.ts imports these and calls setPort() once ProcessManager is ready.

export const agentClient = new AgentClient();
export const agentEventStream = new AgentEventStream(agentClient);
