"""make perf: measure each layer as percentiles on the test site and compare with perf-budgets.json.

python3 perf.py measure   write harness/perf-latest.json (and print it)
python3 perf.py           measure, then exit 1 if any layer misses its budget in perf-budgets.json
Samples are sequential (one user); load is system:load's job.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from lib import AGENT, HERE, PROJECT, ROOT, TEST_AGENT_CONTAINER, WEB, Session, stream, users

N = int(os.environ.get("PERF_N", "30"))


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 1)


def timed(fn, n=N):
    out = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        out.append((time.perf_counter() - t) * 1000)
    return {"p50_ms": pct(out, 50), "p95_ms": pct(out, 95), "max_ms": round(max(out), 1), "n": n}


def size_kb(path_glob_cmd):
    out = subprocess.run(["sh", "-c", path_glob_cmd], capture_output=True, text=True).stdout.strip()
    return round(int(out or 0) / 1024, 1)


def measure():
    u = users()["bob"]
    s = Session(u["email"], u["password"])
    r = {}
    r["rag.search"] = timed(lambda: s.post("rag.search.search", query="Kestrel allowance boots", limit=5))
    r["rag.status.link"] = timed(lambda: s.get("rag.status.link"), n=10)
    r["rag.status.summary"] = timed(lambda: s.get("rag.status.summary"), n=10)
    r["rag.library.documents"] = timed(lambda: s.get("rag.library.documents"), n=10)
    r["rag.library.folder"] = timed(lambda: s.get("rag.library.folder"), n=10)
    r["frappe_ai.get_recent_messages"] = timed(lambda: s.get("frappe_ai.api.chat.get_recent_messages", session_id="none"), n=10)
    r["agent./health"] = timed(lambda: urllib.request.urlopen(f"{AGENT}/health", timeout=10).read(), n=10)
    probe = ("import json,time,urllib.request as u,sys\n"
             "def call(body):\n r=u.Request('http://test-mcp:8080/mcp',data=json.dumps(body).encode(),headers={'Content-Type':'application/json',"
             "'Accept':'application/json, text/event-stream','Cookie':'sid='+sys.argv[1]})\n t=time.perf_counter(); u.urlopen(r,timeout=30).read(); return (time.perf_counter()-t)*1000\n"
             "a=[call({'jsonrpc':'2.0','id':1,'method':'tools/list'}) for _ in range(10)]\n"
             "b=[call({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'search_knowledge_base','arguments':{'query':'Kestrel allowance'}}}) for _ in range(10)]\n"
             "print(json.dumps([a,b]))")
    out = subprocess.run(["docker", "exec", TEST_AGENT_CONTAINER, "/app/.venv/bin/python", "-c", probe, s.sid],
                         capture_output=True, text=True).stdout
    try:
        a, b = json.loads(out)
        r["mcp.tools_list"] = {"p50_ms": pct(a, 50), "p95_ms": pct(a, 95), "n": len(a)}
        r["mcp.search_knowledge_base"] = {"p50_ms": pct(b, 50), "p95_ms": pct(b, 95), "n": len(b)}
    except ValueError:
        r["mcp.tools_list"] = r["mcp.search_knowledge_base"] = {"n": 0}
    ttft, total = [], []
    for _ in range(5):
        evs = stream("bob", "What is the Kestrel allowance? Search the knowledge base.", timeout_s=300)
        first = next((e["t"] for e in evs if e.get("type") == "content"), None)
        end = next((e for e in evs if e.get("end")), {})
        if first is not None and end.get("type") == "done":
            ttft.append(first)
            total.append(end["t"])
    r["answer.time_to_first_token"] = {"p50_ms": pct(ttft, 50), "p95_ms": pct(ttft, 95), "n": len(ttft)} if ttft else {"n": 0}
    r["answer.total"] = {"p50_ms": pct(total, 50), "p95_ms": pct(total, 95), "n": len(total)} if total else {"n": 0}
    r["metis.bundle_js_kb"] = {"kb": size_kb(f"find {ROOT}/rag/rag/public/ask -name '*.js' -exec cat {{}} + | wc -c")}
    r["metis.bundle_js_gzip_kb"] = {"kb": size_kb(f"find {ROOT}/rag/rag/public/ask -name '*.js' -exec cat {{}} + | gzip -9 | wc -c")}
    r["frappe_ai.bundle_js_kb"] = {"kb": size_kb(f"docker exec {PROJECT}-frontend-1 sh -c \"cat /home/frappe/frappe-bench/sites/assets/frappe_ai/dist/js/*.js | wc -c\"")}
    chrome = subprocess.run(["sh", "-c", "ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/* | tail -1"],
                            capture_output=True, text=True).stdout.strip()
    lh = subprocess.run(["npx", "--yes", "lighthouse@12", f"{WEB}/ask", "--quiet", "--only-categories=performance",
                         f"--extra-headers={json.dumps({'Cookie': 'sid=' + s.sid})}", "--chrome-flags=--headless=new",
                         "--output=json", "--output-path=stdout"], capture_output=True, text=True, env={**os.environ, "CHROME_PATH": chrome})
    try:
        a = json.loads(lh.stdout)["audits"]
        r["metis.lab"] = {"lcp_ms": round(a["largest-contentful-paint"]["numericValue"]), "tbt_ms": round(a["total-blocking-time"]["numericValue"]),
                          "cls": round(a["cumulative-layout-shift"]["numericValue"], 3)}
    except (ValueError, KeyError):
        r["metis.lab"] = {}
    for img in ("frappe-ai-agent:local", "frappe-mcp-server:local", "frappe-demo:16"):
        out = subprocess.run(["docker", "image", "inspect", img, "--format", "{{.Size}}"], capture_output=True, text=True).stdout.strip()
        r[f"image.{img}"] = {"mb": round(int(out or 0) / 2**20)}
    return r


def main():
    r = measure()
    (HERE / "perf-latest.json").write_text(json.dumps(r, indent=1))
    print(json.dumps(r, indent=1))
    if sys.argv[1:] == ["measure"]:
        return
    budgets = json.load(open(HERE / "perf-budgets.json"))
    bad = []
    for layer, b in budgets.items():
        got = r.get(layer, {})
        for key, limit in b.get("budget", {}).items():
            if got.get(key) is None or got[key] > limit:
                bad.append(f"{layer}.{key}={got.get(key)} > {limit}")
    print("FAIL  " + "; ".join(bad) if bad else "PASS  every layer within budget")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
