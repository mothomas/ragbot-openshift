"""Retrieval leaves a record: who searched, for which chat, which passages came back, and what failed."""

import json
import logging
import unittest
from unittest.mock import patch

import frappe
import requests

from rag.ingest import CHAT
from rag.search import _log, passages, search
from rag.tests.drive_fixture import drive_file, drive_user, remove, vector

QUESTION = "What is the Kestrel allowance?"
DENIED = "search-audit-no-drive@example.com"


def rows(method="rag.search.search") -> list:
	return frappe.get_all(
		"Access Log",
		filters={"method": method},
		fields=["name", "user", "export_from", "reference_document", "filters"],
	)


class TestSearchLeavesATrail(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.file = drive_file("search-audit.txt", b"The Kestrel allowance is 310 AUD a month.", "text/plain")

	@classmethod
	def tearDownClass(cls):
		remove(cls.file)

	def setUp(self):
		self.before = {r.name for r in rows()} | {r.name for r in rows("rag.search.passages")}

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def new_rows(self, method="rag.search.search") -> list:
		frappe.set_user("Administrator")  # Access Log is a System Manager's to read, not the searcher's
		return [r for r in rows(method) if r.name not in self.before]

	def test_a_search_records_the_reader_the_chat_and_the_files_but_not_the_question(self):
		# assertNoLogs: an answered search says nothing at all, so the question cannot leak into a line
		with patch("rag.search.embed", return_value=[vector(0)]), self.assertNoLogs(frappe.logger("rag")):
			found = search(QUESTION, session="chat-audit-1")
		self.assertTrue(found, "this test needs the index to answer")
		logged = self.new_rows()
		self.assertEqual(len(logged), 1, f"one row per search, got {len(logged)}")
		self.assertEqual(logged[0].user, "Administrator")
		self.assertEqual(logged[0].reference_document, "chat-audit-1")
		self.assertEqual(logged[0].export_from, CHAT, "the desk links the pair as one document")
		recorded = json.loads(logged[0].filters)
		self.assertEqual(recorded["files"], sorted({r["file"] for r in found}))
		self.assertEqual(recorded["count"], len(found))
		self.assertNotIn("Kestrel", logged[0].filters, "the question is never written down")

	def test_a_search_that_matched_nothing_is_still_recorded(self):
		"""Otherwise the only searches on record are the ones that found something."""
		with (
			patch("rag.search.embed", return_value=[vector(0)]),
			patch("rag.search._nearest", return_value=[]),
			self.assertNoLogs(frappe.logger("rag")),
		):
			self.assertEqual(search(QUESTION), [])
		logged = self.new_rows()
		self.assertEqual(len(logged), 1)
		self.assertEqual(json.loads(logged[0].filters)["count"], 0)

	def test_reading_a_saved_source_again_is_on_the_trail_too(self):
		"""Reopening a chat re-reads the passages through rag.search.passages, not through search."""
		seq = frappe.db.get_value("KB Chunk", {"file": self.file}, "seq")
		self.assertTrue(passages([{"file": self.file, "seq": seq}]), "this test needs the chunk to be readable")
		logged = self.new_rows("rag.search.passages")
		self.assertEqual(len(logged), 1)
		self.assertEqual(json.loads(logged[0].filters)["files"], [self.file])

	def test_the_loggers_level_is_raised_so_a_warning_is_not_dropped(self):
		"""assertLogs sets the level itself, so nothing else here would notice if _log() stopped."""
		_log()
		self.assertLessEqual(frappe.logger("rag").level, logging.WARNING)

	def test_a_refused_search_is_logged_and_leaves_no_access_row(self):
		frappe.set_user(drive_user(DENIED, drive_role=False))
		with (
			self.assertLogs(frappe.logger("rag"), level="WARNING") as caught,
			self.assertRaises(frappe.PermissionError),
		):
			search(QUESTION)
		self.assertIn("search refused", caught.output[0])
		self.assertIn(DENIED, caught.output[0])
		self.assertNotIn("Kestrel", caught.output[0])
		self.assertEqual(self.new_rows(), [], "nothing was read, so nothing is recorded as read")

	def test_an_unreachable_model_is_logged_as_its_class_and_nothing_else(self):
		with (
			patch("rag.search.embed", side_effect=requests.ConnectionError("http://ollama:11434 refused")),
			self.assertLogs(frappe.logger("rag"), level="ERROR") as caught,
			self.assertRaises(frappe.ValidationError),
		):
			search(QUESTION)
		self.assertIn("ConnectionError", caught.output[0])
		self.assertNotIn("11434", caught.output[0], "the exception's message names the model's address")
		self.assertNotIn("Kestrel", caught.output[0])
