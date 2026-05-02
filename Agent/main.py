"""
GitMind Agent Brain — Flask Server
Routes, CLI entry point. State and helpers live in state_utils.py.
Scheduler lives in scheduler.py. Git ops in git_ops.py.
"""

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import time as _time
from dotenv import load_dotenv
import os
import json
import datetime
import pathlib
import logging
import sys
import typer

from git_ops import get_git_ops
from state_utils import state, write_status_file, log_activity, _lock
from scheduler import start_scheduler, stop_scheduler, commit_cycle
from watcher import (
    start_watcher,
    stop_watcher,
    is_watching,
    get_watcher_status
)

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

# ─── FLASK APP SETUP ─────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app, origins="*", supports_credentials=True)

import time as _req_time

@app.before_request
def _before():
    from flask import g
    g.start_time = _req_time.time()

@app.after_request
def _after(response):
    from flask import g, request as _req
    duration_ms = round(
        (_req_time.time() - getattr(g, "start_time", _req_time.time())) * 1000,
        1
    )
    # Skip logging the /stream endpoint (it's long-lived)
    if _req.path != "/stream":
        logger.info(
            f"{_req.method} {_req.path} → "
            f"{response.status_code} ({duration_ms}ms)"
        )
    return response


# ─── HELPERS ──────────────────────────────────────────────────────────────────


def _ts() -> str:
    """Return the current UTC timestamp as an ISO string."""
    return datetime.datetime.now().isoformat()

