"""make retrieval: score what rag.search.search finds against a frozen eval set.

Seeds retrieval.json's corpus onto TEST_SITE as one reader's Drive documents (idempotent), asks each of its
questions through the same endpoint the MCP tool calls, and scores the documents that come back against the
qrels with recall@k and nDCG@k. No model judges anything and nothing is sampled, so two runs of the same
index give the same number.

Not vector_scale.py, which measures recall of the index against an exact scan of the same table: that says
the index finds the nearest vectors, not that the nearest vectors answer the question.

Prints scores and document names only, never a passage.
"""
import json
import sys
import time
from math import log2
from pathlib import Path

from lib import SITE, Session, bench, users

SET = json.loads((Path(__file__).resolve().parent / "retrieval.json").read_text())
CUTOFFS = (1, 3)
# @5 is not here: recall is monotone in k and no question has more than three relevant documents, so
# recall@5 and ndcg@5 can only pass wherever @3 passes. Every metric is printed; these three are gated.
# Measured on the seeded corpus: 0.949, 0.974, 0.979. One question in thirteen is 0.077 of recall and
# 0.028 of ndcg@3, so each floor trips on one question losing its rank and on nothing smaller.
FLOOR = {"recall@1": 0.90, "recall@3": 0.95, "ndcg@3": 0.95}
LIMIT = 20  # chunks, not documents: search.py's own ceiling, so de-duplication decides the cutoff
READER = "alice"  # seed.py gave her a Drive team; the corpus is hers and she is the one who asks


def dcg(gains: list[int]) -> float:
    """Discounted cumulative gain, the standard log2(i+1) discount with i counted from 1."""
    return sum(g / log2(i + 2) for i, g in enumerate(gains))


def score(found: list[str], relevant: dict[str, int], k: int) -> tuple[float, float]:
    """recall@k and nDCG@k for one question: `found` is the ranked document list, best first."""
    top = found[:k]
    recall = sum(1 for d in top if relevant.get(d)) / len(relevant)
    ideal = sorted(relevant.values(), reverse=True)[:k]
    return recall, dcg([relevant.get(d, 0) for d in top]) / dcg(ideal)


def selftest():
    """The scoring, checked without a site: `python3 retrieval.py --selftest`."""
    assert score(["a", "b", "c"], {"a": 1}, 1) == (1.0, 1.0)
    assert score(["b", "a", "c"], {"a": 1}, 1) == (0.0, 0.0)
    recall, ndcg = score(["b", "a", "c"], {"a": 1}, 3)
    assert recall == 1.0 and round(ndcg, 4) == 0.6309, (recall, ndcg)  # 1/log2(3)
    recall, ndcg = score(["a", "x"], {"a": 1, "b": 1}, 5)  # one of two found, and the other never offered
    assert recall == 0.5 and round(ndcg, 4) == 0.6131, (recall, ndcg)
    assert round(dcg([1, 1]), 4) == 1.6309
    for qid, wanted in SET["qrels"].items():
        assert qid in SET["queries"], qid
        assert wanted, f"{qid} has no relevant document, and recall would divide by zero"
        assert set(wanted) <= set(SET["corpus"]), (qid, wanted)
    assert set(SET["queries"]) == set(SET["qrels"]), "every question needs its answer written down"
    print(f"selftest ok: {len(SET['queries'])} questions, {len(SET['corpus'])} documents")


def team_of(email: str) -> str:
    """Drive's team for this reader, read now: .users.json caches one that a rebuilt site invalidates."""
    team = bench("execute", "frappe.db.get_value", "--args", json.dumps(
        ["Drive Team Member", {"user": email, "parenttype": "Drive Team"}, "parent"])).strip('"')
    if team in ("", "None", "null"):
        raise SystemExit(f"retrieval: {email} has no Drive team; run make test-seed")
    return team


def seed(reader: Session, team: str, owner: str) -> dict[str, str]:
    """Put the corpus in the reader's Drive if it is not there yet; return {File.name: corpus id}."""
    for doc_id, doc in SET["corpus"].items():
        if not _file_id(doc_id, owner):
            status, _ = reader.upload(team, doc_id, doc["text"].encode())
            print(f"seeded {doc_id} -> {status}")
    deadline = time.time() + 300
    while True:
        ids = {name: doc_id for doc_id in SET["corpus"] if (name := _file_id(doc_id, owner))}
        missing = [d for d in SET["corpus"] if d not in ids.values()]
        chunked = _chunked(list(ids)) if ids else 0
        if not missing and chunked == len(ids):
            return ids
        if time.time() > deadline:
            raise SystemExit(f"retrieval: {missing or ''} never appeared, {chunked}/{len(ids)} indexed")
        time.sleep(5)


def _file_id(file_name: str, owner: str) -> str:
    """The reader's own copy: the demo site has documents of these names too, and they are not this corpus."""
    value = bench("execute", "frappe.db.get_value", "--args", json.dumps(
        ["File", {"file_name": file_name, "is_folder": 0, "owner": owner}, "name"])).strip('"')
    return "" if value in ("", "None", "null") else value


def _chunked(files: list[str]) -> int:
    rows = json.loads(bench("execute", "frappe.db.sql", "--kwargs", json.dumps(
        {"query": "SELECT COUNT(DISTINCT file) AS n FROM `tabKB Chunk` WHERE file IN %(f)s",
         "values": {"f": files}, "as_dict": 1})))
    return rows[0]["n"]


def main():
    who = users()[READER]
    reader = Session(who["email"], who["password"])
    ids = seed(reader, team_of(who["email"]), who["email"])
    totals = {f"{m}@{k}": 0.0 for k in CUTOFFS for m in ("recall", "ndcg")}
    for qid, question in sorted(SET["queries"].items()):
        status, body = reader.post("rag.search.search", query=question, limit=LIMIT)
        if status != 200:
            raise SystemExit(f"retrieval: {qid} answered {status}")
        ranked = list(dict.fromkeys(ids.get(row["file"], row["file"]) for row in body.get("message") or []))
        line = [qid]
        for k in CUTOFFS:
            recall, ndcg = score(ranked, SET["qrels"][qid], k)
            totals[f"recall@{k}"] += recall
            totals[f"ndcg@{k}"] += ndcg
            line.append(f"r@{k}={recall:.2f} n@{k}={ndcg:.2f}")
        print("  ".join(line), " |", ", ".join(ranked[:3]) or "nothing")
    n = len(SET["queries"])
    failures = []
    print(f"\n{SITE}: {n} questions over {len(SET['corpus'])} documents")
    for metric, total in totals.items():
        mean, floor = total / n, FLOOR.get(metric)
        gate = "" if floor is None else f"   floor {floor:.2f}   {'PASS' if mean >= floor else 'FAIL'}"
        print(f"  {metric:<9} {mean:.3f}{gate}")
        if floor is not None and mean < floor:
            failures.append(metric)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
