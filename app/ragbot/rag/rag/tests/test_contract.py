import inspect
import unittest
from unittest.mock import patch

import frappe

from rag import chat, search
from rag.tests import drive_fixture
from rag.tests import test_chat as tc

AXIS = 7  # nothing else on the site embeds here, so only this test's two files are at distance 0
DRIVE_ROW = {"file", "seq", "content", "distance"}
ATTACHED_ROW = DRIVE_ROW | {"file_name", "attachment"}


class TestSearchContract(unittest.TestCase):
	"""The MCP server's search_knowledge_base tool calls this endpoint over HTTP by name."""

	def test_the_parameters_and_their_defaults_are_unchanged(self):
		self.assertEqual(
			str(inspect.signature(search.search)),
			"(query: str = '', limit: int = 5, session: str = '') -> list[dict]",
		)

	def test_it_answers_post_and_nothing_else(self):
		"""GET puts the question in the URL, where every access log on the way keeps it (ADR-037)."""
		self.assertEqual(list(frappe.allowed_http_methods_for_whitelisted_func[search.search]), ["POST"])


class TestRowShapes(unittest.TestCase):
	"""A Drive row and a chat attachment's row are not the same shape. The Go client types the reply
	as an untyped map, so this is the only place either key set is written down."""

	@classmethod
	def setUpClass(cls):
		cls.file = drive_fixture.drive_file(
			"contract-policy.txt", b"Kestrel allowance is 600 AUD.\n", "text/plain", AXIS
		)
		cls.chat = tc._a_chat("row shapes")
		with patch("rag.ingest.embed", side_effect=drive_fixture.vectors(AXIS)):
			cls.attached = tc._attach(cls.chat, "contract-note.txt", "The excess is 250 AUD.\n")
		frappe.db.commit()

	@classmethod
	def tearDownClass(cls):
		drive_fixture.remove(cls.file, cls.attached)
		chat.delete_chat(cls.chat)  # the messages go with it; delete_doc alone orphans them
		frappe.db.commit()

	def _rows(self, session=""):
		with patch("rag.search.embed", return_value=[drive_fixture.vector(AXIS)]):
			return search.search("allowance", limit=5, session=session)

	def test_a_drive_row_has_exactly_these_keys(self):
		rows = [r for r in self._rows() if r["file"] == self.file]
		self.assertTrue(rows, "the fixture file did not come back")
		self.assertEqual(set(rows[0]), DRIVE_ROW)

	def test_an_attached_row_has_exactly_these_keys(self):
		rows = [r for r in self._rows(session=self.chat) if r["file"] == self.attached]
		self.assertTrue(rows, "the chat's own attachment did not come back")
		self.assertEqual(set(rows[0]), ATTACHED_ROW)
		self.assertIs(rows[0]["attachment"], True)
