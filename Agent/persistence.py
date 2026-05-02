import json, pathlib, logging, datetime
from typing import Optional

logger = logging.getLogger("gitmind.persistence")

MEMORY_FILENAME = "memory.json"

PERSISTENT_KEYS = [
    "total_commits",
    "accepted_commits",
    "rejected_commits",
    "rejection_rate",
    "auto_mode",
    "message_tone",
    "preferred_commit_size",
    "avg_commit_interval",
    "streak_days",
    "edited_messages",
    "last_commit",
    "last_commit_time",
    "last_commit_hash",
]

def get_memory_path(repo_path: str) -> pathlib.Path:
    return pathlib.Path(repo_path) / ".gitmind" / MEMORY_FILENAME

def save(state: dict, repo_path: str) -> bool:
    try:
        memory_path = get_memory_path(repo_path)
        memory_path.parent.mkdir(parents=True, exist_ok=True)

        snapshot = {
            k: state[k]
            for k in PERSISTENT_KEYS
            if k in state
        }
        snapshot["_saved_at"] = datetime.datetime.now().isoformat()
        snapshot["_version"]  = "1.0"

        with open(memory_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=2, default=str)

        logger.debug(f"State persisted to {memory_path}")
        return True

    except PermissionError as e:
        logger.error(f"persistence.save: permission denied: {e}")
        return False
    except Exception as e:
        logger.error(f"persistence.save failed: {e}")
        return False

def load(repo_path: str) -> Optional[dict]:
    try:
        memory_path = get_memory_path(repo_path)

        if not memory_path.exists():
            logger.info("No persisted memory found — starting fresh")
            return None

        with open(memory_path, "r", encoding="utf-8") as f:
            snapshot = json.load(f)

        version = snapshot.get("_version", "unknown")
        saved_at = snapshot.get("_saved_at", "unknown")
        logger.info(
            f"Loaded persisted memory (v{version}, saved {saved_at})"
        )
        return snapshot

    except json.JSONDecodeError as e:
        logger.warning(
            f"persistence.load: corrupt JSON in memory file: {e}. "
            "Starting fresh."
        )
        return None
    except Exception as e:
        logger.error(f"persistence.load failed: {e}")
        return None

def restore_into(state: dict, repo_path: str) -> bool:
    snapshot = load(repo_path)
    if snapshot is None:
        return False

    restored_keys = []
    for key in PERSISTENT_KEYS:
        if key in snapshot:
            state[key] = snapshot[key]
            restored_keys.append(key)

    logger.info(
        f"Restored {len(restored_keys)} state keys from memory: "
        f"{', '.join(restored_keys)}"
    )
    return True

def clear(repo_path: str) -> bool:
    try:
        memory_path = get_memory_path(repo_path)
        if memory_path.exists():
            memory_path.unlink()
            logger.info(f"Memory file deleted: {memory_path}")
        return True
    except Exception as e:
        logger.error(f"persistence.clear failed: {e}")
        return False

def get_memory_info(repo_path: str) -> dict:
    memory_path = get_memory_path(repo_path)
    if not memory_path.exists():
        return {"exists": False, "path": str(memory_path)}

    try:
        stat = memory_path.stat()
        snapshot = load(repo_path) or {}
        return {
            "exists":    True,
            "path":      str(memory_path),
            "size_bytes": stat.st_size,
            "saved_at":  snapshot.get("_saved_at"),
            "version":   snapshot.get("_version"),
        }
    except Exception:
        return {"exists": True, "path": str(memory_path)}