def _sse_event(data: dict, event: str = "update") -> str:
    """
    Formats a dict as an SSE message string.
    SSE protocol: lines must end with \n, event ends with \n\n
    """
    import json as _json
    payload = _json.dumps(data, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


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

@app.route("/stats", methods=["GET"])
def get_stats():
    try:
        with _lock:
            total     = state["total_commits"]
            accepted  = state["accepted_commits"]
            rejected  = state["rejected_commits"]
            rate      = state["rejection_rate"]
            auto_mode = state["auto_mode"]
            tone      = state["message_tone"]
            streak    = state["streak_days"]
            pending   = state["pending_changes"]
        
        acceptance_rate = round(
            accepted / total if total > 0 else 0.0, 3
        )
        
        from cache import get_cache
        from persistence import get_memory_info
        
        return jsonify({
            "total_commits":     total,
            "accepted_commits":  accepted,
            "rejected_commits":  rejected,
            "acceptance_rate":   acceptance_rate,
            "rejection_rate":    rate,
            "auto_mode":         auto_mode,
            "message_tone":      tone,
            "streak_days":       streak,
            "pending_changes":   pending,
            "watcher_active":    is_watching(),
            "scheduler_running": state["running"],
            "uptime_snapshot":   _ts(),
            "cache":             get_cache().stats(),
            "memory_file":       get_memory_info(state["repo_path"])
        }), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


@app.route("/status", methods=["GET"])
def status_route():
    """Return the full agent state. Also writes the status file so the
    VS Code extension can fall back to reading the JSON on disk."""
    try:
        try:
            ops = get_git_ops(state["repo_path"])
            with _lock:
                state["pending_changes"] = ops.get_pending_count()
                state["streak_days"] = ops.get_streak_days()
                state["watcher_active"] = is_watching()
            last = ops.get_last_commit_info()
            if last:
                with _lock:
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
            with _lock:
                state["running"] = True
                state["paused"] = False
                state["repo_path"] = path
                state["commit_interval"] = interval
                state["next_commit_in"] = interval

            # Validate repo immediately on start
            ops = get_git_ops(path)
            if not ops.is_valid():
                log_activity(f"Warning: no git repo at {path}", "warning")
            else:
                with _lock:
                    state["pending_changes"] = ops.get_pending_count()
                    state["streak_days"] = ops.get_streak_days()
                log_activity(
                    f"Git repo valid. {state['pending_changes']} pending changes."
                )

            start_scheduler()
            obs = start_watcher(path)
            if obs is None:
                log_activity(f"Watcher failed: path not found or permission denied: {path}", "warning")
            log_activity(
                f"GitMind started. Watching {path}, interval={interval}s"
            )
            write_status_file()
            return jsonify({
                "status": "started",
                "interval": interval,
                "path": path,
            }), 200

        elif action == "stop":
            stop_watcher()
            stop_scheduler()
            with _lock:
                state["running"] = False
                state["next_commit_in"] = 0
            log_activity("GitMind stopped.")
            write_status_file()
            return jsonify({"status": "stopped"}), 200

        elif action == "pause":
            # Note: watcher continues observing during pause.
            # commit_cycle() and _flush_events() both check state["paused"].
            with _lock:
                state["paused"] = not state["paused"]
            label = "paused" if state["paused"] else "resumed"
            log_activity(f"GitMind {label}.")
            write_status_file()
            return jsonify({"status": label}), 200

        elif action == "commit_now":
            log_activity("Manual commit triggered.")
            result = commit_cycle(force=True)

            if result:
                with _lock:
                    resp = {
                        "status": "committed",
                        "hash": state["last_commit_hash"],
                        "message": state["last_commit"],
                    }
                return jsonify(resp), 200
            else:
                ops = get_git_ops(state["repo_path"])
                if ops.is_clean():
                    return jsonify({
                        "status": "nothing_to_commit",
                        "message": "Working directory is clean",
                    }), 200
                else:
                    return jsonify({
                        "status": "suggest",
                        "message": "Changes staged — awaiting user approval",
                    }), 200

        elif action == "push":
            log_activity("Manual push triggered.")
            ops = get_git_ops(state["repo_path"])
            success = ops.push()
            if success:
                with _lock:
                    state["pending_push"] = False
                return jsonify({
                    "status": "pushed",
                    "message": "Successfully pushed to origin"
                }), 200
            else:
                return jsonify({
                    "status": "error",
                    "message": "Push failed. Check terminal for details."
                }), 500

        elif action == "clear_cache":
            from cache import get_cache
            get_cache().clear()
            log_activity("LLM cache cleared manually via command")
            write_status_file()
            return jsonify({"status": "cleared"}), 200

        elif action == "set_tone":
            tone = data.get("tone", "professional")
            with _lock:
                state["message_tone"] = tone
            log_activity(f"Tone set to {tone}")
            write_status_file()
            return jsonify({"status": "tone_set", "tone": tone}), 200

        elif action == "toggle_auto_mode":
            with _lock:
                state["auto_mode"] = not state["auto_mode"]
                mode = "ON" if state["auto_mode"] else "OFF"
            log_activity(f"Auto-commit mode turned {mode}")
            write_status_file()
            return jsonify({"status": "toggled", "auto_mode": state["auto_mode"]}), 200

        elif action == "set_interval":
            interval = int(data.get("interval", 300))
            with _lock:
                state["commit_interval"] = interval
                # adjust next commit time if needed, simple approach: reset it
                state["next_commit_in"] = interval
            log_activity(f"Commit interval set to {interval}s")
            write_status_file()
            return jsonify({"status": "interval_set", "interval": interval}), 200

        else:
            return jsonify({
                "error": "Unknown action",
                "valid_actions": ["start", "stop", "pause", "commit_now", "push", "clear_cache", "set_tone", "toggle_auto_mode", "set_interval"],
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

@app.route("/amend", methods=["POST"])
def amend():
    try:
        from fallback import run_amend_loop, get_fallback_commits
        from llm import generate_message, is_available
        
        with _lock:
            repo_path = state["repo_path"]
        
        if not is_available():
            return jsonify({
                "status":  "skipped",
                "message": "LLM unavailable — cannot amend"
            }), 200
        
        fallbacks = get_fallback_commits(repo_path)
        if not fallbacks:
            return jsonify({
                "status":  "clean",
                "message": "No fallback commits to amend",
                "count":   0
            }), 200
        
        amended = run_amend_loop(repo_path, generate_message)
        log_activity(f"Manual amend: upgraded {amended} fallback commit(s)")
        
        return jsonify({
            "status":          "success",
            "amended_count":   amended,
            "fallback_found":  len(fallbacks),
            "message":         f"Amended {amended} of {len(fallbacks)} fallback commit(s)"
        }), 200
    
    except Exception as e:
        logger.exception("/amend error")
        return jsonify({"status": "error", "error": str(e)}), 500


from analyzer import DiffAnalyzer, SemanticGrouper
from llm import is_available
from planner import CommitPlanner

@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        # 1. Capture raw data for debugging
        raw_body = request.get_data(as_text=True)
        
        # 2. Try parsing JSON
        data = None
        try:
            data = request.get_json(force=True)
        except Exception:
            # Fallback: manual parse if Flask's built-in parser is picky about encodings/BOMs
            import json as _json
            try:
                data = _json.loads(raw_body)
            except Exception:
                pass

        if not data:
            logger.error(f"ANALYSIS FAILED: Could not parse JSON body. Raw body snippet: {raw_body[:200]}")
            return jsonify({
                "error": "Invalid or empty JSON body",
                "raw_body_preview": raw_body[:100]
            }), 400

        files = data.get("files", [])
        diff = data.get("diff", "")
        
        # Robustness: if terminal sends a single string, wrap it in a list
        if isinstance(files, str):
            files = [files]
        
        if not files or not isinstance(files, list):
            logger.warning(f"ANALYSIS REJECTED: 'files' is not a list. Received: {type(files)}")
            return jsonify({"error": "files must be a non-empty list"}), 400
        
        if not diff:
            # If no diff is provided, try to fetch it if repo_path is available
            logger.warning("ANALYSIS: No diff provided in request body")
        
        log_activity(f"Analyze: {len(files)} file(s)")
        
        diff_analysis = DiffAnalyzer().analyze(diff, files)
        groups = SemanticGrouper().group(
            files=files,
            diff_analysis=diff_analysis,
            use_ai=is_available()
        )
        
        return jsonify({
            "status": "success",
            "groups": groups,
            "diff_summary": diff_analysis["summary"],
            "analyzed_at": _ts()
        }), 200
    
    except Exception as e:
        logger.exception("/analyze system error")
        return jsonify({"status": "error", "error": str(e)}), 500

@app.route("/plan", methods=["POST"])
def plan():
    try:
        data   = request.get_json(force=True, silent=True) or {}
        files  = data.get("files", [])
        diff   = data.get("diff", "")
        groups = data.get("groups", [])

        # Robustness: if terminal sends a single string, wrap it in a list
        if isinstance(files, str):
            files = [files]
        
        # If groups not provided, run the full analyze pipeline
        if not groups:
            diff_analysis = DiffAnalyzer().analyze(diff, files)
            groups = SemanticGrouper().group(
                files=files,
                diff_analysis=diff_analysis,
                use_ai=is_available()
            )
        else:
            diff_analysis = DiffAnalyzer().analyze(diff, files)
        
        commits = CommitPlanner().plan(groups, diff_analysis)
        
        return jsonify({
            "status":        "success",
            "commits":       commits,
            "total_commits": len(commits),
            "planned_at":    _ts()
        }), 200
    
    except Exception as e:
        logger.exception("/plan error")
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

        with _lock:
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
                        "Auto mode disabled — rejection rate too high",
                        "warning",
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

@app.route("/stream", methods=["GET"])
def stream():
    def generate():
        last_snapshot = {
            "pending_changes":  None,
            "last_commit_hash": None,
            "running":          None,
            "paused":           None,
            "next_commit_in":   None,
        }
        heartbeat_counter = 0
        HEARTBEAT_INTERVAL = 15

        with _lock:
            connected_payload = {
                "pending_changes":  state["pending_changes"],
                "running":          state["running"],
                "last_commit":      state["last_commit"],
                "last_commit_hash": state["last_commit_hash"],
                "streak_days":      state["streak_days"],
                "pending_push":     state["pending_push"],
            }
        yield _sse_event(connected_payload, event="connected")

        while True:
            try:
                _time.sleep(1)
                heartbeat_counter += 1

                with _lock:
                    current = {
                        "pending_changes":  state["pending_changes"],
                        "last_commit_hash": state["last_commit_hash"],
                        "running":          state["running"],
                        "paused":           state["paused"],
                        "next_commit_in":   state["next_commit_in"],
                    }

                changed = {
                    k: current[k]
                    for k in current
                    if current[k] != last_snapshot[k]
                }

                if changed:
                    with _lock:
                        update_payload = {
                            "pending_changes":  state["pending_changes"],
                            "running":          state["running"],
                            "paused":           state["paused"],
                            "next_commit_in":   state["next_commit_in"],
                            "last_commit":      state["last_commit"],
                            "last_commit_hash": state["last_commit_hash"],
                            "last_commit_time": state["last_commit_time"],
                            "streak_days":      state["streak_days"],
                            "auto_mode":        state["auto_mode"],
                            "watcher_active":   state.get("watcher_active", False),
                            "pending_push":     state["pending_push"],
                        }

                    if changed.get("last_commit_hash") is not None:
                        yield _sse_event(update_payload, event="commit")
                    else:
                        yield _sse_event(update_payload, event="update")

                    last_snapshot.update(current)

                if heartbeat_counter >= HEARTBEAT_INTERVAL:
                    yield _sse_event({"ts": _ts()}, event="heartbeat")
                    heartbeat_counter = 0

            except GeneratorExit:
                logger.debug("SSE client disconnected")
                return
            except Exception as e:
                logger.error(f"SSE stream error: {e}")
                yield _sse_event({"error": str(e)}, event="error")
                return

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":        "no-cache",
            "X-Accel-Buffering":    "no",
            "Access-Control-Allow-Origin": "*",
        }
    )

@app.route("/reset", methods=["POST"])
def reset_memory():
    try:
        data    = request.get_json(force=True, silent=True) or {}
        confirm = data.get("confirm", False)

        if not confirm:
            return jsonify({
                "error":   "Must pass confirm=true to reset memory",
                "example": {"confirm": True}
            }), 400

        with _lock:
            repo_path = state["repo_path"]

            state["total_commits"]        = 0
            state["accepted_commits"]     = 0
            state["rejected_commits"]     = 0
            state["rejection_rate"]       = 0.0
            state["auto_mode"]            = True
            state["message_tone"]         = "conventional"
            state["preferred_commit_size"]= 5
            state["avg_commit_interval"]  = 1800
            state["edited_messages"]      = 0
            state["streak_days"]          = 0

        from persistence import clear as clear_memory
        clear_memory(repo_path)

        from cache import get_cache
        get_cache().clear()

        log_activity("Memory reset to defaults by user", "warning")
        write_status_file()

        return jsonify({
            "status":  "reset",
            "message": "All learned memory cleared. GitMind starts fresh."
        }), 200

    except Exception as e:
        logger.exception("/reset error")
        return jsonify({"status": "error", "error": str(e)}), 500

@app.route("/cache/stats", methods=["GET"])
def cache_stats():
    try:
        from cache import get_cache
        return jsonify({
            "status": "ok",
            "cache":  get_cache().stats()
        }), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500

@app.route("/cache/clear", methods=["POST"])
def cache_clear():
    try:
        from cache import get_cache
        get_cache().clear()
        log_activity("LLM cache cleared manually")
        return jsonify({"status": "cleared"}), 200
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

    with _lock:
        state["repo_path"] = path
        state["commit_interval"] = time
        state["running"] = True
        state["paused"] = False
        state["next_commit_in"] = time

    import signal, sys

    def _shutdown(sig, frame):
        typer.echo("\n[STOP] GitMind shutting down...")
        stop_watcher()
        stop_scheduler()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    typer.echo("\n[INIT] Running startup checks...")

    # Check 1: repo validity
    from git_ops import get_git_ops
    ops = get_git_ops(path)
    if ops.is_valid():
        pending = ops.get_pending_count()
        typer.echo(f"   ✅ Git repo: {ops.repo.working_dir}")
        typer.echo(f"   📁 Pending changes: {pending}")
        with _lock:
            state["repo_path"] = ops.repo.working_dir
    else:
        typer.echo(f"   ⚠️  No git repo at {path} — commits will be skipped")

    # Check 2: LLM availability
    from llm import is_available as llm_available
    if llm_available():
        typer.echo("   ✅ LLM: unclosed.ai reachable")
    else:
        typer.echo("   ⚠️  LLM: unreachable — fallback messages will be used")

    # Check 3: env var
    from llm import API_KEY
    if not API_KEY:
        typer.echo("   ⚠️  UNCLOSED_API_KEY not set in .env")
    else:
        typer.echo(f"   ✅ API key: set ({API_KEY[:6]}...)")

    typer.echo("")

    from state_utils import boot_restore
    
    restored = boot_restore()
    if restored:
        typer.echo(
            f"   ✅ Memory restored: "
            f"{state['total_commits']} commits, "
            f"streak={state['streak_days']}d, "
            f"auto_mode={state['auto_mode']}"
        )
    else:
        typer.echo("   ℹ️  No previous memory — starting fresh")

    typer.echo("[GitMind] Agent Brain starting...")
    typer.echo(f"   Watching : {path}")
    typer.echo(f"   Interval : {time}s")
    typer.echo(f"   Port     : {port}")
    typer.echo(f"   Status   : http://127.0.0.1:{port}/status")

    # Start the core loops
    start_scheduler()
    start_watcher(path)

    app.run(
        host="0.0.0.0",
        port=port,
        debug=False,
        use_reloader=False,
        threaded=True        # ← REQUIRED for SSE + background threads
    )


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
