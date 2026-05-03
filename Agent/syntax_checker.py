"""
GitMind Agent — Pre-Commit Syntax Checker (Phase 4 Extension)
Validates staged/pending files for syntax errors before any commit.
Blocks commits that would introduce broken code into git history.

Supported languages:
  - Python  (.py)        → ast.parse
  - JSON    (.json)      → json.loads
  - YAML    (.yaml/.yml) → yaml.safe_load  [optional dep]
  - JS/TS   (.js/.ts/.jsx/.tsx) → node --check  [if node installed]
  - HTML    (.html)      → html.parser (basic well-formedness)

Returns a SyntaxCheckResult with:
  - passed: bool
  - errors: list of {file, line, message}
  - warnings: list of {file, message}
  - checked: list of files actually validated
  - skipped: list of files with no checker available
"""

import ast
import json
import logging
import pathlib
import subprocess
import shutil
from dataclasses import dataclass, field
from typing import List, Dict, Optional

logger = logging.getLogger("gitmind.syntax_checker")


# ─── RESULT TYPES ─────────────────────────────────────────────────────────────


@dataclass
class SyntaxError_:
    """A single syntax error found in a file."""
    file: str
    line: Optional[int]
    col: Optional[int]
    message: str

    def __str__(self):
        loc = f":{self.line}" if self.line else ""
        col = f":{self.col}" if self.col else ""
        return f"{self.file}{loc}{col} — {self.message}"


@dataclass
class SyntaxCheckResult:
    passed: bool = True
    errors: List[SyntaxError_] = field(default_factory=list)
    warnings: List[Dict] = field(default_factory=list)
    checked: List[str] = field(default_factory=list)
    skipped: List[str] = field(default_factory=list)

    def add_error(self, file: str, message: str,
                  line: int = None, col: int = None):
        self.passed = False
        self.errors.append(SyntaxError_(file=file, line=line,
                                         col=col, message=message))

    def add_warning(self, file: str, message: str):
        self.warnings.append({"file": file, "message": message})

    def summary(self) -> str:
        if self.passed:
            return (
                f"✓ Syntax OK — {len(self.checked)} file(s) checked"
                + (f", {len(self.skipped)} skipped" if self.skipped else "")
            )
        lines = [
            f"✗ {len(self.errors)} syntax error(s) in "
            f"{len(self.checked)} checked file(s):"
        ]
        for e in self.errors:
            lines.append(f"  • {e}")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "passed":   self.passed,
            "errors":   [
                {"file": e.file, "line": e.line,
                 "col": e.col, "message": e.message}
                for e in self.errors
            ],
            "warnings": self.warnings,
            "checked":  self.checked,
            "skipped":  self.skipped,
            "summary":  self.summary(),
        }


# ─── INDIVIDUAL CHECKERS ──────────────────────────────────────────────────────


def _check_python(filepath: str, result: SyntaxCheckResult) -> None:
    """Parse Python file with ast — catches all SyntaxError / IndentationError."""
    try:
        source = pathlib.Path(filepath).read_text(encoding="utf-8",
                                                   errors="replace")
        ast.parse(source, filename=filepath)
        result.checked.append(filepath)
        logger.debug(f"Python OK: {filepath}")
    except SyntaxError as e:
        result.add_error(
            file=filepath,
            message=str(e.msg),
            line=e.lineno,
            col=e.offset,
        )
        result.checked.append(filepath)
        logger.warning(f"Python syntax error: {filepath}:{e.lineno} — {e.msg}")
    except Exception as e:
        # Unreadable file — warn but don't block
        result.add_warning(filepath, f"Could not read file: {e}")
        result.skipped.append(filepath)


def _check_json(filepath: str, result: SyntaxCheckResult) -> None:
    """Validate JSON with json.loads — exact line numbers via decoder."""
    try:
        text = pathlib.Path(filepath).read_text(encoding="utf-8",
                                                 errors="replace")
        json.loads(text)
        result.checked.append(filepath)
        logger.debug(f"JSON OK: {filepath}")
    except json.JSONDecodeError as e:
        result.add_error(
            file=filepath,
            message=e.msg,
            line=e.lineno,
            col=e.colno,
        )
        result.checked.append(filepath)
        logger.warning(f"JSON error: {filepath}:{e.lineno} — {e.msg}")
    except Exception as e:
        result.add_warning(filepath, f"Could not read file: {e}")
        result.skipped.append(filepath)


def _check_yaml(filepath: str, result: SyntaxCheckResult) -> None:
    """Validate YAML — gracefully skips if PyYAML is not installed."""
    try:
        import yaml  # optional dep
        text = pathlib.Path(filepath).read_text(encoding="utf-8",
                                                 errors="replace")
        yaml.safe_load(text)
        result.checked.append(filepath)
        logger.debug(f"YAML OK: {filepath}")
    except ImportError:
        result.skipped.append(filepath)
        logger.debug("PyYAML not installed — skipping YAML check")
    except Exception as e:
        # yaml.YAMLError has .problem_mark with line/col
        mark = getattr(e, "problem_mark", None)
        line = (mark.line + 1) if mark else None
        col  = (mark.column + 1) if mark else None
        msg  = getattr(e, "problem", str(e))
        result.add_error(file=filepath, message=msg, line=line, col=col)
        result.checked.append(filepath)
        logger.warning(f"YAML error: {filepath} — {msg}")


