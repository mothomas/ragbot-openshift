"""Shared client for the system checks. They run against TEST_SITE through the test services in compose.test.yaml,
never against the demo site."""
import http.cookiejar
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SITE = os.environ.get("TEST_SITE", "test.localhost")
WEB = os.environ.get("TEST_WEB", f"http://{SITE}:{os.environ.get('TEST_HTTP_PORT', '8081')}")
AGENT = os.environ.get("TEST_AGENT", f"http://localhost:{os.environ.get('TEST_AGENT_PORT', '8485')}")
PROJECT = os.environ.get("COMPOSE_PROJECT", "frappe-demo")
BACKEND = f"{PROJECT}-backend-1"
TEST_AGENT_CONTAINER = f"{PROJECT}-test-agent-1"
TEST_MCP_CONTAINER = f"{PROJECT}-test-mcp-1"
USERS = HERE / ".users.json"


def env(key, default=""):
    path = ROOT / ".env"
    text = path.read_text() if path.exists() else ""
    return next((line.split("=", 1)[1] for line in text.splitlines() if line.startswith(key + "=")), default)


DEMO_PROJECT = "frappe-demo"
# the demo's own site is the one to protect; another compose project's site of the same name is its own throwaway
# DEMO_CHECKPOINT is the one path allowed to write to the demo: it backs up, counts every doctype it could touch,
# and removes what it created (DECISIONS.md, CKQ1)
assert (PROJECT != DEMO_PROJECT or SITE != env("SITE_NAME", "demo.localhost")
        or os.environ.get("DEMO_CHECKPOINT") == "1"), \
    "the system checks change data; never run them on the demo site"


def bench(*args, site=SITE, timeout=600):
    p = subprocess.run(["docker", "exec", BACKEND, "bench", *(["--site", site] if site else []), *args],
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"bench {args[0]} failed: {p.stderr[-400:]}")
    return p.stdout.strip()


def users():
    return json.loads(USERS.read_text())


class Session:
    def __init__(self, user=None, password=None):
        self.jar = http.cookiejar.CookieJar()
        self.web = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = ""
        if user:
            self.login(user, password)

    def login(self, user, password):
        self.request("POST", "/api/method/login", {"usr": user, "pwd": password})
        html = self.web.open(urllib.request.Request(f"{WEB}/ask"), timeout=30).read().decode()
        m = re.search(r'"csrf_token":\s*"([^"]*)"', html)
        self.csrf = m.group(1) if m else ""
        return self

    @property
    def sid(self):
        return next((c.value for c in self.jar if c.name == "sid"), "")

    def request(self, method, path, body=None, headers=None, raw=None, timeout=60):
        h = {"Accept": "application/json", **(headers or {})}
        data = raw
        if body is not None and raw is None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        if method != "GET" and self.csrf:
            h["X-Frappe-CSRF-Token"] = self.csrf
        req = urllib.request.Request(f"{WEB}{path}", data=data, headers=h, method=method)
        try:
            with self.web.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}

    def get(self, method, **args):
        q = urllib.parse.urlencode({k: v if isinstance(v, str) else json.dumps(v) for k, v in args.items()})
        return self.request("GET", f"/api/method/{method}?{q}")

    def post(self, method, **args):
        return self.request("POST", f"/api/method/{method}", args)

    def upload(self, team, name, content: bytes, parent=None):
        boundary = uuid.uuid4().hex
        fields = {"team": team, **({"parent": parent} if parent else {})}
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                     f"Content-Type: text/plain\r\n\r\n".encode() + content + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return self.request("POST", "/api/method/drive.api.files.upload_file", raw=b"".join(parts),
                            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def chat(self, message, sid=None, timeout=600):
        """POST the agent's SSE endpoint directly; returns (status, [events])."""
        req = urllib.request.Request(f"{AGENT}/api/v1/chat", json.dumps({"message": message}).encode(),
                                     {"Content-Type": "application/json", "Cookie": f"sid={sid if sid is not None else self.sid}"})
        events = []
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:]))
                return r.status, events
        except urllib.error.HTTPError as e:
            return e.code, events


def stream(user, message, timeout_s=360, request_id=None, expose_sid=False):
    """Ask through Frappe the way the frontends do (start_stream + realtime); returns the list of JSON events."""
    u = users()[user]
    run_env = {**os.environ, "WEB": WEB, "SITE": SITE, "AUSER": u["email"], "APASS": u["password"], "MESSAGE": message,
               "TIMEOUT_S": str(timeout_s), **({"REQUEST_ID": request_id} if request_id else {}), **({"EXPOSE_SID": "1"} if expose_sid else {})}
    p = subprocess.run(["node", str(HERE / "stream.mjs")], capture_output=True, text=True, env=run_env, timeout=timeout_s + 60)
    return [json.loads(line) for line in p.stdout.splitlines() if line.startswith("{")]
