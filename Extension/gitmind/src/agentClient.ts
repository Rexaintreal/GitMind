import { EventEmitter } from 'events';

/* ───────── TYPES ───────── */

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
  pending_changes: number;
}

export interface AgentStatus {
  running: boolean;
  paused: boolean;
  next_commit_in: number;
  last_commit: string | null;
  last_commit_hash: string | null;
  last_commit_time: string | null;
  last_command: string | null;
  streak_days: number;
  auto_mode: boolean;
  watcher_active: boolean;
  pending_push: boolean;
  pending_changes: number;
  repo_path: string;
}

export interface CommitEntry {
  hash: string;
  message: string;
  time: string;
  is_gitmind: boolean;
  insertions: number;
  deletions: number;
}

export interface ActivityEntry {
  time: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface SSEHeartbeat {
  ts: string;
}

export type StreamEvent =
  | { type: 'update'; data: SSEUpdatePayload }
  | { type: 'commit'; data: SSEUpdatePayload }
  | { type: 'heartbeat'; data: SSEHeartbeat }
  | { type: 'error'; data: { error: string } }
  | { type: 'connected' }
  | { type: 'disconnected' };

/* ───────── STRONGLY TYPED EVENTS ───────── */

type AgentStreamEvents = {
  event: (ev: StreamEvent) => void;
};

/* ───────── HTTP CLIENT ───────── */

class AgentClient {
  baseUrl = '';

  setPort(port: number): void {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  private async _fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // All control actions go through POST /command with { action, ...params }
  private _cmd<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    return this._fetch<T>('/command', {
      method: 'POST',
      body: JSON.stringify({ action, ...params }),
    });
  }

  status(): Promise<AgentStatus> {
    return this._fetch<AgentStatus>('/status');
  }

  start(path: string, interval: number): Promise<{ status: string }> {
    return this._cmd('start', { path, interval });
  }

  stop(): Promise<{ status: string }> {
    return this._cmd('stop');
  }

  pause(): Promise<{ status: string }> {
    return this._cmd('pause');
  }

  commitNow(): Promise<{ status: string; hash?: string; message?: string }> {
    return this._cmd('commit_now');
  }

  push(): Promise<{ status: string; message?: string }> {
    return this._cmd('push');
  }

  toggleAutoMode(): Promise<{ auto_mode: boolean }> {
    return this._cmd('toggle_auto_mode');
  }

  setTone(tone: string): Promise<{ status: string }> {
    return this._cmd('set_tone', { tone });
  }

  amend(): Promise<{ status: string; message?: string }> {
    return this._fetch('/amend', { method: 'POST' });
  }

  clearCache(): Promise<{ status: string }> {
    return this._cmd('clear_cache');
  }

  resetMemory(): Promise<{ status: string; message: string }> {
    return this._fetch('/reset', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
  }

  log(): Promise<{ commits: CommitEntry[]; activity: ActivityEntry[] }> {
    return this._fetch('/log');
  }

  stats(): Promise<{
    total_commits: number;
    accepted_commits: number;
    rejected_commits: number;
    acceptance_rate: number;
    streak_days: number;
    cache: { hits: number; hit_rate: number };
  }> {
    return this._fetch('/stats');
  }
}

/* ───────── EVENT STREAM ───────── */

export class AgentEventStream extends EventEmitter {
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly MAX_RECONNECT_DELAY = 30000;
  private stopped = false;

  constructor(private readonly client: AgentClient) {
    super();
  }

  emit<K extends keyof AgentStreamEvents>(
    event: K,
    ...args: Parameters<AgentStreamEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof AgentStreamEvents>(
    event: K,
    listener: AgentStreamEvents[K]
  ): this {
    return super.on(event, listener);
  }

  connect(): void {
    this.stopped = false;
    this._connect();
  }

  disconnect(): void {
    this.stopped = true;
    this._cancelReconnect();
    this.controller?.abort();
    this.controller = null;
  }

  private async _connect(): Promise<void> {
    if (this.stopped || !this.client.baseUrl) { return; }

    this.controller = new AbortController();

    try {
      const res = await fetch(`${this.client.baseUrl}/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal,
      });

      if (!res.body) { throw new Error('No stream'); }

      this.emit('event', { type: 'connected' });

      await this._readStream(res.body);
    } catch {
      if (!this.stopped) {
        this.emit('event', { type: 'disconnected' });
        this._scheduleReconnect();
      }
    }
  }

  private async _readStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buf += decoder.decode(value, { stream: true });

      const messages = buf.split('\n\n');
      buf = messages.pop() ?? '';

      for (const msg of messages) {
        this._parse(msg);
      }
    }
  }

  private _parse(raw: string) {
    let eventType = 'update';
    let dataStr = '';

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) { eventType = line.slice(6).trim(); }
      if (line.startsWith('data:')) { dataStr = line.slice(5).trim(); }
    }

    if (!dataStr) { return; }

    try {
      const data = JSON.parse(dataStr);
      this.emit('event', { type: eventType as StreamEvent['type'], data });
    } catch {
      // Ignore malformed SSE frames
    }
  }

  private _scheduleReconnect() {
    this._cancelReconnect();
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.MAX_RECONNECT_DELAY);
    this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectDelay);
  }

  private _cancelReconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
    this.reconnectTimer = null;
  }
}

/* ───────── SINGLETONS ───────── */

export const agentClient = new AgentClient();
export const agentEventStream = new AgentEventStream(agentClient);
