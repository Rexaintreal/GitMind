/**
 * processManager.ts
 *
 * Owns the Python subprocess lifecycle.
 * - Finds python3/python on PATH (or a bundled interpreter)
 * - Allocates a free port (avoids 7432 conflicts on multi-instance VS Code)
 * - Spawns main.py with correct CWD and env
 * - Probes /health with exponential back-off until ready
 * - Restarts on unexpected crash (up to MAX_RESTARTS)
 * - Tears down cleanly on deactivate / SIGTERM
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProcessState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'crashed'
  | 'restarting';

export interface ProcessManagerEvents {
  stateChange: (state: ProcessState) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  ready: (port: number) => void;
  crashed: (code: number | null, restartIn: number) => void;
  fatalError: (reason: string) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HEALTH_PROBE_INITIAL_MS = 300;
const HEALTH_PROBE_MAX_MS = 4_000;
const HEALTH_PROBE_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 5;
const RESTART_BACKOFF_BASE_MS = 2_000;

// ─── ProcessManager ──────────────────────────────────────────────────────────

export class ProcessManager extends EventEmitter {
  private proc: cp.ChildProcess | null = null;
  private _port = 0;
  private _state: ProcessState = 'stopped';
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;
  private readonly agentDir: string;
  private readonly outputChannel: vscode.OutputChannel;

  constructor(
    private readonly extensionPath: string,
    outputChannel: vscode.OutputChannel
  ) {
    super();
    this.outputChannel = outputChannel;
    // Agent folder sits at <extension_root>/../../Agent relative to the
    // bundled extension. In development it's a sibling of Extension/gitmind.
    this.agentDir = this.resolveAgentDir();
  }

  get port(): number {
    return this._port;
  }

  get state(): ProcessState {
    return this._state;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._state === 'ready' || this._state === 'starting') {
      return;
    }
    this.intentionalStop = false;
    this.restartCount = 0;
    await this._launch();
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this._clearTimers();
    await this._kill();
    this._setState('stopped');
  }

  async restart(): Promise<void> {
    // Suppress the auto-restart in _onExit while we do a manual restart.
    // Without this, _onExit fires during _kill() and schedules its own _launch(),
    // resulting in two concurrent processes.
    this.intentionalStop = true;
    this._clearTimers();
    await this._kill();
    this.intentionalStop = false;
    this.restartCount = 0;
    await this._launch();
  }

  // ─── Core launch ───────────────────────────────────────────────────────────

  private async _launch(): Promise<void> {
    this._setState('starting');

    const python = await this._resolvePython();
    if (!python) {
      const msg =
        'GitMind: Python 3 not found. ' +
        'Install Python 3.9+ and ensure it is on your PATH.';
      this.emit('fatalError', msg);
      this._setState('crashed');
      return;
    }

    // Verify requirements are installed; install if not (silent, non-blocking)
    this._ensureDependencies(python);

    this._port = await this._findFreePort();
    this.log(`Spawning agent on port ${this._port} (python: ${python})`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      // Force UTF-8 I/O on Windows -- prevents cp1252 UnicodeEncodeError
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    };

    // Load .env from Agent dir if present — lets the bundled agent find its API key
    const dotenvPath = path.join(this.agentDir, '.env');
    if (fs.existsSync(dotenvPath)) {
      env['GITMIND_DOTENV'] = dotenvPath;
    }

    this.proc = cp.spawn(
      python,
      ['main.py', 'start', '--port', String(this._port), '--path', this._workspacePath()],
      {
        cwd: this.agentDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached=false: child dies when extension host dies — intentional
        detached: false,
      }
    );

    this._attachStdio(this.proc);

    this.proc.on('exit', (code, signal) => this._onExit(code, signal));
    this.proc.on('error', (err) => {
      this.log(`Process error: ${err.message}`, 'error');
      this.emit('fatalError', `Failed to start agent process: ${err.message}`);
      this._setState('crashed');
    });

    await this._probeUntilReady();
  }

  // ─── Health probing ────────────────────────────────────────────────────────

  private _probeUntilReady(): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      let delay = HEALTH_PROBE_INITIAL_MS;

      const probe = async () => {
        if (this.intentionalStop) {
          resolve();
          return;
        }
        if (Date.now() - start > HEALTH_PROBE_TIMEOUT_MS) {
          this.log('Health probe timed out after 30s', 'error');
          this.emit('fatalError', 'Agent did not become ready within 30 seconds.');
          this._setState('crashed');
          resolve();
          return;
        }

        try {
          const res = await fetch(`http://127.0.0.1:${this._port}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (res.ok) {
            this._setState('ready');
            this.restartCount = 0;
            this.emit('ready', this._port);
            this.log(`Agent ready on port ${this._port}`);
            resolve();
            return;
          }
        } catch {
          // Not ready yet — expected during startup
        }

        delay = Math.min(delay * 1.5, HEALTH_PROBE_MAX_MS);
        this.probeTimer = setTimeout(probe, delay);
      };

      probe();
    });
  }

  // ─── Process exit / restart ────────────────────────────────────────────────

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.proc = null;

    if (this.intentionalStop) {
      return;
    }

    this.log(
      `Agent exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
      'warn'
    );

    if (this.restartCount >= MAX_RESTARTS) {
      const msg = `Agent crashed ${MAX_RESTARTS} times. Giving up. Check the GitMind output panel.`;
      this.log(msg, 'error');
      this.emit('fatalError', msg);
      this._setState('crashed');
      return;
    }

    this.restartCount += 1;
    const backoff = RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartCount - 1);
    this.log(`Restarting in ${backoff}ms (attempt ${this.restartCount}/${MAX_RESTARTS})`);
    this._setState('restarting');
    this.emit('crashed', code, backoff);

    this.restartTimer = setTimeout(() => this._launch(), backoff);
  }

  // ─── Stdio attachment ──────────────────────────────────────────────────────

  private _attachStdio(proc: cp.ChildProcess): void {
    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          this.log(line);
          this.emit('stdout', line);
        }
      }
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          this.log(line, 'warn');
          this.emit('stderr', line);
        }
      }
    });
  }

  // ─── Kill ──────────────────────────────────────────────────────────────────

  private _kill(): Promise<void> {
    this._clearTimers();
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 3_000);

      this.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });

      // Try graceful shutdown first — Flask honours SIGTERM
      this.proc.kill('SIGTERM');
    });
  }

  // ─── Python resolution ────────────────────────────────────────────────────

  private async _resolvePython(): Promise<string | null> {
    // 1. User override from settings
    const configured = vscode.workspace
      .getConfiguration('gitmind')
      .get<string>('pythonPath', '');
    if (configured && (await this._canRun(configured))) {
      return configured;
    }

    // 2. VS Code Python extension selected interpreter
    const pyExt = vscode.extensions.getExtension('ms-python.python');
    if (pyExt) {
      const api = pyExt.isActive ? pyExt.exports : await pyExt.activate();
      const envPath: string | undefined =
        api?.environments?.getActiveEnvironmentPath?.()?.path;
      if (envPath && (await this._canRun(envPath))) {
        return envPath;
      }
    }

    // 3. PATH candidates
    const candidates = process.platform === 'win32'
      ? ['python', 'python3', 'py']
      : ['python3', 'python'];

    for (const candidate of candidates) {
      if (await this._canRun(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private _canRun(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
      cp.exec(`"${bin}" --version`, (err) => resolve(!err));
    });
  }

  // ─── Dependency installer (best-effort, async, non-blocking) ──────────────

  private _ensureDependencies(python: string): void {
    const reqFile = path.join(this.agentDir, 'requirements.txt');
    if (!fs.existsSync(reqFile)) {
      return;
    }

    // Stamp file so we only install once per requirements.txt mtime
    const stampDir = path.join(this.extensionPath, '.dep-stamps');
    fs.mkdirSync(stampDir, { recursive: true });
    const reqMtime = fs.statSync(reqFile).mtimeMs.toString();
    const stampFile = path.join(stampDir, 'installed.txt');

    if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === reqMtime) {
      return; // already installed for this requirements.txt
    }

    this.log('Installing Python dependencies (background)…');
    const install = cp.spawn(
      python,
      ['-m', 'pip', 'install', '-q', '-r', reqFile],
      { cwd: this.agentDir, stdio: 'pipe' }
    );

    install.on('exit', (code) => {
      if (code === 0) {
        fs.writeFileSync(stampFile, reqMtime);
        this.log('Python dependencies installed.');
      } else {
        this.log('pip install exited non-zero — some deps may be missing', 'warn');
      }
    });
  }

  // ─── Port finder ──────────────────────────────────────────────────────────

  private _findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        server.close(() => {
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            reject(new Error('Could not determine free port'));
          }
        });
      });
    });
  }

  // ─── Agent dir resolution ─────────────────────────────────────────────────

  private resolveAgentDir(): string {
    // Production (bundled): agent/ is copied next to extension manifest
    const bundled = path.join(this.extensionPath, 'agent');
    if (fs.existsSync(path.join(bundled, 'main.py'))) {
      return bundled;
    }
    // Development: Extension/gitmind/ → ../../Agent
    const dev = path.resolve(this.extensionPath, '..', '..', 'Agent');
    if (fs.existsSync(path.join(dev, 'main.py'))) {
      return dev;
    }
    throw new Error(
      `GitMind: Cannot locate Agent/main.py.\n` +
      `Checked:\n  ${bundled}\n  ${dev}\n` +
      `Set gitmind.agentDir in settings to override.`
    );
  }

  private _workspacePath(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : '.';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private _setState(s: ProcessState): void {
    if (this._state !== s) {
      this._state = s;
      this.emit('stateChange', s);
    }
  }

  private _clearTimers(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN] ' : '[INFO] ';
    this.outputChannel.appendLine(`${prefix} ${msg}`);
  }
}
