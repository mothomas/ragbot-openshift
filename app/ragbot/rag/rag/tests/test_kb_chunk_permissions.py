"""KB Chunk holds the text of private Drive files, so no role reads it directly: search reaches it
only through Drive's own read check, and System Manager keeps just the report permission it asks for."""

import unittest

import frappe

USER = "kb-chunk-system-manager@example.com"


class TestKBChunkIsNotReadDirectly(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		if not frappe.db.exists("User", USER):
			user = {"doctype": "User", "email": USER, "first_name": "KB", "send_welcome_email": 0}
			frappe.get_doc(user | {"roles": [{"role": "System Manager"}]}).insert(ignore_permissions=True)

	def tearDown(self):
		frappe.set_user("Administrator")

	def test_a_system_manager_cannot_list_chunks_but_keeps_the_search_gate(self):
		frappe.set_user(USER)
		with self.assertRaises(frappe.PermissionError):
			frappe.get_list("KB Chunk", fields=["file"])
		self.assertTrue(frappe.has_permission("KB Chunk", "report"))
