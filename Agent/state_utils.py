"""
GitMind Agent — Shared State & Helpers (Phase 4)
Extracted from main.py to break circular imports between
main.py and scheduler.py. Both import state and helpers from here.
"""

import os
import json
import datetime
import pathlib
import logging
import threading
from persistence import restore_into, save as persist_save

logger = logging.getLogger("gitmind")

# ─── THREADING LOCK ──────────────────────────────────────────────────────────
# Acquired before reading OR writing any key in the shared state dict
# from scheduler threads. Prevents race conditions between the scheduler
# background thread and Flask's request-handling thread.

_lock = threading.Lock()

# ─── GLOBAL STATE ────────────────────────────────────────────────────────────
# The VS Code extension polls /status and reads every key by name.

state = {
    # Core runtime
    "running": False,
    "paused": False,
    "watcher_active": False,
    "repo_path": os.getenv("REPO_PATH", "."),
    "commit_interval": int(os.getenv("COMMIT_INTERVAL", 300)),

    # Commit countdown (VS Code status bar reads this)
    "next_commit_in": 0,

    # Last commit info (VS Code sidebar reads these)
    "last_commit": None,
    "last_commit_time": None,
    "last_commit_hash": None,
    "pending_push": False,

    # Terminal echo (VS Code terminal panel reads this)
    "last_command": None,

    # Change tracking (VS Code sidebar pending badge reads this)
    "pending_changes": 0,

    # Gamification
    "streak_days": 0,

    # Learning / memory layer
    "total_commits": 0,
    "accepted_commits": 0,
    "rejected_commits": 0,
    "auto_mode": True,
    "rejection_rate": 0.0,
    "message_tone": "conventional",
    "preferred_commit_size": 5,
    "avg_commit_interval": 1800,
    "edited_messages": 0,

    # Activity feed (VS Code sidebar activity list reads this)
    "activity_log": [],
}

def boot_restore() -> bool:
    """
    Called once at server startup.
    Attempts to restore persisted memory into the live state dict.
    Returns True if previous memory was found and loaded.
    """
    repo_path = state.get("repo_path", ".")
    restored  = restore_into(state, repo_path)
    if restored:
        logger.info(
            f"Boot restore: auto_mode={state['auto_mode']}, "
            f"total_commits={state['total_commits']}, "
            f"streak_days={state['streak_days']}, "
            f"rejection_rate={state['rejection_rate']}"
        )
    return restored


# ─── HELPERS ──────────────────────────────────────────────────────────────────


def log_activity(message: str, level: str = "info"):
    """Append an entry to the in-memory activity feed and log it."""
    entry = {
        "time": datetime.datetime.now().isoformat(),
        "message": message,
        "level": level,
    }
    state["activity_log"].insert(0, entry)
    if len(state["activity_log"]) > 50:
        state["activity_log"] = state["activity_log"][:50]
    getattr(logger, level, logger.info)(message)


def write_status_file():
    """Persist the current state to .gitmind/status.json inside the repo."""
    try:
        gitmind_dir = pathlib.Path(state["repo_path"]) / ".gitmind"
        gitmind_dir.mkdir(parents=True, exist_ok=True)
        status_path = gitmind_dir / "status.json"
        with open(status_path, "w") as f:
            json.dump(state, f, indent=2, default=str)
        logger.debug(f"Status written to {status_path}")
        
        # Also persist the memory slice so restarts remember state
        persist_save(state, state["repo_path"])
    
    except Exception as e:
        logger.error(f"write_status_file failed: {e}")