def _check_js_ts(filepath: str, result: SyntaxCheckResult) -> None:
    """Use `node --check` to validate JS/TS syntax.
    Skipped silently if node is not on PATH."""
    node = shutil.which("node")
    if not node:
        result.skipped.append(filepath)
        logger.debug("node not found — skipping JS/TS check")
        return

    try:
        proc = subprocess.run(
            [node, "--check", filepath],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            result.checked.append(filepath)
            logger.debug(f"JS/TS OK: {filepath}")
        else:
            # Parse node's error output: "file.js:4\nSyntaxError: ..."
            stderr = proc.stderr.strip() or proc.stdout.strip()
            line = None
            import re
            m = re.search(r":(\d+)\b", stderr)
            if m:
                line = int(m.group(1))
            msg = stderr.split("\n")[0] if stderr else "Syntax error"
            result.add_error(file=filepath, message=msg, line=line)
            result.checked.append(filepath)
            logger.warning(f"JS/TS error: {filepath}:{line} — {msg}")
    except subprocess.TimeoutExpired:
        result.add_warning(filepath, "node --check timed out")
        result.skipped.append(filepath)
    except Exception as e:
        result.add_warning(filepath, f"node check failed: {e}")
        result.skipped.append(filepath)


def _check_html(filepath: str, result: SyntaxCheckResult) -> None:
    """Basic HTML well-formedness check using Python's html.parser.
    Note: html.parser is lenient — this catches egregious malformation only."""
    from html.parser import HTMLParser

    class _StrictParser(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.errors: List[str] = []

        def handle_entityref(self, name):
            pass  # tolerate &entities;

    try:
        text = pathlib.Path(filepath).read_text(encoding="utf-8",
                                                 errors="replace")
        parser = _StrictParser()
        parser.feed(text)
        result.checked.append(filepath)
        logger.debug(f"HTML OK: {filepath}")
    except Exception as e:
        result.add_error(file=filepath, message=str(e))
        result.checked.append(filepath)
        logger.warning(f"HTML error: {filepath} — {e}")


# ─── EXTENSION → CHECKER DISPATCH ────────────────────────────────────────────

_CHECKER_MAP = {
    ".py":   _check_python,
    ".json": _check_json,
    ".yaml": _check_yaml,
    ".yml":  _check_yaml,
    ".js":   _check_js_ts,
    ".ts":   _check_js_ts,
    ".jsx":  _check_js_ts,
    ".tsx":  _check_js_ts,
    ".html": _check_html,
    ".htm":  _check_html,
}


# ─── PUBLIC API ───────────────────────────────────────────────────────────────


def check_files(
    filepaths: List[str],
    repo_path: str = ".",
    skip_patterns: Optional[List[str]] = None,
) -> SyntaxCheckResult:
    """Run syntax checks on a list of file paths.

    Parameters
    ----------
    filepaths:
        Relative or absolute paths to files to check.
        Typically the list of pending/staged files from git_ops.
    repo_path:
        Root of the repository — used to resolve relative paths.
    skip_patterns:
        Optional list of glob patterns (e.g. ["migrations/*", "vendor/*"])
        to skip without checking.

    Returns
    -------
    SyntaxCheckResult  — .passed is True only if zero errors found.
    """
    result = SyntaxCheckResult()
    root = pathlib.Path(repo_path).resolve()
    skip_patterns = skip_patterns or []

    import fnmatch as _fnmatch

    for rel_path in filepaths:
        abs_path = (root / rel_path).resolve() if not pathlib.Path(rel_path).is_absolute() \
                   else pathlib.Path(rel_path).resolve()

        # Skip if file no longer exists (e.g. deleted files)
        if not abs_path.exists():
            logger.debug(f"Skipping deleted/missing file: {rel_path}")
            continue

        # Skip if matches a user-defined skip pattern
        if any(_fnmatch.fnmatch(rel_path, pat) for pat in skip_patterns):
            result.skipped.append(rel_path)
            logger.debug(f"Skipping (pattern match): {rel_path}")
            continue

        ext = abs_path.suffix.lower()
        checker = _CHECKER_MAP.get(ext)

        if checker is None:
            result.skipped.append(rel_path)
            logger.debug(f"No checker for {ext} — skipping {rel_path}")
            continue

        checker(str(abs_path), result)

    logger.info(result.summary())
    return result


def check_staged_files(
    repo_path: str = ".",
    skip_patterns: Optional[List[str]] = None,
) -> SyntaxCheckResult:
    """Convenience wrapper: get staged+pending filenames from git_ops,
    then run check_files on them.

    Uses git_ops to resolve the true list of files about to be committed.
    """
    try:
        from git_ops import get_git_ops
        ops = get_git_ops(repo_path)
        if not ops.is_valid():
            logger.warning("check_staged_files: invalid repo — skipping")
            result = SyntaxCheckResult()
            result.add_warning(".", "No valid git repo — syntax check skipped")
            return result

        # Collect filenames from git diff (staged + unstaged)
        diff_text = ops.get_diff()
        import re
        filenames = re.findall(r'diff --git a/\S+ b/(\S+)', diff_text)
        # Also include untracked files that haven't been staged yet
        try:
            filenames += ops.repo.untracked_files
        except Exception:
            pass

        # Deduplicate
        seen: set = set()
        unique = [f for f in filenames if not (f in seen or seen.add(f))]

        if not unique:
            result = SyntaxCheckResult()
            result.add_warning(".", "No files to check")
            return result

        return check_files(unique, repo_path=repo_path,
                           skip_patterns=skip_patterns)

    except Exception as e:
        logger.error(f"check_staged_files failed: {e}")
        result = SyntaxCheckResult()
        result.add_warning(".", f"Syntax check failed unexpectedly: {e}")
        return result
