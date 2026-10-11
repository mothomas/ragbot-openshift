"""on_doctype_update is the only thing standing between a wrong `embedding` column and a migrate
that reports success while every insert fails. The DDL is held back so these run on a real site."""

import unittest
from unittest.mock import patch

import frappe

from rag.ingest import EMBED_DIM
from rag.kb.doctype.kb_chunk import kb_chunk


def _ddl(fake):
	return [call.args[0] for call in fake.call_args_list]


class TestVectorColumnGuards(unittest.TestCase):
	def test_a_column_of_another_width_stops_the_migrate(self):
		"""MariaDB cannot redeclare a vector's width and ADD COLUMN IF NOT EXISTS skips the column,
		so without this refusal every insert fails with "Incorrect vector value", per file, while
		migrate and health both report success."""
		with (
			patch.object(frappe.db, "sql_ddl"),
			patch("rag.ingest.EMBED_DIM", 384),
			self.assertRaises(frappe.ValidationError) as caught,
		):
			kb_chunk.on_doctype_update()
		self.assertIn(f"vector({EMBED_DIM})", str(caught.exception), "the message must name the width on disk")
		self.assertIn("reindex_all", str(caught.exception), "and what to run after dropping the column")

	def test_a_chunk_with_no_vector_stops_the_not_null_and_the_index(self):
		"""A vector index built now would miss the rows that have no vector yet, and MODIFY NOT NULL
		would refuse outright. On a migrated site the column is already `NOT NULL` with no default, so
		such a row cannot be inserted to make one: the probe that looks for it is answered instead, and
		every other query still goes to the real site, including the width check above it."""
		real_sql = frappe.db.sql

		def one_row_has_no_vector(query, *args, **kwargs):
			# only the guard's own probe; health() counts the same column with SUM(... IS NULL) and no WHERE
			if "WHERE embedding IS NULL" in query:
				return ((1,),)
			return real_sql(query, *args, **kwargs)

		with (
			patch.object(frappe.db, "sql_ddl") as ddl,
			patch.object(frappe.db, "sql", side_effect=one_row_has_no_vector),
		):
			kb_chunk.on_doctype_update()
		self.assertFalse([q for q in _ddl(ddl) if "MODIFY" in q or "VECTOR INDEX" in q], _ddl(ddl))
