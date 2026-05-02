import git
import os
import pathlib
import datetime
import logging
from typing import Optional, List, Dict

logger = logging.getLogger("gitmind.git_ops")

class GitOps:
    def __init__(self, repo_path: str):
        self.repo_path = str(pathlib.Path(repo_path).resolve())
        self.repo: Optional[git.Repo] = None
        self._init_repo()

    def _init_repo(self):
        try:
            self.repo = git.Repo(self.repo_path, search_parent_directories=True)
            logger.info(f"Git repo found: {self.repo.working_dir}")
        except git.exc.InvalidGitRepositoryError:
            logger.warning(f"No git repo at {self.repo_path}. Git ops disabled.")
            self.repo = None
        except Exception as e:
            logger.error(f"Repo init failed: {e}")
            self.repo = None

    def is_valid(self) -> bool:
        return self.repo is not None

    def get_diff(self) -> str:
        """Returns unified diff of all unstaged + staged changes."""
        if not self.is_valid():
            return ""
        try:
            # unstaged vs index
            unstaged = self.repo.git.diff()
            # staged vs HEAD (catch error if no HEAD/no commits)
            try:
                staged = self.repo.git.diff("--cached")
            except Exception:
                staged = ""
            
            combined = "\n".join(filter(None, [unstaged, staged]))
            logger.debug(f"Diff: {len(combined)} chars")
            return combined
        except Exception as e:
            logger.error(f"get_diff failed: {e}")
            return ""

    def get_pending_count(self) -> int:
        """Returns total count of modified + untracked + staged files."""
        if not self.is_valid():
            return 0
        try:
            modified = len(self.repo.index.diff(None))
            untracked = len(self.repo.untracked_files)
            try:
                staged = len(self.repo.index.diff("HEAD"))
            except Exception:
                staged = 0  # empty repo has no HEAD
            total = modified + untracked + staged
            logger.debug(f"Pending: {modified} modified, {untracked} untracked, {staged} staged")
            return total
        except Exception as e:
            logger.error(f"get_pending_count failed: {e}")
            return 0

    def is_clean(self) -> bool:
        """Returns True if nothing to commit."""
        if not self.is_valid():
            return True
        try:
            return not self.repo.is_dirty(untracked_files=True)
        except Exception:
            return True

    def stage_all(self) -> bool:
        """Runs git add -A. Returns True on success."""
        if not self.is_valid():
            return False
        try:
            self.repo.git.add("-A")
            logger.info("Staged all: git add -A")
            return True
        except git.exc.GitCommandError as e:
            logger.error(f"stage_all failed: {e}")
            return False

    def commit(self, message: str) -> Optional[str]:
        """Commits all staged changes. Returns 7-char short hash or None."""
        if not self.is_valid():
            return None
        try:
            if self.is_clean():
                logger.info("Nothing to commit — skipping.")
                return None

            self.repo.index.commit(message)
            
            # Use try-except for head access in case of detached state or initial commit issues
            try:
                short_hash = self.repo.head.commit.hexsha[:7]
                logger.info(f"Committed {short_hash}: {message}")
                return short_hash
            except Exception:
                return "unknown" # Initial commit edge case
        except Exception as e:
            logger.error(f"commit failed: {e}")
            return None

    def push(self) -> bool:
        """Pushes current branch to remote origin. Returns True on success."""
        if not self.is_valid():
            return False
        try:
            # Check if remote exists
            if not self.repo.remotes:
                logger.warning("No remotes configured for this repo")
                return False
            
            origin = self.repo.remote(name='origin')
            origin.push()
            logger.info("Pushed successfully to origin")
            return True
        except Exception as e:
            logger.error(f"Push failed: {e}")
            return False

    def get_recent_log(self, n: int = 20) -> List[Dict]:
        """Returns list of last n commits as dicts."""
        if not self.is_valid():
            return []
        try:
            result = []
            # iter_commits might raise if there are zero commits
            try:
                commits = list(self.repo.iter_commits(max_count=n))
            except Exception:
                return []
                
            for c in commits:
                result.append({
                    "hash": c.hexsha[:7],
                    "message": c.message.strip(),
                    "author": c.author.name,
                    "time": datetime.datetime.fromtimestamp(c.committed_date).isoformat(),
                    "files_changed": len(c.stats.files),
                    "insertions": c.stats.total.get("insertions", 0),
                    "deletions": c.stats.total.get("deletions", 0),
                    "is_gitmind": "[gitmind-fallback]" in c.message or "GitMind" in c.message
                })
            return result
        except Exception as e:
            logger.error(f"get_recent_log failed: {e}")
            return []

    def amend_last(self, new_message: str) -> bool:
        """Amends the most recent commit's message."""
        if not self.is_valid():
            return False
        try:
            self.repo.git.commit("--amend", "--no-edit", "-m", new_message)
            logger.info(f"Amended: {new_message!r}")
            return True
        except git.exc.GitCommandError as e:
            logger.error(f"amend_last failed: {e}")
            return False

    def get_last_commit_info(self) -> Optional[Dict]:
        """Returns dict of most recent commit, or None."""
        if not self.is_valid():
            return None
        try:
            c = self.repo.head.commit
            return {
                "hash": c.hexsha[:7],
                "message": c.message.strip(),
                "author": c.author.name,
                "time": datetime.datetime.fromtimestamp(c.committed_date).isoformat()
            }
        except Exception:
            # Likely empty repo or detached head
            return None

    def get_streak_days(self) -> int:
        """Counts consecutive calendar days that have at least one commit."""
        if not self.is_valid():
            return 0
        try:
            try:
                commits = list(self.repo.iter_commits())
            except Exception:
                return 0
                
            if not commits:
                return 0

            commit_dates = sorted(set(
                datetime.datetime.fromtimestamp(c.committed_date).date()
                for c in commits
            ), reverse=True)

            today = datetime.date.today()
            # Streak must include today or yesterday to be considered active
            if commit_dates[0] < today - datetime.timedelta(days=1):
                return 0

            streak = 0
            expected = commit_dates[0]
            for d in commit_dates:
                if d == expected:
                    streak += 1
                    expected -= datetime.timedelta(days=1)
                else:
                    break
            return streak
        except Exception as e:
            logger.error(f"get_streak_days failed: {e}")
            return 0

_instance: Optional[GitOps] = None

def get_git_ops(repo_path: str = ".") -> GitOps:
    global _instance
    resolved = str(pathlib.Path(repo_path).resolve())
    if _instance is None or _instance.repo_path != resolved:
        _instance = GitOps(repo_path)
    return _instance
