"""make observability: ask one question with a request id and check that the id is on the log lines of all four
services for that answer, and that none of those logs carries a session id or a secret pattern.

Prints counts only, never a log line, a sid or answer text.
"""
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone

from lib import PROJECT, TEST_AGENT_CONTAINER, TEST_MCP_CONTAINER, stream

SERVICES = {"frappe web": f"{PROJECT}-backend-1", "queue job": f"{PROJECT}-queue-long-1",
            "agent": TEST_AGENT_CONTAINER, "mcp": TEST_MCP_CONTAINER}
SECRET = re.compile(r"(?i)(api[_-]?key|api[_-]?secret|password|passwd|authorization: *(bearer|token)|csrf[_-]?token)"
                    r"\W{0,3}[=:]\W{0,3}[A-Za-z0-9._\-]{8,}")
failures = []


def case(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def main():
    since = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rid = uuid.uuid4().hex
    events = stream("bob", "What is the Kestrel allowance? Search the knowledge base.", request_id=rid, expose_sid=True)
    end = next((e for e in events if e.get("end")), {})
    sid = end.pop("sid", "")
    case(end.get("type") == "done", "the answer completed", f"end={end.get('type')}")
    for name, container in SERVICES.items():
        logs = subprocess.run(["docker", "logs", "--since", since, container], capture_output=True, text=True)
        text = logs.stdout + logs.stderr
        case(rid in text, f"{name}: the request id is on its log lines", f"{text.count(rid)} of {len(text.splitlines())} lines")
        leaks = (text.count(sid) if len(sid) >= 16 else 0) + len(SECRET.findall(text))
        case(leaks == 0, f"{name}: no session id or secret pattern in its logs", f"{leaks} hits")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
