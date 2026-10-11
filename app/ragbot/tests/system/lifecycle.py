"""make lifecycle: each Frappe app's lifecycle on a throwaway site: install, migrate, migrate again with no change, uninstall leaving no
tables, reinstall, and no Error Log rows along the way, for rag and for frappe_ai.

python3 lifecycle.py [rag|frappe_ai ...]   creates life-<app>.localhost, drops it at the end.
"""
import json
import subprocess
import sys

from lib import PROJECT, env

DBPW, APW = env("DB_PASSWORD"), env("ADMIN_PASSWORD")
APPS = {"rag": {"deps": ["drive"], "tables": ["tabKB Chunk"]},
        "frappe_ai": {"deps": [], "tables": ["tabAI Chat Session", "tabAI Chat Message"]}}
failures = []


def bench(*args, site=None, timeout=1800):
    cmd = ["docker", "exec", f"{PROJECT}-backend-1", "bench", *(["--site", site] if site else []), *args]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr)


def case(ok, app, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  [{app}] {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(f"{app}: {label}")


def sql(site, q):
    rc, out = bench("execute", "frappe.db.sql", "--kwargs", json.dumps({"query": q}), site=site)
    return json.loads(out.strip().splitlines()[-1]) if rc == 0 else None


def errors(site):
    bench("execute", "frappe.deferred_insert.save_to_db", site=site)
    rows = sql(site, "select count(*) from `tabError Log`")
    return rows[0][0] if rows else -1


def tables(site, names):
    rows = sql(site, "select table_name from information_schema.tables where table_schema = database()") or []
    have = {r[0] for r in rows}
    return [n for n in names if n in have]


def run(app):
    site = f"life-{app.replace('_', '')}.localhost"
    spec = APPS[app]
    bench("drop-site", site, "--force", "--no-backup", "--db-root-password", DBPW)
    installs = [a for d in spec["deps"] for a in ("--install-app", d)] + ["--install-app", app]
    rc, out = bench("new-site", site, "--mariadb-user-host-login-scope=%", "--db-root-password", DBPW, "--admin-password", APW, *installs)
    case(rc == 0, app, "installs on a clean site", f"exit {rc}")
    if rc:
        print(out[-600:])
        return
    base = errors(site)
    case(set(tables(site, spec["tables"])) == set(spec["tables"]), app, "install creates its tables", str(tables(site, spec["tables"])))
    if app == "rag":
        col = sql(site, "select column_type from information_schema.columns where table_schema = database() and table_name = 'tabKB Chunk' and column_name = 'embedding'")
        case(bool(col), app, "install adds the vector column", str(col))
    rc, out = bench("migrate", site=site)
    case(rc == 0, app, "migrate succeeds", f"exit {rc}")
    rc, out2 = bench("migrate", site=site)
    case(rc == 0 and "Traceback" not in out2, app, "a second migrate with no change succeeds", f"exit {rc}")
    case(errors(site) == base, app, "install and migrates add no Error Log rows", f"{errors(site) - base} new")
    rc, out = bench("uninstall-app", app, "--yes", "--no-backup", "--force", site=site)
    case(rc == 0, app, "uninstalls", f"exit {rc}: {out.strip().splitlines()[-1][:100] if out.strip() else ''}")
    left = tables(site, spec["tables"])
    case(not left, app, "uninstall leaves none of its tables", str(left))
    leftovers = sql(site, f"select count(*) from `tabCustom Field` where module in (select name from `tabModule Def` where app_name = '{app}')")
    case(leftovers in ([[0]], None), app, "uninstall leaves no custom fields", str(leftovers))
    rc, out = bench("install-app", app, site=site)
    case(rc == 0, app, "reinstalls", f"exit {rc}")
    case(set(tables(site, spec["tables"])) == set(spec["tables"]), app, "reinstall recreates its tables")
    bench("drop-site", site, "--force", "--no-backup", "--db-root-password", DBPW)


if __name__ == "__main__":
    for a in sys.argv[1:] or list(APPS):
        run(a)
    sys.exit(1 if failures else 0)
