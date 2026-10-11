"""make absence: eleven cells: the full stack, each project alone, and each single absence.
Each cell must install or start, show a clear feature-off state (never a 500 or a hang), and add no Error Log rows.

python3 absence.py [cell ...]   prints one line per assertion; exit 0 only if every cell holds.
Sites: TEST_SITE (everything), RAG_ONLY_SITE (drive + rag, no frappe_ai), FAI_ONLY_SITE (frappe_ai alone); make
absence-sites creates the last two. The test services serve TEST_SITE; the absence profile's trio is re-pointed per cell
through TEST_COMPOSE, the compose command the Makefile passes in.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from lib import PROJECT, ROOT, SITE, TEST_AGENT_CONTAINER, TEST_MCP_CONTAINER, WEB, env, stream

COMPOSE = os.environ["TEST_COMPOSE"].split()
RAG_ONLY = os.environ.get("RAG_ONLY_SITE", "rag.localhost")
FAI_ONLY = os.environ.get("FAI_ONLY_SITE", "fai.localhost")
ADMIN_PW = env("ADMIN_PASSWORD")
AB_WEB, AB_AGENT = "http://localhost:8082", "http://localhost:8486"
TRIO = ["absence-frontend", "absence-mcp", "absence-agent"]
failures = []


def case(ok, cell, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  [{cell}] {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(f"{cell}: {label}")


def sh(*args, env=None, timeout=300):
    # TEST_COMPOSE's file paths are relative to the repository root
    return subprocess.run(args, capture_output=True, text=True, env={**os.environ, **(env or {})}, timeout=timeout, cwd=ROOT)


def bench(site, *args):
    return sh("docker", "exec", f"{PROJECT}-backend-1", "bench", "--site", site, *args).stdout.strip()


def clear_chats(site):
    """The cells that ask a question leave an agent-written chat on the site; frappe_ai's own suite runs on
    FAI_ONLY and asserts that a user has no session, so it would read this run's rows as its own."""
    for doctype in ("AI Chat Message", "AI Chat Session"):
        bench(site, "execute", "frappe.db.delete", "--args", f'["{doctype}"]')  # bench execute commits on its way out


def errors(site):
    bench(site, "execute", "frappe.deferred_insert.save_to_db")
    return int(bench(site, "execute", "frappe.db.count", "--args", '["Error Log"]') or 0)


