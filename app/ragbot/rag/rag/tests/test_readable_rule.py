"""One rule decides whether a Drive file is readable, and the Documents list shares it with search."""

import unittest

import frappe

from rag.library import documents
from rag.search import passages, readable
from rag.tests.drive_fixture import drive_file, remove


class TestReadableRule(unittest.TestCase):
	def test_an_empty_team_is_not_a_drive_file_for_the_documents_list_either(self):
		"""File.team is a nullable Link with no default, so a row can hold "". Search reads that as
		out of Drive (`bool(team)`); the Documents list read it as in Drive (`team IS NOT NULL`)
		and offered a source whose text nothing would ever hand back."""
		name = drive_file("readable-rule.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		try:
			self.assertIn(name, [d["name"] for d in documents()], "an ordinary Drive file is listed")
			frappe.db.set_value("File", name, "team", "", update_modified=False)
			self.assertFalse(readable(name), "an empty team is not a team")
			self.assertNotIn(name, [d["name"] for d in documents()])
			self.assertEqual(passages([{"file": name, "seq": 0}]), [], "and its text stays unreadable")
		finally:
			frappe.db.rollback()
			remove(name)
