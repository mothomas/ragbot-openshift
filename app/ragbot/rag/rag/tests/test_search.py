"""The public search endpoint's own contract, and the index's health."""

import unittest
from unittest.mock import patch

import frappe
import requests

from rag.ingest import EMBED_DIM
from rag.search import MAX_QUERY_CHARS, search
from rag.tests import drive_fixture


class TestSearchArguments(unittest.TestCase):
	"""search() is a public HTTP endpoint another repo calls, so its edges are the contract."""

	def test_a_blank_question_costs_nothing_and_answers_nothing(self):
		"""It used to embed the whitespace and answer from whichever document was nearest."""
		with patch("rag.search.embed") as embed:
			for blank in ("", "   ", "\n\t "):
				self.assertEqual(search(blank), [], repr(blank))
		embed.assert_not_called()

	def test_a_missing_question_is_not_a_traceback(self):
		"""`?limit=5` with no query used to answer 500 with the whole traceback in the body."""
		with patch("rag.search.embed") as embed:
			self.assertEqual(search(), [])
		embed.assert_not_called()

	def test_an_over_long_question_is_cut_to_what_the_model_accepts(self):
		"""Ollama answers 400 past its context, which surfaced as a 500 naming its own URL."""
		with (
			patch("rag.search.embed", return_value=[[0.0] * EMBED_DIM]) as embed,
			patch("rag.search._nearest", return_value=[]),
		):
			search("policy " * 3000)
		self.assertEqual(len(embed.call_args.args[0][0]), MAX_QUERY_CHARS)

	def test_an_unreachable_model_is_reported_not_raised(self):
		with (
			patch("rag.search.embed", side_effect=requests.ConnectionError("no route")),
			self.assertRaises(frappe.ValidationError) as caught,
		):
			search("mileage")
		self.assertNotIn("no route", str(caught.exception), "the message must not carry the URL")

	def test_the_limit_is_clamped(self):
		"""A caller asking for thousands would hand the model the whole corpus. Anything that
		is not an integer never gets here: frappe's own type check answers 417 first."""
		# more rows than the largest clamped limit, so what comes back is the clamp and not the index
		found = [frappe._dict(file=f"f{i}", seq=0, content="policy", distance=i / 1000) for i in range(25)]
		with (
			patch("rag.search.embed", return_value=[[0.0] * EMBED_DIM]),
			patch("rag.search._nearest", return_value=found),
			patch("rag.search.readable", return_value=True),
		):
			for given, wanted in ((999, 20), (0, 1), (-5, 1)):
				self.assertEqual(len(search("mileage", limit=given)), wanted, f"limit={given!r}")


class TestIndexHealth(unittest.TestCase):
	def test_a_zeroed_vector_is_reported(self):
		"""What a restored backup leaves behind: frappe's mariadb-dump has no --hex-blob, so
		every vector comes back as zeroes, with no error, and then answers every question."""
		from uuid import uuid7

		from rag.ingest import embed_model, health

		self.assertEqual(health()["problems"], [], "this site should be healthy before the test")
		try:
			# its own row, not a copy of one: SELECT ... LIMIT 1 inserts nothing on an empty index
			frappe.db.sql(
				"INSERT INTO `tabKB Chunk`"
				" (name, creation, modified, owner, modified_by, file, seq, content, model, embedding)"
				" VALUES (%s, NOW(6), NOW(6), 'Administrator', 'Administrator',"
				" 'zeroed-vector-probe', 999, 'probe', %s, VEC_FromText(%s))",
				(str(uuid7()), embed_model(), "[" + ",".join(["0"] * EMBED_DIM) + "]"),
			)
			problems = health()["problems"]
		finally:
			frappe.db.rollback()
		self.assertTrue(any("all-zero" in p for p in problems), problems)
		self.assertTrue(any("reindex_all" in p for p in problems), problems)


AXES = {"leave": 1, "travel": 2}


class TestRanking(unittest.TestCase):
	"""The vector index is approximate: at MariaDB's default width it found nothing for some of
	the demo's questions, and it returned the rest in its own order. The best match must come first,
	every time; repeated because the index's misses vary from call to call."""

	@classmethod
	def setUpClass(cls):
		# two documents on known vectors, and the questions embedded onto them: no demo data, no live model
		cls.files = [
			drive_fixture.drive_file("parental-leave.txt", b"Parental leave is 20 weeks.\n", "text/plain", axis=1),
			drive_fixture.drive_file("travel-policy.txt", b"Travel is booked online.\n", "text/plain", axis=2),
		]

	@classmethod
	def tearDownClass(cls):
		drive_fixture.remove(*cls.files)

	@patch("rag.search.embed", side_effect=lambda texts, *a: [drive_fixture.vector(AXES[texts[0]])])
	def test_the_closest_document_comes_first(self, _embed):
		for question, expected in [("leave", "parental-leave.txt"), ("travel", "travel-policy.txt")] * 5:
			found = search(question, limit=1)
			self.assertTrue(found, f"{question!r} found nothing")
			self.assertEqual(frappe.db.get_value("File", found[0]["file"], "file_name"), expected, question)