def http(method, url, body=None, cookie="", headers=None, timeout=60):
    h = {"Accept": "application/json", **(headers or {})}
    if cookie:
        h["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    if data:
        h["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method), timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:  # a hang or refused connection is a result here, not a crash of the harness
        return 0, type(e).__name__


def login(web, user="Administrator", pw=None):
    req = urllib.request.Request(f"{web}/api/method/login", json.dumps({"usr": user, "pwd": pw or ADMIN_PW}).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return next(c.split(";")[0] for c in r.headers.get_all("Set-Cookie") if c.startswith("sid="))


def absence(site=None, frappe=None, mcp=None, kb=None, services=TRIO):
    extra = {k: v for k, v in {"ABSENCE_SITE": site, "ABSENCE_FRAPPE": frappe, "ABSENCE_MCP": mcp, "ABSENCE_KB": kb}.items() if v}
    sh(*COMPOSE, "--profile", "absence", "rm", "--stop", "--force", *TRIO)
    sh(*COMPOSE, "--profile", "absence", "up", "-d", "--no-deps", "--force-recreate", *services, env=extra)
    time.sleep(8)


def tools_list(container, cookie):
    probe = ("import urllib.request as u,json;r=u.Request('http://%s:8080/mcp',data=json.dumps({'jsonrpc':'2.0','id':1,"
             "'method':'tools/list'}).encode(),headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream',"
             "'Cookie':%r});\ntry:\n b=u.urlopen(r,timeout=20).read().decode()\n print(200, 'search_knowledge_base' in b)\n"
             "except Exception as e: print(getattr(e,'code',0), False)") % (container, cookie)
    out = sh("docker", "exec", TEST_AGENT_CONTAINER, "/app/.venv/bin/python", "-c", probe).stdout.split()
    return (int(out[0]), out[1] == "True") if len(out) == 2 else (0, False)


def ask(agent, cookie, message="What is the Kestrel allowance? Search the knowledge base.", timeout=300):
    status, body = http("POST", f"{agent}/api/v1/chat", {"message": message}, cookie=cookie, timeout=timeout)
    types = [json.loads(line[5:]).get("type") for line in body.splitlines() if line.startswith("data:")]
    return status, types


def cell_full():
    c, web, before = "full stack", WEB, errors(SITE)
    cookie = login(web)
    st, has_kb = tools_list("test-mcp", cookie)
    case(st == 200 and has_kb, c, "MCP offers search_knowledge_base when rag is installed", f"{st}")
    st, types = ask(os.environ.get("TEST_AGENT", "http://localhost:8485"), cookie)
    case(st == 200 and "done" in types, c, "a question is answered", f"{st} {types[-1:]}")
    case(errors(SITE) == before, c, "no new Error Log rows")


def cell_rag_alone():
    c, site = "rag alone", RAG_ONLY
    absence(site=site, services=["absence-frontend"])
    web, before = AB_WEB, errors(site)
    # rag declares frappe_ai in required_apps (C14), so a site created now has it whether or not it was asked for;
    # this site predates that, which is the state the two cells below still prove rag survives
    apps = bench(site, "list-apps")
    case("rag" in apps, c, "rag is installed", apps.replace("\n", " ")[:80])
    cookie = login(web)
    search_url = f"{web}/api/method/rag.search.search"
    st, _ = http("POST", search_url, {"query": "leave"}, cookie=cookie)
    case(st == 200, c, "search answers", f"{st}")
    st, body = http("POST", search_url, {"query": "leave", "session": "missing-chat"}, cookie=cookie)
    case(st != 500, c, "search with a chat id is a clear 4xx or empty, not a 500", f"{st}")
    case(errors(site) == before, c, "no new Error Log rows")


def cell_metis_alone():
    c, site, web = "Metis alone", RAG_ONLY, AB_WEB
    before = errors(site)
    cookie = login(web)
    for label, method, url, body in [
        ("/ask loads", "GET", f"{web}/ask", None),
        ("status.link answers", "GET", f"{web}/api/method/rag.status.link", None),
        ("status.summary answers", "GET", f"{web}/api/method/rag.status.summary", None),
        ("delete_chat without frappe_ai is not a 500", "POST", f"{web}/api/method/rag.chat.delete_chat", {"session": "none"}),
        ("attachments without frappe_ai is not a 500", "GET", f"{web}/api/method/rag.chat.attachments?session=none", None),
        ("library.folder answers", "GET", f"{web}/api/method/rag.library.folder", None),
    ]:
        st, _ = http(method, url, body, cookie=cookie, headers={"X-Frappe-CSRF-Token": "x"} if method == "POST" else None)
        case(st not in (0, 500), c, label, f"{st}")
    case(errors(site) == before, c, "no new Error Log rows")


def cell_frappe_ai_alone():
    c, site = "frappe_ai alone", FAI_ONLY
    absence(site=site, services=["absence-frontend"])
    web, before = AB_WEB, errors(site)
    cookie = login(web)
    html = http("GET", f"{web}/app", cookie=cookie)[1]
    token = html.split('csrf_token = "')[1].split('"')[0] if 'csrf_token = "' in html else ""
    st, body = http("POST", f"{web}/api/method/frappe_ai.api.chat.start_stream", {"message": "hi", "session_id": "absence-probe"},
                    cookie=cookie, headers={"X-Frappe-CSRF-Token": token})
    case(st not in (0, 500), c, "start_stream with no agent configured is a clear message, not a 500", f"{st}")
    case(errors(site) == before, c, "no new Error Log rows")


def cell_agent_alone():
    c = "agent alone"
    absence(frappe="http://nowhere.invalid:8080", mcp="http://nowhere.invalid:8080/mcp", services=["absence-agent"])
    time.sleep(10)
    st, body = http("GET", f"{AB_AGENT}/health")
    case(st == 200, c, "the agent starts and answers /health with nothing else running", f"{st}")
    st, types = ask(AB_AGENT, "sid=" + "0" * 26, timeout=120)
    case(st in (401, 403, 503) or (st == 200 and "error" in types), c, "a chat with no Frappe to check the sid against fails closed", f"{st} {types[-1:]}")


def cell_mcp_alone():
    c = "MCP alone"
    absence(frappe="http://nowhere.invalid:8080", services=["absence-mcp"])
    st, has_kb = tools_list("absence-mcp", "sid=" + "0" * 26)
    case(st in (401, 403, 503), c, "the MCP server starts and refuses a sid it cannot check", f"{st}")


def cell_without(app):
    if app == "rag":
        c, site = "without rag", FAI_ONLY
    else:
        c, site = "without frappe_ai", RAG_ONLY
    absence(site=site, kb="false" if app == "rag" else None)  # a site without rag runs its MCP with the knowledge base off
    web, before = AB_WEB, errors(site)
    cookie = login(web)
    st, has_kb = tools_list("absence-mcp", cookie)
    if app == "rag":
        case(st == 200 and not has_kb, c, "MCP does not offer search_knowledge_base without rag", f"{st} kb={has_kb}")
    st, types = ask(AB_AGENT, cookie)
    case(st == 200 and "done" in types, c, "a question is still answered", f"{st} {types[-1:]}")
    case(errors(site) == before, c, "no new Error Log rows")


def cell_without_metis():
    case(False, "without Metis", "Metis can be absent while rag stays", "Metis is part of the rag app; it cannot be left out")


def cell_without_service(name):
    c, site, web = f"without {name}", SITE, WEB
    before = errors(site)
    container = TEST_AGENT_CONTAINER if name == "agent" else TEST_MCP_CONTAINER
    sh("docker", "stop", container)
    try:
        end = next((e for e in stream("bob", "What is the Kestrel allowance? Search the knowledge base.", timeout_s=120) if e.get("end")), {})
        case(end.get("type") in ("error", "done") and end.get("t", 10**9) <= 30_000, c,
             "Metis's chat reaches a clear end within 30 s", f"{end.get('type')} after {end.get('t', 0) / 1000:.1f}s")
        st, body = http("GET", f"{web}/api/method/rag.status.link", cookie=login(web))
        case(st == 200, c, "the status chip still answers", f"{st}")
    finally:
        sh("docker", "start", container)
    case(errors(site) == before, c, "no new Error Log rows")


CELLS = {
    "full": cell_full, "rag-alone": cell_rag_alone, "metis-alone": cell_metis_alone, "frappe_ai-alone": cell_frappe_ai_alone,
    "agent-alone": cell_agent_alone, "mcp-alone": cell_mcp_alone, "without-rag": lambda: cell_without("rag"),
    "without-metis": cell_without_metis, "without-frappe_ai": lambda: cell_without("frappe_ai"),
    "without-agent": lambda: cell_without_service("agent"), "without-mcp": lambda: cell_without_service("mcp"),
}


def main():
    try:
        for name in sys.argv[1:] or list(CELLS):
            try:
                CELLS[name]()
            except Exception as e:
                case(False, name, "the cell ran", f"{type(e).__name__}: {str(e)[:120]}")
    finally:
        clear_chats(FAI_ONLY)
        sh(*COMPOSE, "--profile", "absence", "rm", "--stop", "--force", *TRIO)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
