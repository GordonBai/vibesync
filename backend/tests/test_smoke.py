"""End-to-end smoke test: spawn the real backend HTTP server in a subprocess
on an ephemeral port and verify it answers /api/health correctly. This guards
against import-time regressions and serialization bugs that the in-process
tests can miss.
"""

import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
import json


BACKEND_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'app.py')
)


def pick_free_port():
    """Bind to port 0 to let the OS hand back a free port, then close.

    There's a small race window before the backend binds the same port, but
    on a developer/CI box it's good enough for a smoke test.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_for_health(port, timeout=10.0):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                f'http://127.0.0.1:{port}/api/health', timeout=1
            ) as resp:
                body = json.loads(resp.read().decode('utf-8'))
                return resp.status, body
        except (urllib.error.URLError, ConnectionRefusedError, OSError) as e:
            last_err = e
            time.sleep(0.1)
    raise RuntimeError(f'Backend did not become healthy in {timeout}s: {last_err}')


class TestBackendSmoke(unittest.TestCase):
    def test_backend_starts_and_serves_health(self):
        port = pick_free_port()
        proc = subprocess.Popen(
            [sys.executable, BACKEND_PATH, '--port', str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            status, body = wait_for_health(port, timeout=10.0)
            self.assertEqual(status, 200)
            self.assertEqual(body.get('status'), 'healthy')
            self.assertEqual(body.get('service'), 'VibeSync API')

            # Sessions endpoint must respond with a JSON array (may be empty
            # on a fresh CI machine with no agent history).
            with urllib.request.urlopen(
                f'http://127.0.0.1:{port}/api/sessions', timeout=2
            ) as resp:
                self.assertEqual(resp.status, 200)
                data = json.loads(resp.read().decode('utf-8'))
                self.assertIsInstance(data, list)

            # Resolve endpoint with bad payload returns 400, not 500.
            req = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/takeover/resolve',
                data=b'{}',
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            try:
                urllib.request.urlopen(req, timeout=2)
                self.fail('Expected HTTPError 400 for empty body')
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 400)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            # Close pipe FDs explicitly so unittest doesn't emit
            # ResourceWarning when run with -W default.
            for stream in (proc.stdout, proc.stderr):
                try:
                    if stream:
                        stream.close()
                except Exception:
                    pass


if __name__ == '__main__':
    unittest.main()
