import unittest

import frappe
from frappe.utils import set_request
from frappe.website.path_resolver import PathResolver

from rag.preview import FilePage
from rag.tests import drive_fixture


class TestPreview(unittest.TestCase):
	PROBE = "rag-preview-probe@example.com"

	@classmethod
	def setUpClass(cls):
		# the file the assertions name, made here so the suite runs on a site without the demo's data
		pdf = drive_fixture.pdf("Reimbursed monthly.")
		cls.files = [drive_fixture.drive_file("reimbursement-policy.pdf", pdf, "application/pdf")]

	@classmethod
	def tearDownClass(cls):
		drive_fixture.remove(*cls.files)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.local.form_dict = frappe._dict()

	def _resolve(self, path):
		set_request(method="GET", path=path)
		return PathResolver(path.strip("/")).resolve()[1]

	def test_a_preview_address_serves_drives_file_under_its_own_name(self):
		name = frappe.db.get_value("File", {"file_name": "reimbursement-policy.pdf", "is_folder": 0}, "name")
		renderer = self._resolve(f"/ask/files/{name}/reimbursement-policy.pdf")
		self.assertIsInstance(renderer, FilePage)
		response = renderer.render()
		self.assertEqual(response.mimetype, "application/pdf")
		self.assertIn("inline", response.headers["Content-Disposition"])

	def test_the_rest_of_ask_is_still_the_app(self):
		self.assertNotIsInstance(self._resolve("/ask/chat/x"), FilePage)

	def test_drives_read_check_still_applies(self):
		name = frappe.db.get_value("File", {"file_name": "reimbursement-policy.pdf", "is_folder": 0}, "name")
		frappe.set_user("Guest")  # before resolving: switching user clears the request's form_dict
		renderer = self._resolve(f"/ask/files/{name}/reimbursement-policy.pdf")
		with self.assertRaises(frappe.PermissionError):
			renderer.render()

	def test_a_signed_in_reader_with_no_share_on_the_file_is_refused_too(self):
		name = frappe.db.get_value("File", {"file_name": "reimbursement-policy.pdf", "is_folder": 0}, "name")
		try:
			# before resolving: switching user clears the request's form_dict
			frappe.set_user(drive_fixture.drive_user(self.PROBE))
			renderer = self._resolve(f"/ask/files/{name}/reimbursement-policy.pdf")
			with self.assertRaises(frappe.PermissionError):
				renderer.render()
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()
