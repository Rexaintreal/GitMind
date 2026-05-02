import uuid
import logging
from typing import Optional
from llm import generate_message, call_llm, is_available
from fallback import rule_based_message, get_tone_instruction
from state_utils import state

logger = logging.getLogger("gitmind.planner")

class CommitPlanner:
    def _fallback_message(self, group: dict) -> str:
        type_map = {
            "feat":    "feat",   "fix":     "fix",
            "refactor":"refactor","config":  "chore",
            "ui":      "feat",   "test":    "test",
            "auth":    "feat",   "style":   "style",
            "docs":    "docs",   "data":    "refactor",
            "backend": "feat",   "general": "chore",
            "chore":   "chore"
        }
        prefix = type_map.get(group.get("type", "general"), "chore")
        files = group.get("files", [])
        if not files:
            return f"{prefix}: update files"
        names = ", ".join(f.split("/")[-1] for f in files[:2])
        suffix = f" (+{len(files)-2} more)" if len(files) > 2 else ""
        msg = f"{prefix}: update {names}{suffix}"
        return msg[:72]

    def _score(self, group: dict, diff_analysis: dict) -> float:
        summary = diff_analysis.get("summary", {})
        file_count  = len(group.get("files", []))
        density     = summary.get("change_density", 0)
        confidence  = group.get("confidence", 0.5)

        score = (
            min(file_count / 10, 1.0) * 30      # file count (max 30)
          + min(density / 20,  1.0) * 30        # change density (max 30)
          + confidence               * 40       # AI/heuristic confidence (max 40)
        )
        return round(min(score, 100.0), 2)

    def _confidence_label(self, score: float) -> str:
        if score >= 70: return "high"
        if score >= 40: return "medium"
        return "low"

    def plan(self, groups: list, diff_analysis: dict) -> list[dict]:
        """Builds a final commit plan by generating a message for each group."""
        results = []
        file_stats = diff_analysis.get("file_stats", [])
        tone = state.get("message_tone", "conventional")
        tone_instruction = get_tone_instruction(tone)

        for group in groups:
            group_chunks = []
            for stat in file_stats:
                if stat["filename"] in group["files"]:
                    chunk = stat.get("diff_chunk", "")
                    if chunk:
                        group_chunks.append(chunk)
            combined_diff = "\n".join(group_chunks)[:3000]

            if is_available() and combined_diff:
                try:
                    prompt = f"""Generate a commit message for these changes.
{tone_instruction}

Change type: {group['type']}
Files: {', '.join(group['files'])}
Summary: {group.get('summary', '')}
Code diff (truncated):
{combined_diff}

Return ONLY the commit message. Max 72 chars. No explanation."""
                    message = call_llm(prompt, max_tokens=100).strip()[:72]
                    source = "llm"
                except RuntimeError:
                    message = self._fallback_message(group)
                    source = "fallback"
            else:
                message = self._fallback_message(group)
                source = "fallback"

            score = self._score(group, diff_analysis)
            
            results.append({
                "id":               f"commit_{uuid.uuid4().hex[:8]}",
                "message":          message,
                "files":            group["files"],
                "type":             group["type"],
                "summary":          group.get("summary", ""),
                "score":            score,
                "confidence":       group.get("confidence", 0.70),
                "confidence_label": self._confidence_label(score),
                "group_id":         group["id"],
                "message_source":   source
            })

        return results
