import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import resolve_takeover_payload
from parser import SessionParser, slugify_project_path


class TestTakeoverResolvePayload(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.TemporaryDirectory()
        home = self.test_dir.name
        self.claude_dir = os.path.join(home, '.claude')
        self.antigravity_dir = os.path.join(home, '.gemini', 'antigravity-cli')
        self.codex_dir = os.path.join(home, '.codex')
        self.opencode_dir = os.path.join(home, '.local', 'share', 'opencode')
        for path in (self.claude_dir, self.antigravity_dir, self.codex_dir, self.opencode_dir):
            os.makedirs(path, exist_ok=True)

        self.parser = SessionParser(
            claude_dir=self.claude_dir,
            antigravity_dir=self.antigravity_dir,
            codex_dir=self.codex_dir,
            opencode_dirs=[self.opencode_dir],
        )

    def tearDown(self):
        self.test_dir.cleanup()

    def add_claude_session(self, project, sid='claude-api-test', timestamp=1680000000.0):
        with open(os.path.join(self.claude_dir, 'history.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "sessionId": sid,
                "project": project,
                "display": "API resolve test",
                "timestamp": timestamp,
            }) + '\n')

        transcript_dir = os.path.join(self.claude_dir, 'projects', slugify_project_path(project))
        os.makedirs(transcript_dir, exist_ok=True)
        with open(os.path.join(transcript_dir, f'{sid}.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps({
                "type": "user",
                "timestamp": timestamp,
                "message": {"content": "hello"},
            }) + '\n')

    def test_missing_cwd_returns_400(self):
        status, payload = resolve_takeover_payload(self.parser, {"command": "claude"})
        self.assertEqual(status, 400)
        self.assertIn("cwd is required", payload["error"])

    def test_unsupported_command_returns_400(self):
        self.add_claude_session('/Users/test/project')
        status, payload = resolve_takeover_payload(
            self.parser,
            {"cwd": "/Users/test/project", "command": "zsh"},
        )
        self.assertEqual(status, 400)
        self.assertIn("Supported coding agent command is required", payload["error"])

    def test_no_matching_session_returns_404_without_cross_agent_fallback(self):
        self.add_claude_session('/Users/test/project')
        status, payload = resolve_takeover_payload(
            self.parser,
            {"cwd": "/Users/test/project", "command": "codex"},
        )
        self.assertEqual(status, 404)
        self.assertIn("no codex sessions matched terminal cwd", payload["error"])

    def test_matching_session_returns_200(self):
        project = '/Users/test/project'
        self.add_claude_session(project)
        status, payload = resolve_takeover_payload(
            self.parser,
            {"cwd": project, "command": "claude"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["session"]["agent"], "claude")
        self.assertEqual(payload["session"]["project"], project)
        self.assertIn("exact agent and cwd match", payload["reason"])


if __name__ == '__main__':
    unittest.main()
