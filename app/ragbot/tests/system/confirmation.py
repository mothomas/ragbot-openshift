"""make confirmation: a write tool runs only after the user's click, on the test site.

python3 confirmation.py   exit 0 only if every case holds; prints one line per case, never a token.
Needs seed.py to have run. Needs ADR-006 landed in all four repositories: frappe-mcp-server's gate,
the agent's pause, frappe_ai's confirm.respond/redeem and this frontend's card.
"""
import json
import subprocess
import sys
import time

from lib import SITE, TEST_AGENT_CONTAINER, Session, stream, users

MARK = f"zephyr confirmation {int(time.time())}"
ASK = f"Create a ToDo whose description is exactly '{MARK}'. Use the create_document tool."
REFUSAL = "This change was not confirmed by the user, so it was not made."
failures = []


def case(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def todos(session):
    st, body = session.get("frappe.client.get_list", doctype="ToDo",
                           filters=[["description", "like", f"%{MARK}%"]], limit_page_length=5)
    return st, body.get("message") or []


def wait_for_todo(session, seconds=180):
    for _ in range(seconds):
        st, rows = todos(session)
        if rows:
            return rows
        time.sleep(1)
    return []


def main():
    u = users()["alice"]
    alice = Session(u["email"], u["password"])

    events = stream("alice", ASK, timeout_s=300)
    pause = next((e for e in events if e.get("type") == "tool_confirm"), None)
    kinds = [e.get("type") for e in events]
    case(pause is not None and "done" in kinds,
         "chat: the model's write ends the turn as a pending confirmation", f"{kinds}")
    case(not any(k == "tool_call" for k in kinds),
         "chat: no tool in that envelope ran")
    st, rows = todos(alice)
    case(st == 200 and not rows, "write: nothing is created while the card is unanswered", f"{st}, {len(rows)} rows")
    if pause is None:
        print(f"      site {SITE}")
        sys.exit(1)

    st, _ = alice.post("frappe_ai.api.confirm.respond", confirmation_id=pause["id"], decision="allow")
    case(st == 200, "click: Allow is accepted", f"{st}")
    rows = wait_for_todo(alice)
    case(bool(rows), "write: the document exists only after the click", f"{len(rows)} rows")
    target = rows[0]["name"] if rows else "x"

    st, _ = alice.post("frappe_ai.api.confirm.respond", confirmation_id=pause["id"], decision="allow")
    case(st >= 400, "click: the same confirmation cannot be answered twice", f"{st}")

    st, _ = alice.post("frappe_ai.api.confirm.redeem", token="0" * 96, tool="delete_document",
                       doctype="ToDo", name=target)
    case(st >= 400, "grant: a token nobody minted is refused", f"{st}")

    # the MCP server's own gate, through its REST tool route with alice's sid and no grant header
    body = json.dumps({"params": {"doctype": "ToDo", "name": target}})
    probe = ("import urllib.request as u;r=u.Request('http://test-mcp:8080/api/v1/tools/delete_document',"
             f"data={json.dumps(body)}.encode(),"
             "headers={'Content-Type':'application/json','Accept':'application/json',"
             f"'Cookie':'sid={alice.sid}'}});\n"
             "try: print(u.urlopen(r,timeout=30).read().decode()[:600])\n"
             "except Exception as e: print(getattr(e,'read',lambda: b'')().decode()[:600] or getattr(e,'code',e))")
    p = subprocess.run(["docker", "exec", TEST_AGENT_CONTAINER, "/app/.venv/bin/python", "-c", probe],
                       capture_output=True, text=True, timeout=90)
    case(REFUSAL in p.stdout, "mcp: a direct write with a valid sid and no grant is refused",
         p.stdout.strip()[:140] or p.stderr[-140:])
    st, after = todos(alice)
    case(len(after) == len(rows), "mcp: and it deleted nothing", f"{len(after)} rows")

    print(f"      site {SITE}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
