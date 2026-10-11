"""make citations: every source an answer shows was a passage that answer actually retrieved.

python3 citations.py   exit 0 only if every case holds; prints counts and file ids, never a passage.
Needs seed.py to have run.

An answer's sources are shown to the reader as the documents it used. Nothing between the model and the
page checks that claim: the sources chunk is whatever came back from the agent. This asks one question,
takes the file ids rag.search.search recorded in frappe's Access Log for it (which it writes per answered
call, see rag/rag/search.py _audit), and asserts the cited ids are a subset of them. An invented citation
is a file id in the answer that is in no Access Log row this question produced.

The rows are identified by name, before and against after, not by a timestamp: `creation` on a deferred row
is written when frappe flushes it, not when the search ran, and the db container's clock is 9.5 hours from
the site's, so no time window can scope these rows to one question.
"""
import json
import sys

from lib import SITE, Session, bench, users

QUESTION = "What is the Kestrel allowance? Search the knowledge base."
READER = "bob"  # seed.py gives him the document that answers it
failures = []


def case(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def invented(cited: list[dict], found: set[str]) -> list[str]:
    """The cited file ids that are in no Access Log row for this turn."""
    return sorted({s["file"] for s in cited if s.get("file")} - found)


def selftest():
    """The comparison, checked without a stack: `python3 citations.py --selftest`."""
    assert invented([{"file": "a"}, {"file": "b"}], {"a", "b", "c"}) == []
    assert invented([{"file": "a"}, {"file": "z"}], {"a", "b"}) == ["z"], "a source nothing retrieved"
    assert invented([{"file": "a"}], set()) == ["a"], "no retrieval on record means every source is unproven"
    assert invented([{"seq": 0}], {"a"}) == [], "a source with no file is caught by its own case"
    print("selftest ok")


def logged(user: str) -> dict[str, str]:
    """This reader's search rows, by name; flushed first, because make_access_log defers into redis."""
    bench("execute", "frappe.deferred_insert.save_to_db")  # the scheduler would take 15 minutes
    # bench execute prints nothing at all for an empty result, which is the state this check starts in
    rows = json.loads(bench("execute", "frappe.db.sql", "--kwargs", json.dumps({
        "query": "SELECT name, filters FROM `tabAccess Log` WHERE method = %(m)s AND user = %(u)s",
        "values": {"m": "rag.search.search", "u": user},
        "as_dict": 1,
    })) or "[]")
    return {r["name"]: r["filters"] or "{}" for r in rows}


def main():
    who = users()[READER]
    reader = Session(who["email"], who["password"])
    before = logged(who["email"])

    status, events = reader.chat(QUESTION)
    cited = [s for e in events if e.get("type") == "sources" for s in (e.get("sources") or e.get("items") or [])]
    case(status == 200 and any(e.get("type") == "done" for e in events), "the answer completed", f"status {status}")

    new = {name: f for name, f in logged(who["email"]).items() if name not in before}
    found = {f for blob in new.values() for f in json.loads(blob).get("files", [])}
    case(bool(found), "this question's retrieval was recorded", f"{len(new)} rows, {len(found)} file ids")
    case(bool(cited), "the answer cited something", f"{len(cited)} sources")

    unproven = invented(cited, found)
    case(not unproven, "every cited source was retrieved for this question", f"not retrieved: {unproven}")
    case(all(s.get("file") for s in cited), "every cited source names a file", f"{sum(1 for s in cited if not s.get('file'))} without one")

    print(f"\n{SITE}: {len(cited)} citations, {len(found)} passages retrieved")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
