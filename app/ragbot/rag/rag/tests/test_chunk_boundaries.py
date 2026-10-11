import unittest

from rag.ingest import CHUNK_CHARS, chunk


class TestChunkBoundaries(unittest.TestCase):
	"""A passage ends where the text does: at a blank line, then a line end, then a word."""

	def test_a_blank_line_holding_spaces_still_separates_paragraphs(self):
		first, second = "First. " + "a" * (CHUNK_CHARS - 20), "Second. " + "b" * 40
		self.assertEqual(chunk(f"{first}\n \t\n{second}"), [first, second])

	def test_a_file_without_blank_lines_breaks_at_the_end_of_a_row(self):
		rows = [f"row{i:04d}," + "x" * 57 for i in range(100)]  # a CSV: no blank line, no space
		chunks = chunk("\n".join(rows))
		self.assertGreater(len(chunks), 1)
		self.assertTrue(all(line in rows for c in chunks for line in c.split("\n")))
