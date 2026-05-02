"""
GitMind Agent — Fallback Message Generator & Amend Loop (Phase 3)
Rule-based commit messages when LLM is unavailable, plus the amend
loop that retroactively upgrades fallback commits with AI messages.
"""

import re
import logging
import datetime
from typing import Optional, List, Dict, Callable
from git_ops import get_git_ops

logger = logging.getLogger("gitmind.fallback")

FALLBACK_TAG = "[gitmind-fallback]"


# ─── RULE-BASED MESSAGE GENERATOR ────────────────────────────────────────────


def rule_based_message(diff: str) -> str:
    """Generate a commit message from the raw diff string using rules only.

    Pure function — no I/O, no network, no git calls.
    MUST always return a non-empty string. Never raises.
    """
    try:
        # 1. Extract changed filenames from the diff
        file_pattern = re.compile(r"^\+\+\+ b/(.+)$", re.MULTILINE)
        files = file_pattern.findall(diff)

        if not files:
            alt_pattern = re.compile(
                r"^diff --git a/\S+ b/(\S+)$", re.MULTILINE
            )
            files = alt_pattern.findall(diff)

        # Deduplicate preserving order
        seen: set = set()
        files = [f for f in files if not (f in seen or seen.add(f))]

        # 2. Detect dominant operation type from diff stats
        additions = len(re.findall(r"^\+[^+]", diff, re.MULTILINE))
        deletions = len(re.findall(r"^-[^-]", diff, re.MULTILINE))

        if additions > deletions * 2:
            op = "add"
        elif deletions > additions * 2:
            op = "remove"
        else:
            op = "update"

        # 3. Detect commit type from filenames
        lower_files = [f.lower() for f in files]
        commit_type = "chore"  # default

        # Check patterns in priority order
        if any("test" in f or "spec" in f for f in lower_files):
            commit_type = "test"
        elif any(
            f.endswith(".md") or f.endswith(".txt") or f.endswith(".rst")
            for f in lower_files
        ):
            commit_type = "docs"
        elif any(
            "style" in f or f.endswith(".css") or f.endswith(".scss")
            for f in lower_files
        ):
            commit_type = "style"
        elif any(
            "config" in f
            or ".env" in f
            or f.endswith(".yaml")
            or f.endswith(".yml")
            or f.endswith(".toml")
            for f in lower_files
        ):
            commit_type = "chore"
        elif additions > deletions * 2:
            commit_type = "feat"
        elif deletions > additions * 2:
            commit_type = "fix"

        # 4. Build file summary string
        if not files:
            file_summary = "multiple files"
        elif len(files) == 1:
            file_summary = files[0].split("/")[-1]  # basename only
        elif len(files) <= 3:
            file_summary = ", ".join(f.split("/")[-1] for f in files)
        else:
            shown = ", ".join(f.split("/")[-1] for f in files[:2])
            file_summary = f"{shown} (+{len(files) - 2} more)"

        # 5. Build and return message
        body = f"{commit_type}: {op} {file_summary}"
        if len(body) > 68:
            body = body[:65] + "..."

        return f"{body} {FALLBACK_TAG}"

    except Exception as e:
        # Absolute safety net — must never raise
        logger.error(f"rule_based_message failed: {e}")
        return f"chore: update files {FALLBACK_TAG}"


# ─── FALLBACK COMMIT SCANNER ─────────────────────────────────────────────────


def get_fallback_commits(repo_path: str) -> List[Dict]:
    """Scan git log for commits that still have FALLBACK_TAG in their message.

    These are candidates for the amend loop.
    """
    try:
        ops = get_git_ops(repo_path)
        if not ops.is_valid():
            return []

        all_commits = ops.get_recent_log(n=50)
        return [
            c for c in all_commits if FALLBACK_TAG in c.get("message", "")
        ]
    except Exception as e:
        logger.error(f"get_fallback_commits failed: {e}")
        return []


# ─── AMEND LOOP ───────────────────────────────────────────────────────────────


def run_amend_loop(
    repo_path: str, generate_fn: Callable[[str], str]
) -> int:
    """Find all fallback commits, generate better messages via LLM,
    and amend them. Returns count of successfully amended commits.

    Parameters:
        repo_path: Path to the git repository.
        generate_fn: The generate_message function from llm.py —
                     passed in to avoid circular imports.
    """
    try:
        ops = get_git_ops(repo_path)
        if not ops.is_valid():
            return 0

        fallback_commits = get_fallback_commits(repo_path)
        if not fallback_commits:
            logger.debug("Amend loop: no fallback commits found")
            return 0

        logger.info(
            f"Amend loop: found {len(fallback_commits)} fallback commit(s)"
        )
        amended_count = 0

        for commit in fallback_commits:
            try:
                # Get the diff for this specific commit
                diff_text = ops.repo.git.show(
                    commit["hash"], "--unified=3", "--no-color"
                )

                # Generate a proper message
                new_message = generate_fn(diff_text)

                # Only amend the most recent commit (git limitation)
                # Check if this is HEAD
                head_hash = ops.repo.head.commit.hexsha[:7]
                if commit["hash"] == head_hash:
                    success = ops.amend_last(new_message)
                    if success:
                        logger.info(
                            f"Amended {commit['hash']}: {new_message!r}"
                        )
                        amended_count += 1
                    else:
                        logger.warning(
                            f"amend_last failed for {commit['hash']}"
                        )
                else:
                    # Non-HEAD fallback commits: log but skip
                    # (amending non-HEAD requires interactive rebase)
                    logger.debug(
                        f"Skipping non-HEAD fallback commit "
                        f"{commit['hash']} (amend only safe on HEAD)"
                    )

            except RuntimeError as e:
                # generate_fn raised — LLM unavailable, stop trying
                logger.warning(
                    f"LLM unavailable for amend of {commit['hash']}: {e}"
                )
                break

            except Exception as e:
                logger.error(
                    f"Amend loop error for {commit['hash']}: {e}"
                )
                continue

        return amended_count

    except Exception as e:
        logger.error(f"run_amend_loop failed: {e}")
        return 0


# ─── TONE INSTRUCTION HELPER ─────────────────────────────────────────────────


def get_tone_instruction(message_tone: str) -> str:
    """Return a tone instruction string to append to LLM prompts
    based on the user's learned preference from the memory layer.
    """
    if message_tone == "casual":
        return (
            "Use clear, casual language. "
            "Format: <type>: <description>"
        )
    elif message_tone == "detailed":
        return (
            "Be verbose and descriptive. Include what changed and why. "
            "Format: <type>(<scope>): <description>"
        )
    else:  # "conventional" (default)
        return (
            "Use strict Conventional Commits format: "
            "<type>(<scope>): <description>"
        )
