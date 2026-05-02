import re
import uuid
import logging
import difflib
from typing import Optional
from llm import generate_message, is_available
from state_utils import state

logger = logging.getLogger("gitmind.analyzer")

class DiffAnalyzer:
    def analyze(self, diff: str, files: list) -> dict:
        """Parses a raw git diff string into structured per-file stats."""
        file_stats = []
        chunks = diff.split("diff --git ")
        
        found_files = set()

        for chunk in chunks:
            if not chunk.strip():
                continue
            
            # Add back the split delimiter for matching
            chunk = "diff --git " + chunk
            
            # filename
            match = re.search(r'diff --git a/\S+ b/(\S+)', chunk)
            if not match:
                continue
            filename = match.group(1)
            found_files.add(filename)
            
            # lines_added
            lines_added = len(re.findall(r'^\+[^+]', chunk, re.MULTILINE))
            
            # lines_removed
            lines_removed = len(re.findall(r'^-[^-]', chunk, re.MULTILINE))
            
            # change_type
            if "new file mode" in chunk:
                change_type = "added"
            elif "deleted file mode" in chunk:
                change_type = "deleted"
            else:
                change_type = "modified"
                
            # diff_chunk (first 500 chars)
            diff_chunk = chunk[:500]
            
            file_stats.append({
                "filename": filename,
                "lines_added": lines_added,
                "lines_removed": lines_removed,
                "change_type": change_type,
                "diff_chunk": diff_chunk
            })

        # If a file in the `files` parameter was NOT found in the diff,
        # add it with zeros and change_type="modified"
        for f in files:
            if f not in found_files:
                file_stats.append({
                    "filename": f,
                    "lines_added": 0,
                    "lines_removed": 0,
                    "change_type": "modified",
                    "diff_chunk": ""
                })

        total_files = len(file_stats)
        total_additions = sum(s["lines_added"] for s in file_stats)
        total_deletions = sum(s["lines_removed"] for s in file_stats)
        change_density = (total_additions + total_deletions) / max(total_files, 1)

        return {
            "file_stats": file_stats,
            "summary": {
                "total_files": total_files,
                "total_additions": total_additions,
                "total_deletions": total_deletions,
                "change_density": change_density
            }
        }


