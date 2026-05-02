"""
GitMind Agent Brain — Phase 1
Flask-based autonomous Git agent server with full route handling,
decision engine, feedback learning, and Typer CLI.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import os
import json
import datetime
import pathlib
import logging
import sys
import typer
from git_ops import get_git_ops

load_dotenv()

# ─── LOGGING SETUP ───────────────────────────────────────────────────────────

log_formatter = logging.Formatter(
    "[%(asctime)s] [%(levelname)s] %(name)s: %(message)s"
)

console_handler = logging.StreamHandler(sys.stdout)
console_handler.setFormatter(log_formatter)

logger = logging.getLogger("gitmind")
logger.setLevel(logging.INFO)
logger.addHandler(console_handler)

# ─── GLOBAL STATE ────────────────────────────────────────────────────────────
# The VS Code extension polls /status and reads every key by name.

state = {
    # Core runtime
    "running": False,
    "paused": False,
    "repo_path": os.getenv("REPO_PATH", "."),
    "commit_interval": int(os.getenv("COMMIT_INTERVAL", 300)),

    # Commit countdown (VS Code status bar reads this)
    "next_commit_in": 0,

    # Last commit info (VS Code sidebar reads these)
    "last_commit": None,
    "last_commit_time": None,
    "last_commit_hash": None,

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

# ─── FLASK APP SETUP ─────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app, origins="*", supports_credentials=True)

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
    except Exception as e:
        logger.error(f"write_status_file failed: {e}")


def _ts() -> str:
    """Return the current UTC timestamp as an ISO string."""
    return datetime.datetime.now().isoformat()


# ─── ROUTES ───────────────────────────────────────────────────────────────────


@app.route("/health", methods=["GET"])
def health():
    """Health-check endpoint."""
    return jsonify({
        "status": "ok",
        "service": "GitMind Agent Brain",
        "version": "1.0.0",
        "timestamp": _ts(),
    }), 200


@app.route("/status", methods=["GET"])
def status_route():
    """Return the full agent state. Also writes the status file so the
    VS Code extension can fall back to reading the JSON on disk."""
    try:
        try:
            ops = get_git_ops(state["repo_path"])
            state["pending_changes"] = ops.get_pending_count()
            state["streak_days"] = ops.get_streak_days()
            last = ops.get_last_commit_info()
            if last:
                state["last_commit"] = last["message"]
                state["last_commit_time"] = last["time"]
                state["last_commit_hash"] = last["hash"]
        except Exception as e:
            logger.error(f"/status git lookup failed: {e}")

        write_status_file()
        return jsonify(state), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/command", methods=["POST"])
def command():
    """Accept control commands: start, stop, pause, commit_now."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        action = data.get("action", "")
        interval = int(data.get("interval", 300))
        path = data.get("path", ".")

        if action == "start":
            state["running"] = True
            state["paused"] = False
            state["repo_path"] = path
            state["commit_interval"] = interval
            state["next_commit_in"] = interval
            log_activity(
                f"GitMind started. Watching {path}, interval={interval}s"
            )

            # Validate repo immediately on start
            ops = get_git_ops(path)
            if not ops.is_valid():
                log_activity(f"Warning: no git repo at {path}", "warning")
            else:
                state["pending_changes"] = ops.get_pending_count()
                state["streak_days"] = ops.get_streak_days()
                log_activity(
                    f"Git repo valid. {state['pending_changes']} pending changes detected."
                )
            write_status_file()
            return jsonify({
                "status": "started",
                "interval": interval,
                "path": path,
            }), 200

        elif action == "stop":
            state["running"] = False
            state["next_commit_in"] = 0
            log_activity("GitMind stopped.")
            write_status_file()
            return jsonify({"status": "stopped"}), 200

        elif action == "pause":
            state["paused"] = not state["paused"]
            label = "paused" if state["paused"] else "resumed"
            log_activity(f"GitMind {label}.")
            write_status_file()
            return jsonify({"status": label}), 200

        elif action == "commit_now":
            ops = get_git_ops(state["repo_path"])

            if not ops.is_valid():
                log_activity("commit_now: no valid git repo", "warning")
                return jsonify({
                    "status": "error",
                    "message": "No valid git repo",
                }), 400

            if ops.is_clean():
                log_activity("commit_now: nothing to commit")
                return jsonify({
                    "status": "nothing_to_commit",
                    "message": "Working directory is clean",
                }), 200

            # Echo CLI commands to state so VS Code terminal panel can display them
            state["last_command"] = "git add -A"
            if not ops.stage_all():
                return jsonify({
                    "status": "error",
                    "message": "Staging failed",
                }), 500

            commit_msg = "chore: manual commit via GitMind"
            state["last_command"] = f'git commit -m "{commit_msg}"'
            commit_hash = ops.commit(commit_msg)

            if commit_hash:
                state["last_commit"] = commit_msg
                state["last_commit_time"] = _ts()
                state["last_commit_hash"] = commit_hash
                state["total_commits"] += 1
                state["streak_days"] = ops.get_streak_days()
                log_activity(f"Manual commit: {commit_hash} — {commit_msg}")
                write_status_file()
                return jsonify({
                    "status": "committed",
                    "hash": commit_hash,
                    "message": commit_msg,
                }), 200
            else:
                return jsonify({
                    "status": "error",
                    "message": "Commit failed — check logs",
                }), 500

        else:
            return jsonify({
                "error": "Unknown action",
                "valid_actions": ["start", "stop", "pause", "commit_now"],
            }), 400

    except Exception as e:
        logger.error(f"/command error: {e}", exc_info=True)
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/log", methods=["GET"])
def log_route():
    """Return commit history and activity feed."""
    try:
        try:
            ops = get_git_ops(state["repo_path"])
            commits = ops.get_recent_log(n=20)
        except Exception as e:
            logger.error(f"/log git lookup failed: {e}")
            commits = []

        return jsonify({
            "commits": commits,
            "activity": state["activity_log"],
        }), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/analyze", methods=["POST"])
