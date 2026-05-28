#!/usr/bin/env python3
import glob
import json
import os
import re
import subprocess
from datetime import datetime


def slugify_project_path(path):
    return path.replace("/", "-")


def read_jsonl(path):
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue
    except Exception:
        return


def timestamp_key(value):
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        try:
            return float(text)
        except ValueError:
            pass
        try:
            normalized = text.replace("Z", "+00:00")
            return datetime.fromisoformat(normalized).timestamp()
        except ValueError:
            return 0
    return 0


def matches_cwd(project, cwd_filter):
    if not cwd_filter:
        return True
    if not project:
        return False
    norm_project = os.path.normpath(project)
    norm_filter = os.path.normpath(cwd_filter)
    return norm_project == norm_filter or norm_filter.startswith(norm_project + os.sep)


def compact_title(title):
    title = (title or "").strip()
    if not title:
        return "Untitled session"

    is_vibesync_handoff = re.match(r"^#\s*.*VIBESYNC CONTEXT HANDOVER", title, re.IGNORECASE | re.DOTALL)
    vibehandoff = re.search(r"Sync Session:\s*([A-Z][A-Z0-9 _-]+)", title)
    if is_vibesync_handoff and vibehandoff:
        return f"VibeSync handoff from {vibehandoff.group(1).strip().title()}"
    if is_vibesync_handoff:
        return "VibeSync handoff prompt"

    title = re.sub(r"\s+", " ", title)
    return title[:160]


