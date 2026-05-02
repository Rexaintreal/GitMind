"""
GitMind Agent — Autonomous Commit Scheduler (Phase 4)
Uses APScheduler BackgroundScheduler (sync, thread-based).
Two logical jobs:
  1. countdown_tick() — fires every 1 second, manages the timer
  2. commit_cycle()  — the full observe→decide→generate→commit pipeline
"""

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
import logging
import datetime
import threading

from git_ops import get_git_ops
from llm import generate_message, is_available
from fallback import rule_based_message, run_amend_loop
from state_utils import state, write_status_file, log_activity, _lock
from analyzer import DiffAnalyzer, SemanticGrouper
from planner import CommitPlanner
from persistence import save as persist_save

logger = logging.getLogger("gitmind.scheduler")

# ─── MODULE-LEVEL SCHEDULER INSTANCE ─────────────────────────────────────────

_scheduler: BackgroundScheduler = None


# ─── SCHEDULER LIFECYCLE ─────────────────────────────────────────────────────


def init_scheduler() -> BackgroundScheduler:
    """Create and configure the APScheduler BackgroundScheduler.
    Does NOT start it — start_scheduler() does that."""
    global _scheduler
    _scheduler = BackgroundScheduler(
        job_defaults={"coalesce": True, "max_instances": 1},
        timezone="UTC",
    )
    return _scheduler


def start_scheduler() -> None:
    """Start the scheduler and register the countdown tick job.
    Idempotent — safe to call multiple times."""
    global _scheduler

    if _scheduler is None:
        init_scheduler()

    if _scheduler.running:
        logger.info("Scheduler already running — skipping start")
        return

    # JOB 1: countdown tick — every 1 second
    _scheduler.add_job(
        func=countdown_tick,
        trigger=IntervalTrigger(seconds=1),
        id="countdown_tick",
        replace_existing=True,
    )

    _scheduler.start()
    logger.info("Scheduler started")


def stop_scheduler() -> None:
    """Stop the scheduler gracefully. Safe to call even if not running."""
    global _scheduler
    try:
        if _scheduler and _scheduler.running:
            _scheduler.shutdown(wait=False)
            logger.info("Scheduler stopped")
    except Exception as e:
        logger.error(f"Scheduler shutdown error: {e}")


# ─── COUNTDOWN TICK ──────────────────────────────────────────────────────────


def countdown_tick() -> None:
    """Fires every 1 second. Manages the countdown and triggers
    commit_cycle() when the timer expires."""
    with _lock:
        if not state["running"] or state["paused"]:
            return

        if state["next_commit_in"] > 0:
            state["next_commit_in"] -= 1
            return  # still counting down

        # Timer expired — reset countdown
        state["next_commit_in"] = state["commit_interval"]

    # Trigger commit_cycle OUTSIDE the lock to avoid deadlock
    # (commit_cycle acquires the lock internally for state writes)
    commit_cycle()


# ─── COMMIT CYCLE (THE CORE PIPELINE) ────────────────────────────────────────


