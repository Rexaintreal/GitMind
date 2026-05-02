"""
GitMind Agent — Real-time File System Watcher (Phase 5)
Uses Watchdog to monitor the repo for file changes.
Debounces events, updates pending_changes, and detects bursts
to accelerate the commit scheduler.
"""

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent
import logging
import threading
import time
import pathlib
import fnmatch
from state_utils import state, log_activity, write_status_file, _lock
from git_ops import get_git_ops

logger = logging.getLogger("gitmind.watcher")

# ─── CONSTANTS ───────────────────────────────────────────────────────────────

# Patterns to completely ignore — never update state for these
IGNORE_PATTERNS = [
    "*.pyc",
    "__pycache__",
    ".git",
    ".gitmind",
    "*.swp",
    "*.swo",
    "*~",
    ".DS_Store",
    "Thumbs.db",
    "node_modules",
    "*.egg-info",
    ".pytest_cache",
    "dist",
    "build",
    ".venv",
    "venv",
    "*.log",
]

# Debounce window: wait this many seconds after the last event
# before processing. Prevents 200 state updates for one file save.
DEBOUNCE_SECONDS = 1.5

# Burst threshold: if pending_changes exceeds this, nudge the
# scheduler to commit sooner (halve the remaining countdown)
BURST_THRESHOLD = 8


# ─── HELPERS ──────────────────────────────────────────────────────────────────


def should_ignore(path: str) -> bool:
    """Returns True if this path matches any IGNORE_PATTERN.
    Check all path components, not just the filename."""
    parts = pathlib.Path(path).parts
    for pattern in IGNORE_PATTERNS:
        for part in parts:
            if fnmatch.fnmatch(part, pattern):
                return True
    return False


# ─── WATCHDOG EVENT HANDLER ──────────────────────────────────────────────────


class GitMindEventHandler(FileSystemEventHandler):
    """Handles Watchdog file system events with debouncing."""

    def __init__(self):
        super().__init__()
        self._debounce_timer: threading.Timer = None
        self._pending_events: list = []
        self._timer_lock = threading.Lock()

    def on_any_event(self, event: FileSystemEvent):
        """Called by Watchdog on every file system event."""
        # Skip directories (only care about file changes)
        if event.is_directory:
            return

        # Skip ignored paths
        src = getattr(event, "src_path", "")
        dest = getattr(event, "dest_path", "")
        if should_ignore(src) or (dest and should_ignore(dest)):
            return

        # Skip synthetic events (Watchdog emits these internally)
        if event.event_type not in (
            "created", "modified", "deleted", "moved"
        ):
            return

        logger.debug(f"FS event: {event.event_type} → {src}")

        # Add to pending events list
        with self._timer_lock:
            self._pending_events.append({
                "type": event.event_type,
                "path": src,
                "dest": dest if event.event_type == "moved" else None
            })

            # Cancel existing debounce timer and restart it
            if self._debounce_timer is not None:
                self._debounce_timer.cancel()
            self._debounce_timer = threading.Timer(
                DEBOUNCE_SECONDS,
                self._flush_events
            )
            self._debounce_timer.daemon = True
            self._debounce_timer.start()

    def _flush_events(self):
        """Called after the debounce window expires. Processes all
        buffered events in a single batch update to state."""
        with self._timer_lock:
            events = self._pending_events.copy()
            self._pending_events.clear()

        if not events:
            return

        # Get real pending count from git (authoritative source)
        with _lock:
            repo_path = state["repo_path"]
            running = state["running"]
            paused = state["paused"]

        if not running or paused:
            return

        try:
            ops = get_git_ops(repo_path)
            pending = ops.get_pending_count() if ops.is_valid() else 0
        except Exception as e:
            logger.error(f"_flush_events git count failed: {e}")
            pending = len(events)   # rough fallback

        # Summarise what changed for the activity log
        types_seen = list(dict.fromkeys(e["type"] for e in events))
        changed_files = list(dict.fromkeys(
            pathlib.Path(e["path"]).name
            for e in events
            if e["path"]
        ))
        summary_files = (
            ", ".join(changed_files[:3])
            + (f" (+{len(changed_files)-3} more)" if len(changed_files) > 3 else "")
        )
        summary = (
            f"FS change: {', '.join(types_seen)} — {summary_files}"
        )

        with _lock:
            old_pending = state["pending_changes"]
            state["pending_changes"] = pending

            # Burst detection: if crossing BURST_THRESHOLD for the
            # first time, halve the countdown to commit sooner
            crossed_burst = (
                old_pending < BURST_THRESHOLD
                and pending >= BURST_THRESHOLD
                and state["next_commit_in"] > 0
            )
            if crossed_burst:
                state["next_commit_in"] = max(
                    10,
                    state["next_commit_in"] // 2
                )

        log_activity(summary)

        if crossed_burst:
            log_activity(
                f"Burst detected ({pending} pending files) — "
                f"commit accelerated",
                "warning"
            )

        # Write status file so VS Code extension sees fresh data
        # even between /status polls
        write_status_file()

        logger.info(
            f"Watcher batch: {len(events)} event(s), "
            f"{pending} pending files"
            + (" [BURST — countdown halved]" if crossed_burst else "")
        )


# ─── MODULE-LEVEL OBSERVER INSTANCE ──────────────────────────────────────────

_observer: Observer = None


# ─── WATCHER LIFECYCLE ───────────────────────────────────────────────────────


def start_watcher(repo_path: str) -> Observer:
    """Creates, configures, and starts the Watchdog Observer.
    Returns the Observer instance.
    If a watcher is already running for the same path, stop the old
    one before creating a new one."""
    global _observer

    # Stop existing observer if running
    stop_watcher()

    resolved_path = str(pathlib.Path(repo_path).resolve())

    # Confirm the path exists before watching
    if not pathlib.Path(resolved_path).exists():
        logger.error(f"start_watcher: path does not exist: {resolved_path}")
        return None

    event_handler = GitMindEventHandler()
    _observer = Observer()
    _observer.schedule(
        event_handler,
        path=resolved_path,
        recursive=True          # watch all subdirectories
    )
    _observer.daemon = True     # dies when main thread exits
    
    try:
        _observer.start()
    except PermissionError as e:
        logger.error(f"Watcher permission denied: {e}")
        _observer = None
        return None

    logger.info(f"Watcher started: watching {resolved_path} recursively")
    log_activity(f"File watcher active: {resolved_path}")
    return _observer


def stop_watcher() -> None:
    """Stops the Watchdog Observer gracefully.
    Safe to call even if watcher is not running."""
    global _observer
    try:
        if _observer is not None and _observer.is_alive():
            _observer.stop()
            _observer.join(timeout=3)
            logger.info("Watcher stopped")
    except Exception as e:
        logger.error(f"stop_watcher error: {e}")
    finally:
        _observer = None


def is_watching() -> bool:
    """Returns True if the observer is currently running."""
    return _observer is not None and _observer.is_alive()


def get_watcher_status() -> dict:
    """Returns a status dict for inclusion in /status responses."""
    # Health check for crashed watchers
    if _observer and not _observer.is_alive():
        logger.warning("Watcher thread died — marking inactive")

    return {
        "active": is_watching(),
        "observer": str(_observer) if _observer else None
    }
