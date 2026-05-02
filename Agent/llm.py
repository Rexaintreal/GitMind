"""
GitMind Agent — LLM Integration (Phase 3)
Synchronous HTTP calls to unclosed.ai for commit message generation.
Raises RuntimeError on ANY failure — caller must handle fallback.
"""

import httpx
import os
import logging
import json
import re
from dotenv import load_dotenv
from cache import get_cache

load_dotenv()
logger = logging.getLogger("gitmind.llm")

# ─── CONSTANTS ────────────────────────────────────────────────────────────────

API_KEY = os.getenv("UNCLOSED_API_KEY", "")
API_URL = os.getenv(
    "UNCLOSED_API_URL",
    "https://api.unclosed.ai/v1/chat/completions",
)
MODEL = os.getenv("UNCLOSED_MODEL", "qwen3-coder")
TIMEOUT = 10       # seconds — hard limit per spec
MAX_DIFF = 4000    # chars — truncate before sending

SYSTEM_PROMPT = """You are an expert Git commit message writer.
Use Conventional Commits format: <type>(<scope>): <description>

Types: feat, fix, refactor, chore, docs, style, test, perf.
Subject line: max 72 chars, imperative mood, no period.

After the subject, leave ONE blank line, then write 2-3 sentences explaining:
- What changed and why
- Any notable implementation details

Example:
feat(auth): add JWT refresh token rotation

Implements automatic rotation of refresh tokens on each use to reduce
the window of token theft. Tokens are stored hashed in Redis with a
7-day TTL. Old tokens are immediately invalidated on rotation.

Return ONLY the commit message. No markdown fences, no quotes."""

VALID_TYPES = {"feat", "fix", "refactor", "chore", "docs", "style", "test", "perf"}


# ─── FUNCTIONS ────────────────────────────────────────────────────────────────


def generate_message(diff: str) -> str:
    """Generate a single commit message from a git diff via unclosed.ai.

    Synchronous. Returns the cleaned message string.
    Raises RuntimeError on ANY failure so the caller knows to use fallback.
    """
    _c = get_cache()
    cached = _c.get(diff)
    if cached is not None:
        logger.debug(f"generate_message: cache hit → {cached!r}")
        return cached

    # 1. Truncate diff
    truncated = diff[:MAX_DIFF]
    if len(diff) > MAX_DIFF:
        truncated += f"\n... [diff truncated at {MAX_DIFF} chars]"

    # 2. Build prompt
    user_prompt = f"""Generate a commit message for this git diff:

{truncated}

Return only the commit message string."""

    # 3. Make request
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "max_tokens": 300,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }

    try:
        response = httpx.post(
            API_URL,
            headers=headers,
            json=payload,
            timeout=TIMEOUT,
        )
    except httpx.TimeoutException:
        logger.warning(f"LLM timeout after {TIMEOUT}s")
        raise RuntimeError("LLM timeout")
    except Exception as e:
        logger.error(f"LLM error: {e}")
        raise RuntimeError(str(e))

    # 4. Parse response
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error(f"LLM HTTP error: {e.response.status_code}")
        raise RuntimeError(f"LLM HTTP {e.response.status_code}")

    try:
        data = response.json()
        raw = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        logger.error("LLM response parse failed")
        raise RuntimeError("LLM parse error")
    except Exception as e:
        logger.error(f"LLM error: {e}")
        raise RuntimeError(str(e))

    # 5. Clean the raw string
    message = raw.strip()
    message = message.strip("\"'`")           # strip surrounding quotes/backticks
    message = re.sub(r"^commit\s+msg:\s*", "", message, flags=re.I) # strip prefixes
    
    # Ensure it's not just a block of markdown
    message = re.sub(r"^```[a-z]*\n", "", message)
    message = re.sub(r"\n```$", "", message)

    if not message:
        raise RuntimeError("LLM returned empty message")

    # Validate structure: must have subject line + body separated by blank line.
    # Some models (e.g. qwen3-coder) return only the subject. Instead of falling
    # back to rule_based_message, auto-synthesise a minimal body from the subject
    # so we still get a real commit message rather than "[gitmind-fallback]".
    parts = message.replace("\r\n", "\n").split("\n\n", 1)
    if len(parts) < 2 or not parts[1].strip():
        subject = parts[0].strip()
        logger.warning(f"LLM returned subject-only, synthesising body: {subject!r}")
        # Derive a minimal body: expand the subject into a sentence
        # and note that this was auto-expanded.
        body_lines = [
            f"Applied changes as described in the commit subject.",
            f"No additional context was provided by the model; body auto-generated.",
        ]
        message = subject + "\n\n" + "\n".join(body_lines)

    logger.info(f"LLM generated: {message!r}")
    _c.set(diff, message)
    return message


def is_available() -> bool:
    """Quick connectivity check for the unclosed.ai API.

    Returns True if API responds (even with 4xx),
    False only on network/timeout errors or missing API key.
    """
    if not API_KEY:
        logger.warning("UNCLOSED_API_KEY not set — LLM disabled")
        return False

    try:
        r = httpx.post(
            API_URL,
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}],
            },
            timeout=3,
        )
        return True  # any HTTP response means reachable
    except Exception:
        return False


def classify_intent(diff: str) -> str:
    """Classify the overall intent of a diff as a conventional commit type.

    Returns one of: feat, fix, refactor, chore, docs, style, test.
    Returns "chore" on any error.
    """
    truncated = diff[:2000]

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "max_tokens": 10,
        "messages": [
            {
                "role": "user",
                "content": (
                    "Classify this git diff into exactly one conventional "
                    "commit type.\n"
                    "Types: feat, fix, refactor, chore, docs, style, test.\n"
                    "Return only the single word type, nothing else.\n\n"
                    f"{truncated}"
                ),
            }
        ],
    }

    try:
        response = httpx.post(
            API_URL,
            headers=headers,
            json=payload,
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        raw = data["choices"][0]["message"]["content"]
        result = raw.strip().lower().split()[0]
        if result in VALID_TYPES:
            return result
        return "chore"
    except Exception:
        return "chore"


def call_llm(prompt: str, max_tokens: int = 500) -> str:
    """Low-level function to send a single user prompt to the LLM.
    Returns the raw response string. Raises RuntimeError on failure.
    """
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }

    try:
        response = httpx.post(
            API_URL,
            headers=headers,
            json=payload,
            timeout=TIMEOUT,
        )
    except httpx.TimeoutException:
        logger.warning(f"call_llm timeout after {TIMEOUT}s")
        raise RuntimeError("LLM timeout")
    except Exception as e:
        logger.error(f"call_llm error: {e}")
        raise RuntimeError(str(e))

    try:
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]
    except httpx.HTTPStatusError as e:
        logger.error(f"call_llm HTTP error: {e.response.status_code}")
        raise RuntimeError(f"LLM HTTP {e.response.status_code}")
    except (KeyError, IndexError):
        logger.error("call_llm response parse failed")
        raise RuntimeError("LLM parse error")
    except Exception as e:
        logger.error(f"call_llm error: {e}")
        raise RuntimeError(str(e))