def commit_cycle(force: bool = False) -> bool:
    """The core autonomous commit pipeline.
    Returns True if a commit was made, False otherwise.
    Can be called from countdown_tick() OR directly from /command "commit_now".
    """

    # STEP 1 — Guard checks
    with _lock:
        if not state["running"]:
            logger.debug("commit_cycle: not running, skip")
            return False
        if state["paused"]:
            logger.debug("commit_cycle: paused, skip")
            return False
        repo_path = state["repo_path"]

    # STEP 2 — Get git ops
    ops = get_git_ops(repo_path)
    if not ops.is_valid():
        logger.warning("commit_cycle: invalid repo, disabling")
        with _lock:
            state["running"] = False
        return False

    # STEP 3 — Check for changes
    diff = ops.get_diff()
    if not diff or ops.is_clean():
        logger.debug("commit_cycle: nothing to commit")
        with _lock:
            state["pending_changes"] = 0
        return False

    # STEP 4 — Decision logic (mirrors /decide route)
    file_count = ops.get_pending_count()

    with _lock:
        time_gap = state["commit_interval"] - state["next_commit_in"]
        auto_mode = state["auto_mode"]
        rejection_rate = state["rejection_rate"]

    AUTO_COMMIT_FILES = 10
    AUTO_COMMIT_TIME = 1200
    SUGGEST_FILES = 3

    if not auto_mode:
        action = "SUGGEST"
        reason = "Auto mode off"
    elif rejection_rate > 0.5:
        action = "SUGGEST"
        reason = "High rejection rate"
    elif file_count >= AUTO_COMMIT_FILES and time_gap >= AUTO_COMMIT_TIME:
        action = "AUTO_COMMIT"
        reason = f"{file_count} files, {time_gap}s gap"
    elif file_count >= SUGGEST_FILES:
        action = "SUGGEST"
        reason = "Moderate changes"
    else:
        action = "WAIT"
        reason = "Too few changes"

    logger.info(f"commit_cycle decision: {action} — {reason} (force={force})")

    if not force:
        if action == "WAIT":
            return False

        if action == "SUGGEST":
            # Update state so VS Code sidebar shows the suggestion
            with _lock:
                state["pending_changes"] = file_count
            logger.info("commit_cycle: SUGGEST — waiting for user approval")
            return False

    # STEP 5 — Analyze diff and generate semantic commit plan
    try:
        diff_analysis = DiffAnalyzer().analyze(diff, [])

        with _lock:
            file_count = ops.get_pending_count()

        # Get all changed files from analysis
        changed_files = [
            s["filename"] for s in diff_analysis.get("file_stats", [])
        ]
        if not changed_files:
            # Fallback: parse filenames from diff directly
            import re as _re
            changed_files = _re.findall(
                r'diff --git a/\S+ b/(\S+)', diff
            )

        # Semantic grouping (AI if available, heuristic fallback)
        groups = SemanticGrouper().group(
            files=changed_files,
            diff_analysis=diff_analysis,
            use_ai=is_available()
        )

        # Build commit plan
        commits = CommitPlanner().plan(groups, diff_analysis)

        logger.info(
            f"commit_cycle: {len(groups)} group(s), "
            f"{len(commits)} commit(s) planned"
        )
        
        used_fallback = any(c.get("message_source") == "fallback" for c in commits)

    except Exception as e:
        logger.error(f"commit_cycle analysis failed: {e} — using fallback")
        # Catastrophic fallback: one commit for everything
        commits = [{
            "message": rule_based_message(diff),
            "files":   [],
            "type":    "chore"
        }]
        used_fallback = True

    # STEP 6 — Stage and commit (UPDATED to handle multiple commits)
    with _lock:
        state["last_command"] = "git add -A"

    staged = ops.stage_all()
    if not staged:
        logger.error("commit_cycle: staging failed")
        return False

    committed_count = 0
    last_hash = None
    last_message = None

    # For this implementation, create ONE combined commit
    # Use the highest-scored commit's message as the primary message
    primary = max(commits, key=lambda c: c.get("score", 0))
    primary_message = primary["message"]

    with _lock:
        state["last_command"] = f'git commit -m "{primary_message}"'

    commit_hash = ops.commit(primary_message)

    if not commit_hash:
        logger.error("commit_cycle: commit returned None")
        return False

    last_hash = commit_hash
    last_message = primary_message

    # STEP 7 — Update state after successful commit
    with _lock:
        state["last_commit"] = last_message
        state["last_commit_time"] = datetime.datetime.now().isoformat()
        state["last_commit_hash"] = last_hash
        state["total_commits"] += 1
        state["pending_changes"] = 0
        state["streak_days"] = ops.get_streak_days()

    logger.info(
        f"commit_cycle: committed {commit_hash} "
        f"({'fallback' if used_fallback else 'LLM'}) — {primary_message!r}"
    )

    # STEP 8 — Run amend loop if LLM is now available
    if used_fallback:
        logger.debug("Skipping amend loop — LLM unavailable this cycle")
    else:
        try:
            amended = run_amend_loop(repo_path, generate_message)
            if amended:
                logger.info(
                    f"Amend loop upgraded {amended} fallback commit(s)"
                )
        except Exception as e:
            logger.error(f"Amend loop error: {e}")

    # STEP 9 — Write status file for extension fallback
    log_activity(
        f"Auto-commit: {commit_hash} — {primary_message}"
        + (" [fallback]" if used_fallback else "")
    )
    write_status_file()

    # Persist the memory snapshot immediately after a commit
    # so a crash between commits doesn't lose this record.
    persist_save(state, state["repo_path"])
    logger.debug("commit_cycle: memory persisted after commit")

    return True
