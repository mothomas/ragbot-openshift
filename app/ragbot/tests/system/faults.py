"""make faults: kill a service while an answer streams and time how long the user waits for a clear end.

python3 faults.py [agent mcp worker redis]   (default: all four)
A clear end is an `error` or `done` chunk on the chat's realtime channel. An `error` must arrive within 15 s of the
kill (own budget: Nielsen's 10 s limit for keeping attention, plus 5 s to detect the failure); a `done`, which means
the answer survived the kill, is allowed the model's own time, 60 s. The killed container is started again
and must answer before the next target. Shared containers (the long worker, Redis) are killed only when no job is
queued, so no one else's work is lost; after Redis, realtime must recover without a manual restart, which the
stack is given RECOVERY_S to do on its own.
"""
import json
import os
import subprocess
import sys
import time

from lib import AGENT, HERE, PROJECT, SITE, TEST_AGENT_CONTAINER, TEST_MCP_CONTAINER, WEB, bench, users

BUDGET_S = 15  # a failure must reach the user this fast; the kill is what starts the clock
ANSWER_S = 60  # an answer that survives the kill takes the model's own time: measured 3-13 s, the rest is headroom
RECOVERY_S = 300  # Redis is back, but the web and realtime services reconnect in their own time, not at once
TARGETS = {"agent": TEST_AGENT_CONTAINER, "mcp": TEST_MCP_CONTAINER,
           "worker": f"{PROJECT}-queue-long-1", "redis": f"{PROJECT}-redis-queue-1"}
FRONTENDS = [f"{PROJECT}-frontend-1", f"{PROJECT}-test-frontend-1"]
failures = []


def docker(*args):
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def queued_jobs():
    redis = TARGETS["redis"]
    queues = docker("exec", redis, "redis-cli", "--scan", "--pattern", "rq:queue:*").stdout.split()
    return sum(int(docker("exec", redis, "redis-cli", "llen", q).stdout.strip() or 0) for q in queues)


def healthy(target, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            bench("execute", "frappe.ping", timeout=30)
            if target == "agent":
                subprocess.run(["curl", "-sf", "-m", "3", f"{AGENT}/health"], check=True, capture_output=True)
            if target in ("worker", "redis") and f"{TARGETS['worker']} Up" not in docker("ps", "--format", "{{.Names}} {{.Status}}").stdout:
                raise RuntimeError("the long worker is not up yet")  # it crash-loops until Redis resolves again
            return True
        except Exception:
            time.sleep(3)
    return False


def env_for(message, timeout_s):
    u = users()["bob"]
    return {**os.environ, "WEB": WEB, "SITE": SITE, "AUSER": u["email"], "APASS": u["password"],
            "TIMEOUT_S": str(timeout_s), "MESSAGE": message}


def streams_an_answer():
    out = subprocess.run(["node", str(HERE / "stream.mjs")], capture_output=True, text=True,
                         env=env_for("What is the Kestrel allowance? Search the knowledge base.", 90)).stdout
    return '"type":"done"' in out


def recovers(deadline):
    """A fresh stream answers on its own before `deadline`. One attempt would judge the stack on its worst second."""
    while not streams_an_answer():
        if time.time() >= deadline:
            return False
        time.sleep(5)
    return True


def run(target):
    container = TARGETS[target]
    if target in ("worker", "redis") and queued_jobs():
        print(f"SKIP  {target}: jobs are queued, not killing a shared container")
        return
    env = env_for("Explain the Kestrel allowance in detail, step by step. Search the knowledge base first.", 400)
    proc = subprocess.Popen(["node", str(HERE / "stream.mjs")], stdout=subprocess.PIPE, text=True, env=env)
    killed_at, end = None, None
    for line in proc.stdout:
        ev = json.loads(line)
        if killed_at is None and ev.get("type") in ("content", "tool_call"):
            docker("kill", container)
            killed_at = ev["t"]
        if ev.get("end"):
            end = ev
            break
    proc.wait(timeout=30)
    docker("start", container)
    up = healthy(target)
    if killed_at is None:
        print(f"FAIL  {target}: the answer ended before the kill ({end})")
        failures.append(target)
        return
    waited = (end["t"] - killed_at) / 1000
    budget = BUDGET_S if end["type"] == "error" else ANSWER_S
    ok = end["type"] in ("error", "done") and waited <= budget
    print(f"{'PASS' if ok else 'FAIL'}  {target}: killed at {killed_at / 1000:.1f}s, the user saw '{end['type']}' "
          f"{waited:.1f}s later (budget {budget}s); restarted {'healthy' if up else 'NOT healthy'}")
    if not ok or not up:
        failures.append(target)
    if target == "redis":
        recovered = recovers(time.time() + RECOVERY_S)
        print(f"{'PASS' if recovered else 'FAIL'}  redis: a new answer streams after Redis is back, with no manual restart")
        if not recovered:
            failures.append("redis-recovery")
            docker("restart", *FRONTENDS)  # leave the stack working for whoever comes next


def main():
    for t in sys.argv[1:] or list(TARGETS):
        run(t)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
