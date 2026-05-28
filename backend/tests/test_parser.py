import unittest
import tempfile
import os
import json
import shutil
import sys

# Ensure backend directory is in the path so we can import parser
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from parser import SessionParser, slugify_project_path

class TestSessionParser(unittest.TestCase):
    def setUp(self):
        # Create a isolated temporary workspace directory
        self.test_dir = tempfile.TemporaryDirectory()
        self.home = self.test_dir.name
        
        self.claude_dir = os.path.join(self.home, '.claude')
        self.antigravity_dir = os.path.join(self.home, '.gemini', 'antigravity-cli')
        self.codex_dir = os.path.join(self.home, '.codex')
        self.opencode_dir = os.path.join(self.home, '.local', 'share', 'opencode')
        
        os.makedirs(self.claude_dir, exist_ok=True)
        os.makedirs(self.antigravity_dir, exist_ok=True)
        os.makedirs(self.codex_dir, exist_ok=True)
        os.makedirs(self.opencode_dir, exist_ok=True)
        
        # Initialize parser using the injected temporary directories
        self.parser = SessionParser(
            claude_dir=self.claude_dir,
            antigravity_dir=self.antigravity_dir,
            codex_dir=self.codex_dir,
            opencode_dirs=[self.opencode_dir]
        )

    def tearDown(self):
        self.test_dir.cleanup()

    def test_empty_histories(self):
        """Verify that when no logs exist, the parser handles it cleanly and returns empty results."""
        self.assertEqual(self.parser.get_claude_sessions(), [])
        self.assertEqual(self.parser.get_antigravity_sessions(), [])
        self.assertEqual(self.parser.get_codex_sessions(), [])
        self.assertEqual(self.parser.get_opencode_sessions(), [])
        self.assertEqual(self.parser.list_all_sessions(), [])
        self.assertIsNone(self.parser.get_session_details("claude", "nonexistent-id"))
        self.assertIsNone(self.parser.get_session_details("unknown", "nonexistent-id"))

    def test_claude_session_parsing(self):
        """Verify that Claude CLI session logs are indexed and parsed correctly."""
        # 1. Write mock history.jsonl
        history_path = os.path.join(self.claude_dir, 'history.jsonl')
        project_path = '/Users/test/workspace'
        sid = 'claude-session-123'
        
        history_entry = {
            "sessionId": sid,
            "project": project_path,
            "display": "Create web dashboard",
            "timestamp": 1680000000.0
        }
        with open(history_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(history_entry) + '\n')
            
        # 2. Write mock transcript file
        slug = slugify_project_path(project_path)
        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        transcript_path = os.path.join(transcript_dir, f"{sid}.jsonl")
        
        # Write conversation steps
        steps = [
            # User turn
            {
                "type": "user",
                "timestamp": 1680000001.0,
                "cwd": project_path,
                "message": {
                    "content": "Initialize a new React app"
                }
            },
            # Assistant turn with tool calls
            {
                "type": "assistant",
                "timestamp": 1680000002.0,
                "message": {
                    "content": "Sure! I am running commands.",
                    "content": [
                        {"type": "text", "text": "Sure! I am running commands."},
                        {
                            "type": "tool_use",
                            "name": "bash",
                            "input": {"command": "npm init -y"}
                        },
                        {
                            "type": "tool_use",
                            "name": "write_file",
                            "input": {"path": f"{project_path}/index.js"}
                        }
                    ]
                }
            },
            # Final user turn
            {
                "type": "user",
                "timestamp": 1680000003.0,
                "message": {
                    "content": "Awesome, that works."
                }
            }
        ]
        with open(transcript_path, 'w', encoding='utf-8') as f:
            for s in steps:
                f.write(json.dumps(s) + '\n')

        # 3. Query sessions list
        sessions = self.parser.get_claude_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['id'], sid)
        self.assertEqual(sessions[0]['title'], 'Create web dashboard')
        self.assertEqual(sessions[0]['project'], project_path)

        # 4. Fetch details
        details = self.parser.get_session_details("claude", sid)
        self.assertIsNotNone(details)
        self.assertEqual(details['first_prompt'], 'Initialize a new React app')
        self.assertEqual(details['last_prompt'], 'Awesome, that works.')
        self.assertEqual(details['commands'], ['npm init -y'])
        self.assertEqual(details['files_touched'], ['index.js'])
        self.assertEqual(details['raw_steps_count'], 3)
        self.assertEqual(len(details['conversation']), 3)
        self.assertEqual(details['conversation'][0]['role'], 'user')
        self.assertEqual(details['conversation'][1]['tool_count'], 2)
        
        # Check generated takeover prompt formatting
        self.assertIn('takeover_prompt', details)
        self.assertNotIn('handover_prompt', details)
        self.assertIn("Source agent: Claude Code", details['takeover_prompt'])
        self.assertIn(f"Source session id: {sid}", details['takeover_prompt'])
        self.assertIn(f"Workspace: `{project_path}`", details['takeover_prompt'])
        self.assertIn(f"Source transcript: `{transcript_path}`", details['takeover_prompt'])
        self.assertIn("Inspect the transcript format first", details['takeover_prompt'])
        self.assertIn("Check the current repo state with git status", details['takeover_prompt'])

    def test_antigravity_session_parsing(self):
        """Verify that Antigravity planner session logs are indexed and parsed correctly."""
        # 1. Write mock history.jsonl
        history_path = os.path.join(self.antigravity_dir, 'history.jsonl')
        project_path = '/Users/test/antigravity-project'
        cid = 'antigravity-session-456'
        
        history_entry = {
            "conversationId": cid,
            "workspace": project_path,
            "display": "Build API server",
            "timestamp": 1680000100.0
        }
        with open(history_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(history_entry) + '\n')
            
        # 2. Write mock transcript file
        transcript_dir = os.path.join(self.antigravity_dir, 'brain', cid, '.system_generated', 'logs')
        os.makedirs(transcript_dir, exist_ok=True)
        transcript_path = os.path.join(transcript_dir, 'transcript.jsonl')
        
        steps = [
            # User Input
            {
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "created_at": 1680000101.0,
                "content": "<USER_REQUEST>Create a Python Flask app</USER_REQUEST>"
            },
            # Planner response with tool calls
            {
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "created_at": 1680000102.0,
                "content": "<thought>I need to run the server</thought>Starting backend.",
                "tool_calls": [
                    {
                        "name": "run_command",
                        "input": {
                            "CommandLine": "python3 app.py",
                            "Cwd": project_path
                        }
                    },
                    {
                        "name": "write_to_file",
                        "input": {
                            "TargetFile": f"{project_path}/app.py"
                        }
                    }
                ]
            }
        ]
        with open(transcript_path, 'w', encoding='utf-8') as f:
            for s in steps:
                f.write(json.dumps(s) + '\n')

        # 3. Query sessions list
        sessions = self.parser.get_antigravity_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['id'], cid)

        # 4. Fetch details
        details = self.parser.get_session_details("antigravity", cid)
        self.assertIsNotNone(details)
        self.assertEqual(details['first_prompt'], 'Create a Python Flask app')
        self.assertEqual(details['commands'], ['python3 app.py'])
        self.assertEqual(details['files_touched'], ['app.py'])
        self.assertEqual(details['raw_steps_count'], 2)
        self.assertEqual(len(details['conversation']), 2)
        self.assertEqual(details['conversation'][1]['content'], 'Starting backend.')
        self.assertEqual(details['conversation'][1]['tool_count'], 2)
        
        # Verify takeover prompt contains the data elements needed by the next local agent
        self.assertIn('takeover_prompt', details)
        self.assertNotIn('handover_prompt', details)
        self.assertIn("Source agent: Antigravity CLI", details['takeover_prompt'])
        self.assertIn(f"Source session id: {cid}", details['takeover_prompt'])
        self.assertIn(f"Workspace: `{project_path}`", details['takeover_prompt'])
        self.assertIn(f"Source transcript: `{transcript_path}`", details['takeover_prompt'])
        self.assertIn("Extract the original goal, latest user request", details['takeover_prompt'])
        self.assertIn("If sandbox restrictions prevent reading the transcript path", details['takeover_prompt'])

    def test_codex_session_parsing(self):
        """Verify that Codex session index and transcript logs are parsed correctly."""
        sid = '019e6aa8-8b9a-7ab0-85c3-a15fade8757f'
        project_path = '/Users/test/vibesync'

        index_path = os.path.join(self.codex_dir, 'session_index.jsonl')
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "id": sid,
                "thread_name": "Fix VibeSync session manager",
                "updated_at": "2026-05-27T18:18:18.590857Z"
            }) + '\n')

        transcript_dir = os.path.join(self.codex_dir, 'sessions', '2026', '05', '28')
        os.makedirs(transcript_dir, exist_ok=True)
        transcript_path = os.path.join(transcript_dir, f'rollout-2026-05-28T02-18-11-{sid}.jsonl')
        steps = [
            {
                "timestamp": "2026-05-27T18:18:13.269Z",
                "type": "session_meta",
                "payload": {
                    "id": sid,
                    "timestamp": "2026-05-27T18:18:11.226Z",
                    "cwd": project_path,
                    "originator": "Codex Desktop"
                }
            },
            {
                "timestamp": "2026-05-27T18:18:14.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Implement four agent support"}]
                }
            },
            {
                "timestamp": "2026-05-27T18:18:15.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I will inspect the parser."}]
                }
            },
            {
                "timestamp": "2026-05-27T18:18:15.100Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": json.dumps({"cmd": "rg session backend/parser.py"})
                }
            }
        ]
        with open(transcript_path, 'w', encoding='utf-8') as f:
            for s in steps:
                f.write(json.dumps(s) + '\n')

        sessions = self.parser.get_codex_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['id'], sid)
        self.assertEqual(sessions[0]['agent'], 'codex')
        self.assertEqual(sessions[0]['title'], 'Fix VibeSync session manager')
        self.assertEqual(sessions[0]['project'], project_path)

        details = self.parser.get_session_details("codex", sid)
        self.assertIsNotNone(details)
        self.assertEqual(details['first_prompt'], 'Implement four agent support')
        self.assertEqual(details['commands'], ['rg session backend/parser.py'])
        self.assertEqual(details['raw_steps_count'], 2)
        self.assertEqual(details['conversation'][1]['tool_count'], 1)
        self.assertIn("Source agent: Codex", details['takeover_prompt'])
        self.assertIn(f"Source transcript: `{transcript_path}`", details['takeover_prompt'])

    def test_opencode_session_parsing(self):
        """Verify that OpenCode storage/session and storage/message layouts are parsed."""
        sid = 'ses_abc123'
        project_path = '/Users/test/opencode-project'
        project_hash = 'projecthash'

        session_dir = os.path.join(self.opencode_dir, 'storage', 'session', project_hash)
        message_dir = os.path.join(self.opencode_dir, 'storage', 'message', sid)
        os.makedirs(session_dir, exist_ok=True)
        os.makedirs(message_dir, exist_ok=True)

        session_path = os.path.join(session_dir, f'{sid}.json')
        with open(session_path, 'w', encoding='utf-8') as f:
            json.dump({
                "id": sid,
                "title": "OpenCode parser",
                "projectPath": project_path,
                "time": {"updated": "2026-05-27T18:00:00Z"}
            }, f)

        messages = [
            {
                "id": "msg_1",
                "role": "user",
                "content": [{"type": "text", "text": "Read the OpenCode session"}],
                "createdAt": "2026-05-27T18:00:01Z"
            },
            {
                "id": "msg_2",
                "role": "assistant",
                "content": [{"type": "text", "text": "Reading message files."}],
                "tool_calls": [{"name": "bash", "input": {"command": "ls ~/.local/share/opencode"}}],
                "createdAt": "2026-05-27T18:00:02Z"
            }
        ]
        for i, msg in enumerate(messages, start=1):
            with open(os.path.join(message_dir, f'msg_{i}.json'), 'w', encoding='utf-8') as f:
                json.dump(msg, f)

        sessions = self.parser.get_opencode_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['id'], sid)
        self.assertEqual(sessions[0]['agent'], 'opencode')
        self.assertEqual(sessions[0]['project'], project_path)

        details = self.parser.get_session_details("opencode", sid)
        self.assertIsNotNone(details)
        self.assertEqual(details['first_prompt'], 'Read the OpenCode session')
        self.assertEqual(details['commands'], ['ls ~/.local/share/opencode'])
        self.assertEqual(details['raw_steps_count'], 2)
        self.assertIn("Source agent: OpenCode", details['takeover_prompt'])

    def test_agent_dispatch_does_not_cross_agents_with_same_id(self):
        """Verify details lookup is scoped by agent and does not fall back to Antigravity."""
        sid = 'shared-session-id'
        claude_project = '/Users/test/claude-project'
        anti_project = '/Users/test/antigravity-project'

        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": sid,
                "project": claude_project,
                "display": "Claude same id",
                "timestamp": 1
            }) + '\n')
        claude_transcript_dir = os.path.join(self.claude_dir, 'projects', slugify_project_path(claude_project))
        os.makedirs(claude_transcript_dir, exist_ok=True)
        with open(os.path.join(claude_transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user",
                "timestamp": 1,
                "message": {"content": "Claude prompt"}
            }) + '\n')

        with open(os.path.join(self.antigravity_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "conversationId": sid,
                "workspace": anti_project,
                "display": "Antigravity same id",
                "timestamp": 2
            }) + '\n')
        anti_transcript_dir = os.path.join(self.antigravity_dir, 'brain', sid, '.system_generated', 'logs')
        os.makedirs(anti_transcript_dir, exist_ok=True)
        with open(os.path.join(anti_transcript_dir, 'transcript.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "source": "USER_EXPLICIT",
                "type": "USER_INPUT",
                "created_at": 2,
                "content": "<USER_REQUEST>Antigravity prompt</USER_REQUEST>"
            }) + '\n')

        claude_details = self.parser.get_session_details("claude", sid)
        anti_details = self.parser.get_session_details("antigravity", sid)
        self.assertEqual(claude_details['first_prompt'], 'Claude prompt')
        self.assertEqual(anti_details['first_prompt'], 'Antigravity prompt')
        self.assertIn(f"Workspace: `{claude_project}`", claude_details['takeover_prompt'])
        self.assertIn(f"Workspace: `{anti_project}`", anti_details['takeover_prompt'])
        self.assertIsNone(self.parser.get_session_details("missing-agent", sid))

    def test_resolve_exact_agent_cwd_match(self):
        """resolve_session_for_context returns session when agent and cwd match exactly."""
        sid = 'resolve-exact-match'
        project = '/Users/test/resolve-project'
        slug = slugify_project_path(project)

        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": sid, "project": project, "display": "Resolve test",
                "timestamp": 1680000000.0
            }) + '\n')

        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user", "timestamp": 1680000000.0,
                "message": {"content": "Hello"}
            }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=project, agent='claude'
        )
        self.assertIsNotNone(session)
        self.assertEqual(session['id'], sid)
        self.assertEqual(session['agent'], 'claude')
        self.assertIn('exact', reason)
        self.assertGreater(confidence, 0.8)

    def test_resolve_parent_cwd_match(self):
        """resolve_session_for_context matches when terminal cwd is child of project dir."""
        sid = 'resolve-parent-match'
        project = '/Users/test/parent-project'
        child_cwd = '/Users/test/parent-project/subdir'
        slug = slugify_project_path(project)

        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": sid, "project": project, "display": "Parent test",
                "timestamp": 1680000000.0
            }) + '\n')

        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user", "timestamp": 1680000000.0,
                "message": {"content": "Child cwd"}
            }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=child_cwd, agent='claude'
        )
        self.assertIsNotNone(session)
        self.assertEqual(session['id'], sid)

    def test_resolve_prefers_exact_cwd_over_newer_parent_workspace(self):
        """resolve_session_for_context prefers exact cwd over a newer broad parent match."""
        parent_project = '/Users/test'
        exact_project = '/Users/test/exact-project'
        parent_sid = 'newer-parent-session'
        exact_sid = 'older-exact-session'

        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": parent_sid, "project": parent_project, "display": "Parent",
                "timestamp": 1680003600.0
            }) + '\n')
            f.write(json.dumps({
                "sessionId": exact_sid, "project": exact_project, "display": "Exact",
                "timestamp": 1680000000.0
            }) + '\n')

        for project, sid in ((parent_project, parent_sid), (exact_project, exact_sid)):
            transcript_dir = os.path.join(self.claude_dir, 'projects', slugify_project_path(project))
            os.makedirs(transcript_dir, exist_ok=True)
            with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
                f.write(json.dumps({
                    "type": "user", "timestamp": 1680000000.0,
                    "message": {"content": sid}
                }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=exact_project, agent='claude'
        )

        self.assertIsNotNone(session)
        self.assertEqual(session['id'], exact_sid)
        self.assertIn('exact', reason)

    def test_resolve_command_chooses_correct_agent(self):
        """resolve_session_for_context with agent param only searches that agent."""
        project = '/Users/test/agent-choice'

        # Create Claude session
        claude_sid = 'claude-agent-choice'
        slug = slugify_project_path(project)
        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": claude_sid, "project": project, "display": "Claude session",
                "timestamp": 1680000000.0
            }) + '\n')
        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{claude_sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user", "timestamp": 1680000000.0,
                "message": {"content": "Claude msg"}
            }) + '\n')

        # Create Antigravity session in same project
        anti_sid = 'anti-agent-choice'
        with open(os.path.join(self.antigravity_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "conversationId": anti_sid, "workspace": project, "display": "Anti session",
                "timestamp": 1680000000.0
            }) + '\n')
        anti_transcript_dir = os.path.join(self.antigravity_dir, 'brain', anti_sid, '.system_generated', 'logs')
        os.makedirs(anti_transcript_dir, exist_ok=True)
        with open(os.path.join(anti_transcript_dir, 'transcript.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "source": "USER_EXPLICIT", "type": "USER_INPUT", "created_at": 1680000000.0,
                "content": "<USER_REQUEST>Anti msg</USER_REQUEST>"
            }) + '\n')

        # Passing agent='claude' should only return Claude session
        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=project, agent='claude'
        )
        self.assertIsNotNone(session)
        self.assertEqual(session['agent'], 'claude')
        self.assertEqual(session['id'], claude_sid)

        # Passing agent='antigravity' should only return Antigravity session
        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=project, agent='antigravity'
        )
        self.assertIsNotNone(session)
        self.assertEqual(session['agent'], 'antigravity')
        self.assertEqual(session['id'], anti_sid)

    def test_resolve_latest_timestamp_wins_same_agent_cwd(self):
        """resolve_session_for_context returns latest session when same agent+cwd has multiple."""
        project = '/Users/test/latest-wins'
        older_sid = 'older-session'
        newer_sid = 'newer-session'
        slug = slugify_project_path(project)

        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": older_sid, "project": project, "display": "Older",
                "timestamp": 1680000000.0
            }) + '\n')
            f.write(json.dumps({
                "sessionId": newer_sid, "project": project, "display": "Newer",
                "timestamp": 1680003600.0
            }) + '\n')

        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        for sid in (older_sid, newer_sid):
            with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
                f.write(json.dumps({
                    "type": "user", "timestamp": 1680000000.0,
                    "message": {"content": sid}
                }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=project, agent='claude'
        )
        self.assertIsNotNone(session)
        self.assertEqual(session['id'], newer_sid)

    def test_resolve_missing_agent_returns_none(self):
        """resolve_session_for_context refuses to guess from cwd without a coding agent command."""
        project = '/Users/test/ambiguous'

        # Claude session
        claude_sid = 'claude-ambiguous'
        slug = slugify_project_path(project)
        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": claude_sid, "project": project, "display": "Claude ambig",
                "timestamp": 1680000000.0
            }) + '\n')
        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{claude_sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user", "timestamp": 1680000000.0,
                "message": {"content": "Claude"}
            }) + '\n')

        # Antigravity session in same project, very close timestamp
        anti_sid = 'anti-ambiguous'
        with open(os.path.join(self.antigravity_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "conversationId": anti_sid, "workspace": project, "display": "Anti ambig",
                "timestamp": 1680000010.0
            }) + '\n')
        anti_transcript_dir = os.path.join(self.antigravity_dir, 'brain', anti_sid, '.system_generated', 'logs')
        os.makedirs(anti_transcript_dir, exist_ok=True)
        with open(os.path.join(anti_transcript_dir, 'transcript.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "source": "USER_EXPLICIT", "type": "USER_INPUT", "created_at": 1680000010.0,
                "content": "<USER_REQUEST>Anti</USER_REQUEST>"
            }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=project, agent=None
        )
        self.assertIsNone(session)
        self.assertEqual(candidates, [])
        self.assertEqual(reason, "supported coding agent command is required")
        self.assertEqual(confidence, 0)

    def test_resolve_unknown_agent_returns_none(self):
        """resolve_session_for_context with unknown agent does not fall back to other agents."""
        project = '/Users/test/fallback-agent'

        # Add a Claude session
        sid = 'claude-fallback'
        slug = slugify_project_path(project)
        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": sid, "project": project, "display": "Fallback test",
                "timestamp": 1680000000.0
            }) + '\n')
        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user", "timestamp": 1680000000.0,
                "message": {"content": "Fallback"}
            }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=project, agent='unknown-agent'
        )
        self.assertIsNone(session)
        self.assertEqual(candidates, [])
        self.assertEqual(reason, "supported coding agent command is required")
        self.assertEqual(confidence, 0)

    def test_resolve_no_match_returns_none(self):
        """resolve_session_for_context returns None when no sessions exist at all."""
        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd='/nonexistent/path', agent='claude'
        )
        self.assertIsNone(session)
        self.assertEqual(len(candidates), 0)
        self.assertEqual(confidence, 0)

    def test_resolve_no_cwd_no_agent_returns_none(self):
        """resolve_session_for_context without cwd does not fall back to latest session."""
        project = '/Users/test/no-filter'
        sid = 'no-filter-session'
        slug = slugify_project_path(project)

        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": sid, "project": project, "display": "No filter",
                "timestamp": 1680000000.0
            }) + '\n')
        transcript_dir = os.path.join(self.claude_dir, 'projects', slug)
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user", "timestamp": 1680000000.0,
                "message": {"content": "No filter test"}
            }) + '\n')

        session, candidates, reason, confidence = self.parser.resolve_session_for_context(
            cwd=None, agent=None
        )
        self.assertIsNone(session)
        self.assertEqual(candidates, [])
        self.assertEqual(reason, "terminal cwd is required")
        self.assertEqual(confidence, 0)


if __name__ == '__main__':
    unittest.main()