def text_from_blocks(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") in ("text", "input_text", "output_text"):
                    parts.append(block.get("text", ""))
                elif "content" in block and isinstance(block.get("content"), str):
                    parts.append(block.get("content", ""))
        return "\n".join(p for p in parts if p)
    if isinstance(content, dict):
        return text_from_blocks(content.get("content") or content.get("text") or "")
    return ""


class SessionParser:
    def __init__(self, claude_dir=None, antigravity_dir=None, codex_dir=None, opencode_dirs=None):
        self.home = os.path.expanduser("~")
        self.claude_dir = claude_dir or os.path.join(self.home, ".claude")
        self.antigravity_dir = antigravity_dir or os.path.join(self.home, ".gemini", "antigravity-cli")
        self.codex_dir = codex_dir or os.path.join(self.home, ".codex")

        if opencode_dirs is None:
            env_dirs = os.environ.get("OPENCODE_DATA_DIR", "")
            configured = [p for p in env_dirs.split(",") if p.strip()]
            self.opencode_dirs = configured or [os.path.join(self.home, ".local", "share", "opencode")]
        else:
            self.opencode_dirs = opencode_dirs

        self.agent_registry = {
            "claude": {
                "label": "Claude Code",
                "list": self.get_claude_sessions,
                "parse": self.parse_claude_transcript,
            },
            "codex": {
                "label": "Codex",
                "list": self.get_codex_sessions,
                "parse": self.parse_codex_transcript,
            },
            "antigravity": {
                "label": "Antigravity CLI",
                "list": self.get_antigravity_sessions,
                "parse": self.parse_antigravity_transcript,
            },
            "opencode": {
                "label": "OpenCode",
                "list": self.get_opencode_sessions,
                "parse": self.parse_opencode_transcript,
            },
        }

    def get_git_info(self, project_path):
        """Fetches active git branch and short status of the project directory."""
        info = {"branch": "", "status": "", "diff": ""}
        if not os.path.exists(project_path) or not os.path.isdir(project_path):
            return info
        try:
            branch_cmd = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=project_path, capture_output=True, text=True, check=False
            )
            if branch_cmd.returncode == 0:
                info["branch"] = branch_cmd.stdout.strip()

            status_cmd = subprocess.run(
                ["git", "status", "-s"],
                cwd=project_path, capture_output=True, text=True, check=False
            )
            if status_cmd.returncode == 0:
                info["status"] = status_cmd.stdout.strip()

            diff_cmd = subprocess.run(
                ["git", "diff", "--stat"],
                cwd=project_path, capture_output=True, text=True, check=False
            )
            if diff_cmd.returncode == 0:
                info["diff"] = diff_cmd.stdout.strip()
        except Exception:
            pass
        return info

    def get_claude_sessions(self, cwd_filter=None):
        sessions = {}
        history_path = os.path.join(self.claude_dir, "history.jsonl")

        for data in read_jsonl(history_path) or []:
            sid = data.get("sessionId")
            project = data.get("project")
            if not sid or not project or not matches_cwd(project, cwd_filter):
                continue

            if sid not in sessions:
                sessions[sid] = {
                    "id": sid,
                    "agent": "claude",
                    "agent_label": "Claude Code",
                    "title": compact_title(data.get("display", "")),
                    "raw_title": data.get("display", ""),
                    "project": project,
                    "timestamp": data.get("timestamp"),
                    "history_count": 1
                }
            else:
                sessions[sid]["history_count"] += 1
                if timestamp_key(data.get("timestamp")) > timestamp_key(sessions[sid]["timestamp"]):
                    sessions[sid]["timestamp"] = data.get("timestamp")
                    sessions[sid]["title"] = compact_title(data.get("display", sessions[sid]["title"]))
                    sessions[sid]["raw_title"] = data.get("display", sessions[sid].get("raw_title", ""))

        valid_sessions = []
        for sid, s in sessions.items():
            slug = slugify_project_path(s["project"])
            transcript_path = os.path.join(self.claude_dir, "projects", slug, f"{sid}.jsonl")
            if os.path.exists(transcript_path):
                s["transcript_path"] = transcript_path
                valid_sessions.append(s)

        return sorted(valid_sessions, key=lambda x: timestamp_key(x["timestamp"]), reverse=True)

    def get_antigravity_sessions(self, cwd_filter=None):
        sessions = {}
        history_path = os.path.join(self.antigravity_dir, "history.jsonl")

        for data in read_jsonl(history_path) or []:
            cid = data.get("conversationId")
            workspace = data.get("workspace")
            if not cid or not workspace or not matches_cwd(workspace, cwd_filter):
                continue

            if cid not in sessions:
                sessions[cid] = {
                    "id": cid,
                    "agent": "antigravity",
                    "agent_label": "Antigravity CLI",
                    "title": compact_title(data.get("display", "")),
                    "raw_title": data.get("display", ""),
                    "project": workspace,
                    "timestamp": data.get("timestamp"),
                    "history_count": 1
                }
            else:
                sessions[cid]["history_count"] += 1
                if timestamp_key(data.get("timestamp")) > timestamp_key(sessions[cid]["timestamp"]):
                    sessions[cid]["timestamp"] = data.get("timestamp")
                    sessions[cid]["title"] = compact_title(data.get("display", sessions[cid]["title"]))
                    sessions[cid]["raw_title"] = data.get("display", sessions[cid].get("raw_title", ""))

        valid_sessions = []
        for cid, s in sessions.items():
            transcript_path = os.path.join(
                self.antigravity_dir, "brain", cid, ".system_generated", "logs", "transcript.jsonl"
            )
            if os.path.exists(transcript_path):
                s["transcript_path"] = transcript_path
                valid_sessions.append(s)

        return sorted(valid_sessions, key=lambda x: timestamp_key(x["timestamp"]), reverse=True)

    def get_codex_sessions(self, cwd_filter=None):
        index = {}
        index_path = os.path.join(self.codex_dir, "session_index.jsonl")
        for data in read_jsonl(index_path) or []:
            sid = data.get("id")
            if not sid:
                continue
            if sid not in index or timestamp_key(data.get("updated_at")) >= timestamp_key(index[sid].get("updated_at")):
                index[sid] = data

        sessions = {}
        pattern = os.path.join(self.codex_dir, "sessions", "**", "*.jsonl")
        for transcript_path in glob.glob(pattern, recursive=True):
            sid_from_name = os.path.basename(transcript_path).removesuffix(".jsonl").split("-")[-5:]
            sid_from_name = "-".join(sid_from_name) if sid_from_name else ""
            meta = None
            for data in read_jsonl(transcript_path) or []:
                if data.get("type") == "session_meta":
                    meta = data.get("payload", {})
                    break
            if not meta:
                continue

            sid = meta.get("id") or sid_from_name
            project = meta.get("cwd") or ""
            if not sid or not project or not matches_cwd(project, cwd_filter):
                continue

            indexed = index.get(sid, {})
            sessions[sid] = {
                "id": sid,
                "agent": "codex",
                "agent_label": "Codex",
                "title": compact_title(indexed.get("thread_name") or meta.get("originator") or "Codex session"),
                "raw_title": indexed.get("thread_name") or "",
                "project": project,
                "timestamp": indexed.get("updated_at") or meta.get("timestamp"),
                "history_count": 1,
                "transcript_path": transcript_path,
            }

        return sorted(sessions.values(), key=lambda x: timestamp_key(x["timestamp"]), reverse=True)

    def get_opencode_sessions(self, cwd_filter=None):
        sessions = {}
        for root in self.opencode_dirs:
            root = os.path.expanduser(root)
            if not os.path.exists(root):
                continue

            session_files = []
            session_files.extend(glob.glob(os.path.join(root, "storage", "session", "*", "*.json"), recursive=True))
            session_files.extend(glob.glob(os.path.join(root, "project", "*", "storage", "session", "*", "*.json"), recursive=True))
            session_files.extend(glob.glob(os.path.join(root, "project", "*", "storage", "session", "*.json"), recursive=True))

            for session_path in session_files:
                try:
                    with open(session_path, "r", encoding="utf-8", errors="ignore") as f:
                        data = json.load(f)
                except Exception:
                    continue

                sid = data.get("id") or os.path.splitext(os.path.basename(session_path))[0]
                project = data.get("cwd") or data.get("path") or data.get("projectPath")
                if not project and isinstance(data.get("project"), dict):
                    project = data.get("project", {}).get("path")
                project = project or self._project_from_opencode_session_path(root, session_path)
                if not sid or not matches_cwd(project, cwd_filter):
                    continue

                timestamp = data.get("updated") or data.get("updatedAt")
                if not timestamp and isinstance(data.get("time"), dict):
                    timestamp = data.get("time", {}).get("updated") or data.get("time", {}).get("created")
                timestamp = timestamp or data.get("created") or data.get("createdAt")

                sessions[sid] = {
                    "id": sid,
                    "agent": "opencode",
                    "agent_label": "OpenCode",
                    "title": compact_title(data.get("title") or data.get("name") or data.get("summary") or "OpenCode session"),
                    "raw_title": data.get("title") or data.get("name") or data.get("summary") or "",
                    "project": project,
                    "timestamp": timestamp,
                    "history_count": 1,
                    "transcript_path": session_path,
                    "message_dir": self._opencode_message_dir(root, sid, session_path),
                }

        return sorted(sessions.values(), key=lambda x: timestamp_key(x["timestamp"]), reverse=True)

    def _project_from_opencode_session_path(self, root, session_path):
        rel = os.path.relpath(session_path, root)
        parts = rel.split(os.sep)
        if len(parts) >= 2 and parts[0] == "project":
            return parts[1] if parts[1] != "global" else self.home
        return self.home

    def _opencode_message_dir(self, root, sid, session_path):
        candidates = [
            os.path.join(root, "storage", "message", sid),
        ]
        rel = os.path.relpath(session_path, root)
        parts = rel.split(os.sep)
        if len(parts) >= 3 and parts[0] == "project":
            candidates.append(os.path.join(root, "project", parts[1], "storage", "message", sid))
        return next((p for p in candidates if os.path.isdir(p)), candidates[0])

    def resolve_session_for_context(self, cwd=None, agent=None):
        """
        Resolve the best session match for a terminal context.
        Returns (session, candidates, reason, confidence).
        session is None when no confident match found.
        """
        if not cwd:
            return None, [], "terminal cwd is required", 0
        if not agent or agent not in self.agent_registry:
            return None, [], "supported coding agent command is required", 0

        # Do not search other agents. A hotkey copy must fail rather than copy
        # a plausible but wrong session from the same workspace.
        candidates = self.agent_registry[agent]["list"](cwd_filter=cwd)

        if not candidates:
            return None, [], f"no {agent} sessions matched terminal cwd", 0

        norm_cwd = os.path.normpath(cwd)

        def match_rank(candidate):
            project = os.path.normpath(candidate["project"])
            exact = project == norm_cwd
            parent = norm_cwd.startswith(project + os.sep)
            return (1 if exact else 0, 1 if parent else 0, timestamp_key(candidate["timestamp"]))

        # Exact cwd wins over broader parent workspaces; timestamp only breaks
        # ties inside the same match class.
        candidates.sort(key=match_rank, reverse=True)

        top = candidates[0]

        confidence = 0.5
        reason = "matched by cwd"

        if agent and top["agent"] == agent:
            confidence += 0.2
            reason = "matched agent and cwd"

        if cwd and top["project"] == cwd:
            confidence += 0.2
            if reason == "matched agent and cwd":
                reason = "exact agent and cwd match"
            else:
                reason = "exact cwd match"
        elif cwd and os.path.normpath(cwd).startswith(
            os.path.normpath(top["project"]) + os.sep
        ):
            confidence += 0.1

        # Boost for recent sessions (within 1 hour)
        now = datetime.now().timestamp()
        if abs(timestamp_key(top["timestamp"]) - now) < 3600:
            confidence += 0.1

        confidence = min(confidence, 1.0)

        return top, candidates, reason, confidence

    def list_all_sessions(self, cwd=None, limit=20):
        all_sessions = []
        for agent in self.agent_registry.values():
            all_sessions.extend(agent["list"](cwd))
        all_sessions = sorted(all_sessions, key=lambda x: timestamp_key(x["timestamp"]), reverse=True)
        return all_sessions[:limit]

    def parse_claude_transcript(self, path):
        steps = []
        for data in read_jsonl(path) or []:
            ltype = data.get("type")
            ts = data.get("timestamp")

            if ltype == "user":
                msg = data.get("message", {})
                content = msg.get("content", "")
                if "<local-command-caveat>" in content:
                    continue
                steps.append({
                    "role": "user",
                    "content": text_from_blocks(content),
                    "timestamp": ts,
                    "cwd": data.get("cwd", ""),
                    "git_branch": data.get("gitBranch", "")
                })
            elif ltype == "assistant":
                msg = data.get("message", {})
                content_blocks = msg.get("content", [])
                text_parts = []
                tool_calls = []
                for block in content_blocks:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        text_parts.append(block.get("text", ""))
                    elif btype == "tool_use":
                        tool_calls.append({
                            "name": block.get("name"),
                            "input": block.get("input")
                        })
                steps.append({
                    "role": "assistant",
                    "content": "\n".join(text_parts),
                    "tool_calls": tool_calls,
                    "timestamp": ts
                })
        return steps

    def parse_antigravity_transcript(self, path):
        steps = []
        for data in read_jsonl(path) or []:
            source = data.get("source")
            ltype = data.get("type")
            ts = data.get("created_at")
            content = data.get("content", "")

            if source == "USER_EXPLICIT" or ltype == "USER_INPUT":
                req_match = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
                if req_match:
                    content = req_match.group(1).strip()
                steps.append({
                    "role": "user",
                    "content": content,
                    "timestamp": ts
                })
            elif source == "MODEL" or ltype == "PLANNER_RESPONSE":
                steps.append({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": data.get("tool_calls", []),
                    "timestamp": ts
                })
        return steps

    def parse_codex_transcript(self, path):
        steps = []
        for data in read_jsonl(path) or []:
            ts = data.get("timestamp")
            if data.get("type") == "response_item":
                payload = data.get("payload", {})
                ptype = payload.get("type")
                if ptype == "message":
                    role = payload.get("role")
                    if role in ("user", "assistant"):
                        steps.append({
                            "role": role,
                            "content": text_from_blocks(payload.get("content", [])),
                            "timestamp": ts,
                            "tool_calls": []
                        })
                elif ptype == "function_call" and steps:
                    steps[-1].setdefault("tool_calls", []).append({
                        "name": payload.get("name"),
                        "input": self._safe_json(payload.get("arguments"))
                    })
            elif data.get("type") == "event_msg":
                payload = data.get("payload", {})
                if payload.get("type") == "user_message":
                    steps.append({
                        "role": "user",
                        "content": payload.get("message", ""),
                        "timestamp": ts,
                        "tool_calls": []
                    })
                elif payload.get("type") == "agent_message":
                    steps.append({
                        "role": "assistant",
                        "content": payload.get("message", ""),
                        "timestamp": ts,
                        "tool_calls": []
                    })
        return steps

    def parse_opencode_transcript(self, path):
        steps = []
        session = {}
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                session = json.load(f)
        except Exception:
            session = {}

        inline_messages = (
            session.get("messages")
            or session.get("message")
            or session.get("history")
            or []
        )
        if isinstance(inline_messages, list):
            for msg in inline_messages:
                self._append_opencode_message(steps, msg)

        message_dir = session.get("message_dir")
        if not message_dir:
            sid = session.get("id") or os.path.splitext(os.path.basename(path))[0]
            root = self._infer_opencode_root(path)
            message_dir = self._opencode_message_dir(root, sid, path)

        for message_path in sorted(glob.glob(os.path.join(message_dir, "*.json"))):
            try:
                with open(message_path, "r", encoding="utf-8", errors="ignore") as f:
                    self._append_opencode_message(steps, json.load(f))
            except Exception:
                continue

        return steps

    def _infer_opencode_root(self, path):
        for root in self.opencode_dirs:
            root = os.path.expanduser(root)
            try:
                os.path.relpath(path, root)
                if os.path.commonpath([root, path]) == root:
                    return root
            except ValueError:
                continue
        return os.path.dirname(path)

    def _append_opencode_message(self, steps, msg):
        if not isinstance(msg, dict):
            return
        role = msg.get("role") or msg.get("author", {}).get("role")
        if role not in ("user", "assistant"):
            return
        content = (
            msg.get("content")
            or msg.get("text")
            or msg.get("parts")
            or msg.get("message")
            or ""
        )
        steps.append({
            "role": role,
            "content": text_from_blocks(content),
            "timestamp": msg.get("time") or msg.get("created") or msg.get("createdAt"),
            "tool_calls": msg.get("tool_calls") or msg.get("toolCalls") or []
        })

    def _safe_json(self, value):
        if isinstance(value, dict):
            return value
        if not isinstance(value, str):
            return {}
        try:
            return json.loads(value)
        except Exception:
            return {}

    def _extract_tool_hints(self, agent, tool_call):
        name = tool_call.get("name")
        inp = tool_call.get("input") or {}
        commands = []
        files = []

        if agent == "claude":
            if name in ("bash", "execute_command"):
                cmd = inp.get("command")
                if cmd:
                    commands.append(cmd)
            elif name in ("write_file", "view_file", "edit_file", "replace_file_content", "multi_replace_file_content"):
                p = inp.get("path") or inp.get("TargetFile") or inp.get("AbsolutePath")
                if p:
                    files.append(os.path.basename(p))
        elif agent == "antigravity":
            if name == "run_command":
                cmd = inp.get("CommandLine")
                if cmd:
                    commands.append(cmd)
            elif name in ("write_to_file", "replace_file_content", "multi_replace_file_content", "view_file"):
                p = inp.get("TargetFile") or inp.get("AbsolutePath")
                if p:
                    files.append(os.path.basename(p))
        elif agent == "codex":
            if name in ("exec_command", "shell"):
                cmd = inp.get("cmd") or inp.get("command")
                if cmd:
                    commands.append(cmd)
            elif name in ("apply_patch", "view_image"):
                p = inp.get("path") or inp.get("file")
                if p:
                    files.append(os.path.basename(p))
        elif agent == "opencode":
            if name in ("bash", "shell", "run", "execute", "exec"):
                cmd = inp.get("command") or inp.get("cmd")
                if cmd:
                    commands.append(cmd)
            p = inp.get("path") or inp.get("file") or inp.get("filename")
            if p:
                files.append(os.path.basename(p))

        return commands, files

    def get_session_details(self, agent, sid):
        registry = self.agent_registry.get(agent)
        if not registry:
            return None

        sessions = registry["list"]()
        session = next((s for s in sessions if s["id"] == sid), None)
        if not session:
            session = next((s for s in sessions if s["id"].startswith(sid)), None)
        if not session:
            return None

        path = session["transcript_path"]
        raw_steps = registry["parse"](path)

        first_prompt = ""
        last_prompt = ""
        last_response = ""
        commands = []
        files_touched = set()
        conversation = []

        for index, step in enumerate(raw_steps):
            role = step["role"]
            content = step.get("content") or ""
            display_content = re.sub(r"<thought>.*?</thought>", "", content, flags=re.DOTALL).strip()
            truncated = len(display_content) > 4000
            conversation.append({
                "index": index + 1,
                "role": role,
                "content": display_content[:4000],
                "timestamp": step.get("timestamp"),
                "tool_count": len(step.get("tool_calls", [])),
                "truncated": truncated
            })

            if role == "user":
                if not first_prompt:
                    first_prompt = content
                last_prompt = content
            elif role == "assistant":
                last_response = content
                for tc in step.get("tool_calls", []):
                    tool_commands, tool_files = self._extract_tool_hints(agent, tc)
                    commands.extend(tool_commands)
                    files_touched.update(tool_files)

        seen = set()
        dedup_commands = []
        for c in commands:
            c_strip = c.strip()
            if c_strip and c_strip not in seen:
                seen.add(c_strip)
                dedup_commands.append(c_strip)

        git_info = self.get_git_info(session["project"])
        clean_resp = re.sub(r"<thought>.*?</thought>", "", last_response, flags=re.DOTALL).strip()

        project_path = os.path.abspath(session["project"])
        transcript_path = os.path.abspath(path)
        takeover_prompt = (
            "You are taking over from another local coding agent.\n\n"
            f"Source agent: {registry['label']}\n"
            f"Source session id: {session['id']}\n"
            f"Workspace: `{project_path}`\n"
            f"Source transcript: `{transcript_path}`\n"
            f"Active branch: `{git_info['branch'] or 'N/A'}`\n\n"
            "Task:\n"
            "Read the source transcript enough to reconstruct the current working context, "
            "then continue in the workspace above.\n\n"
            "Reading protocol:\n"
            "1. Inspect the transcript format first; do not ingest the whole file blindly.\n"
            "2. Extract the original goal, latest user request, decisions made, files read/edited, "
            "commands run, unresolved work, and next concrete step.\n"
            "3. Check the current repo state with git status and relevant diffs.\n"
            "4. Continue from the reconstructed context.\n\n"
            "If sandbox restrictions prevent reading the transcript path, ask the user to allow "
            "access or paste/export the transcript.\n"
        )

        if git_info["status"]:
            takeover_prompt += f"\nCurrent git status:\n```text\n{git_info['status']}\n```\n"

        return {
            "metadata": session,
            "git": git_info,
            "first_prompt": first_prompt,
            "last_prompt": last_prompt,
            "last_response": clean_resp,
            "files_touched": sorted(list(files_touched)),
            "commands": dedup_commands,
            "conversation": conversation,
            "takeover_prompt": takeover_prompt,
            "raw_steps_count": len(raw_steps)
        }