def analyze():
    """Analyze changed files and produce semantic groups (stub in Phase 1)."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        files = data.get("files", [])
        diff = data.get("diff", "")
        time_since = int(data.get("time_since_last_commit", 0))

        if not files or not isinstance(files, list):
            return jsonify({"error": "files must be a non-empty list"}), 400

        group = {
            "id": "grp_stub_001",
            "type": "general",
            "files": files,
            "summary": f"Changes across {len(files)} file(s)",
            "confidence": 0.7,
            "source": "heuristic_stub",
        }

        additions = diff.count("\n+")
        deletions = diff.count("\n-")

        log_activity(f"Analyze called: {len(files)} files")

        return jsonify({
            "status": "success",
            "groups": [group],
            "diff_summary": {
                "total_files": len(files),
                "total_additions": additions,
                "total_deletions": deletions,
                "change_density": round(
                    (additions + deletions) / max(len(files), 1), 2
                ),
            },
            "analyzed_at": _ts(),
        }), 200

    except Exception as e:
        logger.error(f"/analyze error: {e}", exc_info=True)
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/plan", methods=["POST"])
def plan():
    """Build a commit plan from groups (stub messages in Phase 1)."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        files = data.get("files", [])
        diff = data.get("diff", "")
        groups = data.get("groups", [])

        # If no groups provided, build a single stub group from files
        if not groups:
            groups = [{
                "id": "grp_stub_0",
                "type": "general",
                "files": files,
                "summary": "pending analysis",
            }]

        commits = []
        for i, g in enumerate(groups):
            file_list = g.get("files", files)
            label = ", ".join(file_list[:2])
            if len(file_list) > 2:
                label += f" (+{len(file_list) - 2} more)"
            commits.append({
                "id": f"commit_stub_{i + 1:03d}",
                "message": f"{g.get('type', 'chore')}: update {label}",
                "files": file_list,
                "type": g.get("type", "general"),
                "summary": g.get("summary", ""),
                "score": 65.0,
                "confidence": 0.7,
                "confidence_label": "medium",
                "group_id": g.get("id", f"grp_stub_{i}"),
            })

        log_activity(f"Plan created: {len(commits)} commit(s)")

        return jsonify({
            "status": "success",
            "commits": commits,
            "total_commits": len(commits),
            "planned_at": _ts(),
        }), 200

    except Exception as e:
        logger.error(f"/plan error: {e}", exc_info=True)
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/decide", methods=["POST"])
def decide():
    """Full decision engine — determines AUTO_COMMIT, SUGGEST, or WAIT."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        file_count = int(data.get("file_count", 0))
        time_gap = int(data.get("time_gap", 0))
        groups = data.get("groups", [])

        confidences = [g.get("confidence", 0.5) for g in groups]
        avg_confidence = (
            sum(confidences) / len(confidences) if confidences else 0.5
        )

        AUTO_COMMIT_FILES = 10
        AUTO_COMMIT_TIME = 1200
        SUGGEST_FILES = 3

        if not state["auto_mode"]:
            action = "SUGGEST"
            reason = "Auto mode disabled by user preference"

        elif state["rejection_rate"] > 0.5:
            action = "SUGGEST"
            reason = "High rejection rate — requesting user confirmation"

        elif (
            file_count >= AUTO_COMMIT_FILES and time_gap >= AUTO_COMMIT_TIME
        ):
            action = "AUTO_COMMIT"
            reason = (
                f"Large changeset ({file_count} files) "
                f"with long inactivity ({time_gap}s)"
            )

        elif file_count >= SUGGEST_FILES or time_gap >= 600:
            action = "SUGGEST"
            reason = "Moderate changes detected — suggesting commit for review"

        else:
            action = "WAIT"
            reason = "Insufficient changes to warrant a commit"

        log_activity(f"Decision: {action} — {reason}")

        return jsonify({
            "action": action,
            "reason": reason,
            "metadata": {
                "file_count": file_count,
                "time_gap": time_gap,
                "avg_confidence": round(avg_confidence, 3),
                "auto_mode": state["auto_mode"],
                "rejection_rate": state["rejection_rate"],
            },
            "decided_at": _ts(),
        }), 200

    except Exception as e:
        logger.error(f"/decide error: {e}", exc_info=True)
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/feedback", methods=["POST"])
def feedback():
    """Record user feedback and update the learning/memory layer."""
    try:
        data = request.get_json(force=True, silent=True) or {}
        action = data.get("action", "")
        commit_id = data.get("commit_id", "")
        original_message = data.get("original_message", "")
        edited_message = data.get("edited_message", "")

        if action not in ("accepted", "rejected", "edited"):
            return jsonify({
                "error": "action must be accepted, rejected, or edited",
            }), 400

        state["total_commits"] += 1

        if action == "accepted":
            state["accepted_commits"] += 1
            log_activity(f"Commit accepted: {commit_id}")

        elif action == "rejected":
            state["rejected_commits"] += 1
            log_activity(f"Commit rejected: {commit_id}", "warning")
            # Recalculate early so the threshold check below is current
            total = state["total_commits"]
            if total > 0:
                state["rejection_rate"] = round(
                    state["rejected_commits"] / total, 3
                )
            if state["rejection_rate"] > 0.6:
                state["auto_mode"] = False
                log_activity(
                    "Auto mode disabled — rejection rate too high", "warning"
                )

        elif action == "edited":
            state["edited_messages"] += 1
            if state["edited_messages"] > 5:
                state["message_tone"] = "detailed"
            log_activity(
                f"Message edited: {original_message!r} → {edited_message!r}"
            )

        # Recalculate rejection rate (final, covers all branches)
        total = state["total_commits"]
        if total > 0:
            state["rejection_rate"] = round(
                state["rejected_commits"] / total, 3
            )

        write_status_file()

        return jsonify({
            "status": "success",
            "message": "Feedback recorded. GitMind is learning.",
            "updated_profile": {
                "auto_mode": state["auto_mode"],
                "rejection_rate": state["rejection_rate"],
                "message_tone": state["message_tone"],
                "total_commits": state["total_commits"],
            },
        }), 200

    except Exception as e:
        logger.error(f"/feedback error: {e}", exc_info=True)
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/feedback/profile", methods=["GET"])
def feedback_profile():
    """Return the full learning/memory profile."""
    try:
        return jsonify({
            "total_commits": state["total_commits"],
            "accepted_commits": state["accepted_commits"],
            "rejected_commits": state["rejected_commits"],
            "rejection_rate": state["rejection_rate"],
            "auto_mode": state["auto_mode"],
            "message_tone": state["message_tone"],
            "preferred_commit_size": state["preferred_commit_size"],
            "streak_days": state["streak_days"],
        }), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


# ─── FLASK ERROR HANDLERS ────────────────────────────────────────────────────


@app.errorhandler(404)
def not_found(e):
    return jsonify({
        "status": "error",
        "error": "Not found",
        "code": 404,
    }), 404


@app.errorhandler(500)
def server_error(e):
    return jsonify({
        "status": "error",
        "error": str(e),
        "code": 500,
    }), 500


# ─── TYPER CLI ────────────────────────────────────────────────────────────────

cli = typer.Typer(help="GitMind Agent Brain — autonomous Git intelligence.")


@cli.command()
def start(
    path: str = typer.Option(".", "--path", help="Path to git repo"),
    time: int = typer.Option(300, "--time", help="Commit interval in seconds"),
    port: int = typer.Option(7432, "--port", help="Server port"),
    verbose: bool = typer.Option(False, "--verbose", help="Enable DEBUG logging"),
):
    """Start the GitMind Agent Brain server."""
    if verbose:
        logging.getLogger().setLevel(logging.DEBUG)
        logger.setLevel(logging.DEBUG)

    state["repo_path"] = path
    state["commit_interval"] = time

    typer.echo("[GitMind] Agent Brain starting...")
    typer.echo(f"   Watching : {path}")
    typer.echo(f"   Interval : {time}s")
    typer.echo(f"   Port     : {port}")
    typer.echo(f"   Status   : http://127.0.0.1:{port}/status")

    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)


@cli.command()
def stop():
    """Remind how to stop a running agent."""
    typer.echo(
        "Send POST /command with {'action': 'stop'} to stop GitMind."
    )


@cli.command("status")
def status_cmd():
    """Print the current in-memory state."""
    typer.echo(json.dumps(state, indent=2, default=str))


# ─── ENTRY POINT ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli()
