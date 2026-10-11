"""make load: one load baseline on the test site: saturation of the web tier, three simultaneous chats,
the agent's per-user rate limit, and recovery afterwards.

python3 load.py   writes harness/load-latest.json; exit 1 if a stated expectation fails.
Expectations: at 16 concurrent pollers of rag.status.link no request fails; three simultaneous chats all end
in `done` within 120 s; a burst of 40 chats from one user is rate-limited (429) before it reaches the model;
one search after the load is back within its perf budget (perf-budgets.json) within 30 s.
"""
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import time

from lib import HERE, SITE, WEB, Session, users

failures = []


def case(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def step(sessions, method, args, conc, per_worker=10, verb="get"):
    def worker(i):
        s, out = sessions[i], []
        for _ in range(per_worker):
            t = time.perf_counter()
            st, _body = getattr(s, verb)(method, **args)
            out.append(((time.perf_counter() - t) * 1000, st))
        return out
    t0 = time.perf_counter()
    with cf.ThreadPoolExecutor(conc) as ex:
        rows = [r for rs in ex.map(worker, range(conc)) for r in rs]
    ms = sorted(r[0] for r in rows)
    errors = sum(1 for r in rows if r[1] != 200)
    return {"concurrency": conc, "requests": len(rows), "p50_ms": round(ms[len(ms) // 2]),
            "p95_ms": round(ms[int(len(ms) * 0.95) - 1]), "errors": errors,
            "rps": round(len(rows) / (time.perf_counter() - t0), 1)}


def main():
    u = users()["bob"]
    make = lambda: Session(u["email"], u["password"])  # noqa: E731
    # users are already signed in; concurrent logins of one user are a separate finding (MariaDB 1020 on tabUser)
    sessions = [make() for _ in range(16)]
    result = {"status.link": [], "search": []}
    for conc in (1, 4, 8, 16):
        result["status.link"].append(step(sessions, "rag.status.link", {}, conc, per_worker=5))
        result["search"].append(step(sessions, "rag.search.search", {"query": "Kestrel allowance", "limit": 5}, conc,
                                     verb="post"))
        print(json.dumps({k: v[-1] for k, v in result.items()}))
    top = result["status.link"][-1]
    case(top["errors"] == 0, "16 concurrent status pollers: no failed request", f"{top['errors']} errors, p95 {top['p95_ms']} ms")

    # one chat per user: frappe_ai holds one answer per user on purpose, so three chats as the same
    # person measure that guard rather than concurrency, and two of them are refused before they start
    base = {**os.environ, "WEB": WEB, "SITE": SITE, "TIMEOUT_S": "180",
            "MESSAGE": "What is the Kestrel allowance? Search the knowledge base."}
    procs = []
    for who in ("alice", "bob", "carol"):  # staggered so the three logins do not collide; the chats still overlap
        env = {**base, "AUSER": users()[who]["email"], "APASS": users()[who]["password"]}
        procs.append(subprocess.Popen(["node", f"{HERE}/stream.mjs"], stdout=subprocess.PIPE, text=True, env=env))
        time.sleep(1.5)
    ends = [next((json.loads(line) for line in p.communicate(timeout=240)[0].splitlines() if '"end":true' in line), {}) for p in procs]
    result["three_chats"] = [{"end": e.get("type"), "s": round(e.get("t", 0) / 1000, 1)} for e in ends]
    case(all(e.get("type") == "done" and e.get("t", 10**9) <= 120_000 for e in ends), "three simultaneous chats finish within 120 s",
         json.dumps(result["three_chats"]))

    s = make()
    codes = []
    with cf.ThreadPoolExecutor(8) as ex:
        codes = list(ex.map(lambda _: s.chat("ping", timeout=120)[0], range(40)))
    result["burst_codes"] = {str(c): codes.count(c) for c in set(codes)}
    case(429 in codes, "a burst of 40 chats from one user is rate-limited", json.dumps(result["burst_codes"]))

    base = json.load(open(HERE / "perf-budgets.json"))["rag.search"]["budget"]["p95_ms"]
    deadline, recovered = time.time() + 30, None
    while time.time() < deadline:
        t = time.perf_counter()
        make().post("rag.search.search", query="Kestrel allowance", limit=5)
        recovered = (time.perf_counter() - t) * 1000
        if recovered <= base:
            break
        time.sleep(2)
    case(recovered is not None and recovered <= base, "the stack recovers after the load to within the search budget",
         f"{recovered:.0f} ms vs budget {base} ms")
    json.dump(result, open(HERE / "load-latest.json", "w"), indent=1)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
