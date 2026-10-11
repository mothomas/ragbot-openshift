"""Seed the test site with three test users and one private document each for alice and bob.

python3 seed.py   (idempotent; passwords are generated once into .users.json, mode 600, never printed)
carol has no shares at all. Each document carries a marker phrase no other document contains.
"""
import json
import secrets
import time

from lib import SITE, USERS, Session, bench

PEOPLE = {
    "alice": ("alice@audit.test", "Alice", "alice-roadmap.txt",
              "Project Zephyr is the internal codename for the Adelaide expansion. It opens on 14 March "
              "with a budget of 2.4 million dollars and reports to the regional director."),
    "bob": ("bob@audit.test", "Bob", "bob-benefits.txt",
            "The Kestrel allowance pays every field engineer 310 dollars a month for protective boots, "
            "claimed through the expense form within 60 days."),
    "carol": ("carol@audit.test", "Carol", None, None),
}


def main():
    creds = json.loads(USERS.read_text()) if USERS.exists() else {}
    for key, (email, first, *_rest) in PEOPLE.items():
        if key not in creds:
            creds[key] = {"email": email, "password": secrets.token_urlsafe(18)}
        exists = bench("execute", "frappe.db.exists", "--args", json.dumps(["User", email]))
        if exists in ("", "None", "null"):
            # bench execute has no web session, so Drive's after_insert set_user dance logs nobody out
            bench("execute", "frappe.client.insert", "--kwargs", json.dumps({"doc": {
                "doctype": "User", "email": email, "first_name": first, "send_welcome_email": 0,
                "new_password": creds[key]["password"], "roles": [{"role": "Drive User"}]}}))
        else:
            bench("execute", "frappe.utils.password.update_password", "--kwargs",
                  json.dumps({"user": email, "pwd": creds[key]["password"]}))
    USERS.write_text(json.dumps(creds, indent=1))
    USERS.chmod(0o600)
    for key, (email, _first, fname, text) in PEOPLE.items():
        if not fname:
            continue
        s = Session(email, creds[key]["password"])
        team = bench("execute", "frappe.db.get_value", "--args", json.dumps(
            ["Drive Team Member", {"user": email, "parenttype": "Drive Team"}, "parent"])).strip('"')
        if team in ("", "None", "null"):
            raise SystemExit(f"{key}: no Drive team")
        existing = bench("execute", "frappe.db.get_value", "--args", json.dumps(
            ["File", {"file_name": fname, "owner": email, "is_folder": 0}, "name"])).strip('"')
        if existing in ("", "None", "null"):
            st, body = s.upload(team, fname, text.encode())
            print(f"{key}: upload {fname} -> {st}")
        creds[key]["team"] = team
        creds[key]["file"] = bench("execute", "frappe.db.get_value", "--args", json.dumps(
            ["File", {"file_name": fname, "owner": email, "is_folder": 0}, "name"])).strip('"')
    USERS.write_text(json.dumps(creds, indent=1))
    deadline = time.time() + 180
    while time.time() < deadline:
        health = json.loads(bench("execute", "rag.ingest.health"))
        if health.get("chunks", 0) >= 2 and not health.get("unembedded"):
            break
        time.sleep(5)
    print(f"{SITE}: users {', '.join(creds)}; index {health}")


if __name__ == "__main__":
    main()
