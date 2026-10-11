"""The demo's own verification after a checkpoint moves it: back up, seed, run the smoke journeys against the demo
site, then remove what the run created and prove the site is as it was.

    DEMO_CHECKPOINT=1 python3 demo_checkpoint.py [--skip-backup]

The data-changing checks are kept off the demo by the guards in lib.py and the Makefile; this path is the one
exception the owner asked for (DECISIONS.md, CKQ1), and it pays for itself by counting every doctype it could touch
before and after. Deleting a Drive user leaves rows behind, so the cleanup removes the files and the personal team
first, then the user, and the counts are what says whether anything was missed.
"""
import json
import os
import subprocess
import sys

import lib

DRIVE_MODULE = "Drive"
COUNTED = ["User", "File", "KB Chunk", "AI Chat Session", "AI Chat Message"]


def names(doctype, filters, pluck="name"):
    """bench prints nothing for an empty result, so an empty answer is an empty list."""
    out = lib.bench("execute", "frappe.get_all", "--kwargs", json.dumps(
        {"doctype": doctype, "filters": filters, "pluck": pluck}))
    return json.loads(out) if out.strip() else []


def counts():
    """Every Drive doctype plus the ones this run writes to, as {doctype: rows}."""
    drive = names("DocType", {"module": DRIVE_MODULE, "issingle": 0})
    out = {}
    for doctype in sorted(set(drive) | set(COUNTED)):
        out[doctype] = int(lib.bench("execute", "frappe.db.count", "--args", json.dumps([doctype])) or 0)
    return out


def remove(email):
    """A Drive user's files and personal team go before the user, or their rows outlive them."""
    for name in names("File", {"owner": email}):
        lib.bench("execute", "frappe.delete_doc", "--kwargs", json.dumps(
            {"doctype": "File", "name": name, "force": 1, "ignore_permissions": 1, "delete_permanently": 1}))
    for doctype, field in (("AI Chat Message", "owner"), ("AI Chat Session", "user"), ("AI Chat Session", "owner")):
        for name in names(doctype, {field: email}):
            lib.bench("execute", "frappe.delete_doc", "--kwargs", json.dumps(
                {"doctype": doctype, "name": name, "force": 1, "ignore_permissions": 1}))
    # what Drive leaves behind: delete_doc on a Drive Team fails its own validation, and these rows outlive the user
    for doctype, field in (("Drive Entity Activity Log", "owner"), ("Drive Settings", "user"),
                           ("Drive Team Member", "user"), ("Drive Team", "owner"), ("KB Chunk", "owner")):
        lib.bench("execute", "frappe.db.delete", "--args", json.dumps([doctype, {field: email}]))
    lib.bench("execute", "frappe.delete_doc", "--kwargs", json.dumps(
        {"doctype": "User", "name": email, "force": 1, "ignore_permissions": 1}))
    lib.bench("execute", "frappe.db.commit")


def main():
    if os.environ.get("DEMO_CHECKPOINT") != "1":
        sys.exit("demo_checkpoint.py runs only with DEMO_CHECKPOINT=1: it writes to the site it is given")
    here = os.path.dirname(os.path.abspath(__file__))
    if "--skip-backup" not in sys.argv:
        print(lib.bench("backup", site=lib.SITE).splitlines()[-1])
    before = counts()

    seed = subprocess.run([sys.executable, os.path.join(here, "seed.py")], cwd=here, env=os.environ)
    smoke = subprocess.run(["npx", "playwright", "test", "smoke.spec.ts"], cwd=here,
                           env={**os.environ, "TEST_WEB": f"http://{lib.SITE}:{os.environ.get('TEST_HTTP_PORT', '8080')}"})

    users = json.loads(open(os.path.join(here, ".users.json")).read())
    for who in users.values():
        remove(who["email"])
    after = counts()

    same = {d: (before[d], after[d]) for d in before if before[d] != after.get(d)}
    for doctype, (b, a) in sorted(same.items()):
        print(f"LEFT BEHIND  {doctype}: {b} rows before, {a} after")
    print(f"{lib.SITE}: seed {'ok' if seed.returncode == 0 else 'FAILED'}, "
          f"smoke {'ok' if smoke.returncode == 0 else 'FAILED'}, "
          f"{'nothing left behind' if not same else str(len(same)) + ' doctypes changed'}")
    sys.exit(1 if (seed.returncode or smoke.returncode or same) else 0)


if __name__ == "__main__":
    main()
