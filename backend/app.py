#!/usr/bin/env python3
import json
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from parser import SessionParser


def resolve_takeover_payload(session_parser, data):
    cwd = data.get('cwd')
    command = data.get('command')
    agent = command if command in session_parser.agent_registry else None

    if not cwd:
        return 400, {"error": "Terminal cwd is required for context-aware takeover"}
    if not agent:
        return 400, {"error": "Supported coding agent command is required for context-aware takeover"}

    session, candidates, reason, confidence = (
        session_parser.resolve_session_for_context(cwd=cwd, agent=agent)
    )

    if session:
        return 200, {
            "session": session,
            "reason": reason,
            "confidence": confidence,
            "candidates": [
                {"agent": c["agent"], "id": c["id"], "project": c["project"]}
                for c in candidates[:5]
            ],
        }

    if candidates:
        return 409, {
            "error": reason,
            "candidates": [
                {"agent": c["agent"], "id": c["id"], "project": c["project"]}
                for c in candidates[:5]
            ],
        }

    return 404, {"error": reason or "No sessions found"}


class VibeSyncAPIHandler(BaseHTTPRequestHandler):
    parser = SessionParser()

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        query = urllib.parse.parse_qs(parsed_url.query)

        # GET /api/sessions
        if path == '/api/sessions':
            try:
                cwd_filter = query.get('cwd', [None])[0]
                sessions = self.parser.list_all_sessions(cwd=cwd_filter)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(sessions).encode('utf-8'))
            except Exception as e:
                self.send_error_response(500, f"Error listing sessions: {e}")

        # GET /api/sessions/<agent>/<sid>
        elif path.startswith('/api/sessions/'):
            parts = path.split('/')
            if len(parts) >= 5:
                agent = parts[3]
                sid = parts[4]
                try:
                    details = self.parser.get_session_details(agent, sid)
                    if details:
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps(details).encode('utf-8'))
                    else:
                        self.send_error_response(404, f"Session {sid} not found")
                except Exception as e:
                    self.send_error_response(500, f"Error getting details: {e}")
            else:
                self.send_error_response(400, "Invalid session details endpoint format")

        # GET /api/workspace
        elif path == '/api/workspace':
            path_param = query.get('path', [None])[0]
            if not path_param:
                self.send_error_response(400, "Missing 'path' query parameter")
                return
            try:
                git_info = self.parser.get_git_info(path_param)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(git_info).encode('utf-8'))
            except Exception as e:
                self.send_error_response(500, f"Error fetching workspace: {e}")

        # Base status
        elif path == '/' or path == '/api/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy", "service": "VibeSync API"}).encode('utf-8'))

        else:
            self.send_error_response(404, f"Endpoint {path} not found")

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        if path == '/api/takeover/resolve':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else b'{}'
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self.send_error_response(400, "Invalid JSON body")
                return

            try:
                status, payload = resolve_takeover_payload(self.parser, data)
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode('utf-8'))
            except Exception as e:
                self.send_error_response(500, f"Error resolving session: {e}")
        else:
            self.send_error_response(404, "Not found")

    def send_error_response(self, code, message):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode('utf-8'))

def run_server(port=8765):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, VibeSyncAPIHandler)
    print(f"🚀 VibeSync Backend API running on http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping VibeSync server...")
        httpd.server_close()

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="VibeSync API Server")
    parser.add_argument('--port', type=int, default=8765, help="Port to run server on")
    args = parser.parse_args()
    run_server(args.port)
