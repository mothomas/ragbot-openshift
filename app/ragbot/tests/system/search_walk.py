"""make search-walk: what the permission filter costs per reader, in queries and milliseconds.

python3 search_walk.py   measure, write search-walk-latest.json and print it

Two endpoints share the filter: rag.search.search, whose second pass walks WIDEN candidates
(rag/rag/search.py:41-45), and rag.library.documents, which the /ask page calls on every load.
The reader who matters is carol, who has no shares, so every candidate fails the check.
Administrator never walks at all -- drive's user_has_permission returns True for it at once --
which is why `make check`, which only ever asks as Administrator, has never measured this.
"""

import json

from lib import HERE, Session, env, users
from perf import N, pct

QUESTION = "Kestrel allowance boots"
CALLS = {  # verb, then the arguments: search takes its question in a body (ADR-037)
    "rag.search.search": ("post", {"query": QUESTION, "limit": 5}),
    "rag.library.documents": ("get", {}),
}
# EXPLAIN, the stack capture and the profiler each cost more than the query they describe
RECORDER = {"explain": 0, "capture_stack": 0, "profile": 0, "capture_doc_events": 0, "record_jobs": 0}


def recorded(admin, cmd):
    _, body = admin.post("frappe.recorder.get")
    return [r for r in (body.get("message") or []) if r.get("cmd") == cmd]


def walk(admin, session, cmd):
    admin.post("frappe.recorder.delete")
    admin.post("frappe.recorder.start", **RECORDER)
    verb, args = CALLS[cmd]
    try:
        for _ in range(N):
            getattr(session, verb)(cmd, **args)
    finally:
        admin.post("frappe.recorder.stop")
    rows = recorded(admin, cmd)
    if not rows:
        return {"n": 0}
    return {
        "queries_p50": pct([r["queries"] for r in rows], 50),
        "queries_p95": pct([r["queries"] for r in rows], 95),
        "queries_max": max(r["queries"] for r in rows),
        "duration_p50_ms": pct([r["duration"] for r in rows], 50),
        "duration_p95_ms": pct([r["duration"] for r in rows], 95),
        "in_sql_p50_ms": pct([r["time_queries"] for r in rows], 50),
        "n": len(rows),
    }


def main():
    admin = Session("Administrator", env("ADMIN_PASSWORD"))
    who = users()
    sessions = {"Administrator": admin}
    for name in ("bob", "carol"):  # bob can read one document; carol can read none
        u = who[name]
        sessions[name] = Session(u["email"], u["password"])
    out = {cmd: {name: walk(admin, s, cmd) for name, s in sessions.items()} for cmd in CALLS}
    admin.post("frappe.recorder.delete")
    print(json.dumps(out, indent=1))
    (HERE / "search-walk-latest.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
