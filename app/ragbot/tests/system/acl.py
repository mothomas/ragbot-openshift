"""make acl: permission-aware retrieval and identity, on the test site.

python3 acl.py   exit 0 only if every case holds; prints one line per case, never a sid or document text.
Needs seed.py to have run.
"""
import json
import subprocess
import sys

from lib import SITE, TEST_AGENT_CONTAINER, Session, users

ALICE_FILE, ALICE_MARKS = "alice-roadmap.txt", ("zephyr", "14 march", "2.4 million")
FORGED = "0" * 20 + "forged"
failures = []


def case(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def files_of(rows):
    return {r.get("file_name") or r.get("title") or r.get("file") for r in rows}


def main():
    u = users()
    alice = Session(u["alice"]["email"], u["alice"]["password"])
    bob = Session(u["bob"]["email"], u["bob"]["password"])
    carol = Session(u["carol"]["email"], u["carol"]["password"])

    st, body = alice.post("rag.search.search", query="Project Zephyr opening date", limit=5)
    rows = body.get("message") or []
    case(st == 200 and any(r.get("file") for r in rows), "search: the owner finds her own document", f"{st}, {len(rows)} rows")
    alice_ids = {r.get("file") for r in rows}

    st, body = bob.post("rag.search.search", query="Project Zephyr opening date", limit=20)
    rows = body.get("message") or []
    case(st == 200 and not ({r.get("file") for r in rows} & alice_ids), "search: user B gets none of user A's passages", f"{st}, {len(rows)} rows")

    st, body = carol.post("rag.search.search", query="Project Zephyr Kestrel allowance", limit=20)
    rows = body.get("message") or []
    case(st in (200, 403) and not rows, "search: a user with zero shares gets zero passages", f"{st}, {len(rows)} rows")

    st, events = bob.chat("What is Project Zephyr, when does it open and what is its budget? Search the knowledge base.")
    sources = [s for e in events if e.get("type") == "sources" for s in (e.get("sources") or e.get("items") or [])]
    answer = "".join(e.get("text") or e.get("delta") or "" for e in events if e.get("type") == "content").lower()
    leaked = [m for m in ALICE_MARKS[1:] if m in answer] + [s for s in sources if json.dumps(s).find(ALICE_FILE) >= 0]
    case(st == 200 and "done" in [e.get("type") for e in events] and not leaked,
         "chat: user B cannot surface user A's document", f"{st}, {len(sources)} sources, leaked {len(leaked)}")

    st, events = Session().chat("Hello", sid=FORGED)
    case(st == 401, "agent: a forged sid gets 401", f"got {st}")

    st, events = Session().chat("Hello", sid="")
    case(st == 401, "agent: no sid gets 401", f"got {st}")

    probe = ("import urllib.request as u;r=u.Request('http://test-mcp:8080/mcp',data=b'{\"jsonrpc\":\"2.0\",\"id\":1,"
             "\"method\":\"tools/list\"}',headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream',"
             f"'Cookie':'sid={FORGED}'}});\ntry: print(u.urlopen(r,timeout=10).status)\nexcept Exception as e: print(getattr(e,'code',e))")
    p = subprocess.run(["docker", "exec", TEST_AGENT_CONTAINER, "/app/.venv/bin/python", "-c", probe],
                       capture_output=True, text=True, timeout=60)
    case(p.stdout.strip() == "401", "mcp: a forged sid gets 401", f"got {p.stdout.strip() or p.stderr[-120:]}")

    print(f"      site {SITE}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
