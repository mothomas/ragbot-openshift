"""make vector-scale: how the vector index's latency and recall behave as the corpus grows.

python3 vector_scale.py   measure, write vector-scale-latest.json and print it

Adds synthetic chunks until the table is 1x, 10x and 100x its current size, and at each size runs
the same nearest-neighbour query the endpoint runs (rag/rag/search.py:107-114) at several values of
mhnsw_ef_search, against an exact scan of the same table. `ORDER BY ... + 0` is what forces that
exact scan: an arithmetic wrapper makes MariaDB drop the vector index, which is the trap
search.py:103-105 records. recall@5 is how many of the exact five the index found.

Every synthetic row is deleted again at the end, and the count before and after is printed.
SCALES, PROBES and EF_VALUES can be overridden from the environment.
"""

import json
import os
import subprocess

from lib import BACKEND, HERE, SITE

PY = os.environ.get("BENCH_PYTHON", "/home/frappe/frappe-bench/env/bin/python")
SCALES = os.environ.get("SCALES", "1,10,100")
PROBES = os.environ.get("PROBES", "10")
EF_VALUES = os.environ.get("EF_VALUES", "20,100,500")
MARKER = "synthetic-vector-scale"

PROBE = r'''
import json, sys, time
import frappe

site, scales, probes, efs, marker = sys.argv[1], json.loads(sys.argv[2]), int(sys.argv[3]), json.loads(sys.argv[4]), sys.argv[5]
frappe.init(site=site)
frappe.connect()
from rag.ingest import EMBED_DIM, embed_model

TABLE = "`tabKB Chunk`"
sql = frappe.db.sql


def count():
    return sql(f"SELECT COUNT(*) FROM {TABLE}")[0][0]


def grow(target, batch=2000):
    """Deterministic pseudo-random vectors, built in SQL so nothing large crosses the wire."""
    while count() < target:
        rows = min(batch, target - count())
        sql(
            f"INSERT INTO {TABLE} (name, creation, modified, owner, modified_by, file, seq, content, model, embedding)"
            " WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < %(rows)s),"
            "                d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < %(dim)s - 1)"
            " SELECT UUID(), NOW(6), NOW(6), 'Administrator', 'Administrator', %(marker)s, r.n, 'synthetic', %(model)s,"
            "        VEC_FromText(CONCAT('[', (SELECT GROUP_CONCAT(ROUND(SIN(r.n * 0.7919 + d.i * 0.1307), 5)"
            "                                               ORDER BY d.i) FROM d), ']'))"
            " FROM r",
            {"rows": rows, "dim": EMBED_DIM, "marker": marker, "model": marker},
        )
        frappe.db.commit()


def nearest(vector, arithmetic=False):
    order = "VEC_DISTANCE_COSINE(embedding, VEC_FromText(%(v)s))" + (" + 0" if arithmetic else "")
    started = time.perf_counter()
    rows = sql(
        f"SELECT name FROM {TABLE} WHERE embedding IS NOT NULL ORDER BY {order} LIMIT 5", {"v": vector}
    )
    return (time.perf_counter() - started) * 1000, {r[0] for r in rows}


def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 1)


before = count()
out = {"model": embed_model(), "chunks_before": before, "scales": {}}
vectors = [r[0] for r in sql(f"SELECT VEC_ToText(embedding) FROM {TABLE} WHERE embedding IS NOT NULL"
                             " ORDER BY RAND() LIMIT %(n)s", {"n": probes})]
if not vectors:
    print(json.dumps({**out, "error": "no embedded chunk to ask from; run make test-seed first"}))
    raise SystemExit(0)
try:
    for scale in scales:
        grow(before * scale)
        at = {"chunks": count(), "exact_scan_p50_ms": 0, "ef": {}}
        exact = {}
        times = []
        for v in vectors:
            ms, names = nearest(v, arithmetic=True)
            times.append(ms)
            exact[v] = names
        at["exact_scan_p50_ms"] = pct(times, 50)
        for ef in efs:
            sql(f"SET SESSION mhnsw_ef_search = {int(ef)}")
            times, recalls = [], []
            for v in vectors:
                ms, names = nearest(v)
                times.append(ms)
                recalls.append(len(names & exact[v]) / 5)
            at["ef"][str(ef)] = {"p50_ms": pct(times, 50), "p95_ms": pct(times, 95),
                                 "recall_at_5": round(sum(recalls) / len(recalls), 3)}
        out["scales"][str(scale)] = at
finally:
    sql(f"DELETE FROM {TABLE} WHERE file = %(marker)s", {"marker": marker})
    frappe.db.commit()
    out["chunks_after"] = count()
print(json.dumps(out))
'''


def main():
    args = [SITE, json.dumps([int(s) for s in SCALES.split(",")]), PROBES,
            json.dumps([int(e) for e in EF_VALUES.split(",")]), MARKER]
    run = subprocess.run(["docker", "exec", "-w", "/home/frappe/frappe-bench/sites", BACKEND, PY, "-c", PROBE, *args],
                         capture_output=True, text=True, timeout=7200)
    line = next((ln for ln in reversed(run.stdout.splitlines()) if ln.startswith("{")), "")
    if not line:
        print(run.stdout[-2000:] + run.stderr[-2000:])
        raise SystemExit("vector_scale: the probe printed no result")
    print(json.dumps(json.loads(line), indent=1))
    (HERE / "vector-scale-latest.json").write_text(line)


if __name__ == "__main__":
    main()
