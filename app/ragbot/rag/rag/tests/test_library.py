import unittest

import frappe
from drive.utils import get_default_team, get_home_folder

from rag.library import documents, folder
from rag.tests import drive_fixture


class TestLibrary(unittest.TestCase):
	PROBE = "rag-library-probe@example.com"

	@classmethod
	def setUpClass(cls):
		# the team and files the assertions name, made here so it runs on a site without the demo's data
		pdf = drive_fixture.pdf("Reimbursed monthly.")
		cls.files = [
			drive_fixture.drive_file("expense-policy.txt", b"Expenses are claimed within 30 days.\n", "text/plain"),
			drive_fixture.drive_file("reimbursement-policy.pdf", pdf, "application/pdf"),
		]

	@classmethod
	def tearDownClass(cls):
		drive_fixture.remove(*cls.files)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def test_the_root_is_the_drive_home_with_each_files_search_state(self):
		out = folder()
		self.assertEqual(out["path"], [{"name": "", "title": "Documents"}])
		self.assertTrue(out["can_upload"])
		team = get_default_team()
		self.assertEqual((out["folder"], out["team"]), (get_home_folder(team)["name"], team))
		files = [i for i in out["items"] if not i["is_folder"]]
		self.assertIn("expense-policy.txt", [i["title"] for i in files])
		self.assertEqual({i["state"] for i in files}, {"ready"}, "the demo's files are all indexed")
		self.assertEqual({(i["owner"], i["owner_name"]) for i in files}, {("Administrator", "Administrator")})
		self.assertEqual({i["type"] for i in files}, {"PDF", "Text"}, "Drive's file_type picks the preview")

	def test_a_folder_opens_with_its_path(self):
		# Drive's create_folder also makes a directory, which the test runner's cwd puts outside
		# the site; the record is what the listing reads
		team = get_default_team()
		made = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "Library test folder",
				"is_folder": 1,
				"team": team,
				"folder": get_home_folder(team)["name"],
			}
		).insert()
		self.assertIn("Library test folder", [i["title"] for i in folder()["items"] if i["is_folder"]])
		inside = folder(made.name)
		crumbs = [{"name": "", "title": "Documents"}, {"name": made.name, "title": "Library test folder"}]
		self.assertEqual(inside["path"], crumbs)
		self.assertEqual(inside["items"], [])

	def test_a_folder_nobody_shared_with_you_is_refused(self):
		team = get_default_team()
		mine = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "Not yours",
				"is_folder": 1,
				"team": team,
				"folder": get_home_folder(team)["name"],
			}
		).insert()
		frappe.set_user(drive_fixture.drive_user(self.PROBE))
		with self.assertRaises(frappe.PermissionError):
			folder(mine.name)

	def test_a_shared_subfolder_never_names_the_folders_above_it(self):
		team = get_default_team()
		outer = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "Payroll",
				"is_folder": 1,
				"team": team,
				"folder": get_home_folder(team)["name"],
			}
		).insert()
		inner = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "For the probe",
				"is_folder": 1,
				"team": team,
				"folder": outer.name,
			}
		).insert()
		frappe.get_doc("File", inner.name).share(user=drive_fixture.drive_user(self.PROBE), read=1)
		frappe.set_user(self.PROBE)
		self.assertEqual(
			[c["title"] for c in folder(inner.name)["path"]],
			["Documents", "For the probe"],
			"the breadcrumb stops where the reader loses read, so Payroll is never named",
		)

	def test_a_file_inside_a_shared_folder_is_still_listed(self):
		# documents() narrows the candidates in SQL before readable() decides; a file the SQL drops
		# is a file the chat can no longer name, and a share reaches everything under the folder
		team = get_default_team()
		outer = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "Shared outer",
				"is_folder": 1,
				"team": team,
				"folder": get_home_folder(team)["name"],
			}
		).insert()
		inner = frappe.get_doc(
			{"doctype": "File", "file_name": "Inner", "is_folder": 1, "team": team, "folder": outer.name}
		).insert()
		name = drive_fixture.drive_file("nested-policy.txt", b"Claimed within 30 days.\n", "text/plain")
		try:
			frappe.db.set_value("File", name, "folder", inner.name)
			frappe.get_doc("File", outer.name).share(user=drive_fixture.drive_user(self.PROBE), read=1)
			frappe.set_user(self.PROBE)
			self.assertIn(name, [d["name"] for d in documents()])
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()
			drive_fixture.remove(name)

	def test_search_spans_every_folder(self):
		self.assertEqual([i["title"] for i in folder(search="expense-pol")["items"]], ["expense-policy.txt"])

	def test_files_shared_with_you_sit_at_the_top_level_under_their_owner(self):
		name = frappe.db.get_value("File", {"file_name": "expense-policy.txt", "is_folder": 0}, "name")
		frappe.get_doc(
			{
				"doctype": "User",
				"email": self.PROBE,
				"first_name": "Probe",
				"send_welcome_email": 0,
				"roles": [{"role": "Drive User"}],
			}
		).insert(ignore_permissions=True)
		frappe.get_doc("File", name).share(user=self.PROBE, read=1)
		frappe.set_user(self.PROBE)
		item = next(i for i in folder()["items"] if i["name"] == name)
		self.assertEqual((item["owner"], item["title"]), ("Administrator", "expense-policy.txt"))
		self.assertEqual([i["name"] for i in folder(search="expense-pol")["items"]], [name], "search finds it too")