class SemanticGrouper:
    def _categorize(self, filename: str) -> str:
        f = filename.lower()
        name = f.split("/")[-1]   # basename only
        
        # Test/spec files
        if any(p in name for p in ["test", "spec", ".test.", ".spec."]):
            return "test"
        
        # Documentation
        if name.endswith((".md", ".txt", ".rst", ".adoc")):
            return "docs"
        
        # Configuration
        if any(p in name for p in ["config", ".env", "settings"]) or \
           name.endswith((".yaml", ".yml", ".toml", ".ini", ".json")):
            return "config"
        
        # Styling
        if any(p in name for p in ["style", "theme", "design"]) or \
           name.endswith((".css", ".scss", ".less", ".sass")):
            return "style"
        
        # Auth
        if any(p in name for p in ["auth", "login", "logout",
                                    "token", "password", "session",
                                    "jwt", "oauth"]):
            return "auth"
        
        # UI / Frontend
        if name.endswith((".tsx", ".jsx")) or \
           any(p in f for p in ["/components/", "/pages/",
                                 "/views/", "/ui/"]):
            return "ui"
        
        # Backend / API
        if any(p in f for p in ["/routes/", "/api/", "/controllers/",
                                 "/handlers/", "/middleware/"]):
            return "backend"
        
        # Database / models
        if any(p in f for p in ["/models/", "/migrations/",
                                 "/schemas/", "/db/"]):
            return "data"
        
        return "general"

    def _default_summary(self, category: str, files: list) -> str:
        count = len(files)
        names = ", ".join(f.split("/")[-1] for f in files[:2])
        suffix = f" (+{count-2} more)" if count > 2 else ""
        labels = {
            "test":    "test coverage",
            "docs":    "documentation",
            "config":  "configuration",
            "style":   "styling",
            "auth":    "authentication logic",
            "ui":      "UI components",
            "backend": "API/route logic",
            "data":    "data models",
            "general": "miscellaneous changes"
        }
        return f"Update {labels.get(category,'changes')}: {names}{suffix}"

    def group(self, files: list, diff_analysis: dict,
              use_ai: bool = True) -> list[dict]:
        """Implements the TWO-LAYER hybrid grouping approach."""
        
        # LAYER 1 — Heuristic Grouping
        buckets: dict[str, list[str]] = {}
        for f in files:
            cat = self._categorize(f)
            buckets.setdefault(cat, []).append(f)

        preliminary = []
        for category, file_list in buckets.items():
            preliminary.append({
                "id":         f"grp_{uuid.uuid4().hex[:8]}",
                "type":       category,
                "files":      file_list,
                "summary":    self._default_summary(category, file_list),
                "confidence": 0.70,
                "source":     "heuristic"
            })

        # LAYER 2 — AI Refinement
        if use_ai and is_available() and len(files) > 3:
            file_list_str = "\n".join(f"- {f}" for f in files)
            prelim_str = "\n".join(
                f"{g['type']}: {', '.join(g['files'])}"
                for g in preliminary
            )
            
            prompt = f"""You are an expert software engineer analyzing a git commit.

Files changed:
{file_list_str}

Preliminary grouping (heuristic):
{prelim_str}

Refine these into logical commit groups based on developer intent.
Return ONLY a valid JSON array. Each item must have:
  "type": one of [feat, fix, refactor, config, ui, test, auth, style, docs, chore, data, general]
  "files": array of filenames from the list above
  "summary": one sentence describing intent
  "confidence": float 0.0-1.0

Rules:
- Every file must appear in exactly one group
- Do not invent files not in the original list
- Prefer 2-5 meaningful groups over many tiny ones
- Return ONLY the JSON array, no markdown, no explanation"""

            try:
                from llm import call_llm
                import json as _json
                
                raw = call_llm(prompt, max_tokens=500)
                
                # Strip markdown fences if present
                clean = raw.strip()
                if clean.startswith("```"):
                    clean = re.sub(r'^```[a-z]*\n?', '', clean)
                    clean = re.sub(r'\n?```$', '', clean)
                
                ai_groups_raw = _json.loads(clean)
                
                # Validate structure
                ai_groups = []
                all_assigned = set()
                for g in ai_groups_raw:
                    if not isinstance(g.get("files"), list):
                        continue
                    valid_files = [f for f in g["files"] if f in files]
                    if not valid_files:
                        continue
                    ai_groups.append({
                        "id":         f"grp_{uuid.uuid4().hex[:8]}",
                        "type":       g.get("type", "general"),
                        "files":      valid_files,
                        "summary":    g.get("summary", ""),
                        "confidence": float(g.get("confidence", 0.80)),
                        "source":     "ai"
                    })
                    all_assigned.update(valid_files)
                
                # Re-add any files the AI dropped (must not lose files)
                unassigned = [f for f in files if f not in all_assigned]
                if unassigned:
                    ai_groups.append({
                        "id":         f"grp_{uuid.uuid4().hex[:8]}",
                        "type":       "general",
                        "files":      unassigned,
                        "summary":    f"Additional changes: {len(unassigned)} file(s)",
                        "confidence": 0.60,
                        "source":     "ai_overflow"
                    })
                
                logger.info(f"AI grouping: {len(ai_groups)} group(s) from {len(files)} files")
                return ai_groups
            
            except RuntimeError:
                logger.warning("AI grouping failed — using heuristic groups")
                return preliminary
            except Exception as e:
                logger.error(f"AI grouping parse error: {e}")
                return preliminary

        return preliminary
