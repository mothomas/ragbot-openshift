import unittest
from io import BytesIO
from types import SimpleNamespace

import pymupdf

from rag.ingest import extract_text


def _pdf(draw) -> SimpleNamespace:
	pdf = pymupdf.open()
	draw(pdf.new_page())
	raw = pdf.tobytes()
	pdf.close()
	return SimpleNamespace(mime_type="application/pdf", manager=SimpleNamespace(get_file=lambda d: BytesIO(raw)))


class TestPdfReading(unittest.TestCase):
	"""A PDF is read the way a person reads it: column by column, with its ligatures as plain letters."""

	def test_two_columns_are_read_one_after_the_other(self):
		words = "the allowance is paid monthly to every member of staff who travels for work " * 2

		def draw(page):
			page.insert_textbox(pymupdf.Rect(50, 40, 550, 70), "Title across the page")
			for n, y in enumerate((100, 250, 400), 1):  # wrapped paragraphs, as a typeset column has
				page.insert_textbox(pymupdf.Rect(50, y, 280, y + 130), f"Left paragraph {n}. {words}", fontsize=10)
				page.insert_textbox(pymupdf.Rect(320, y, 550, y + 130), f"Right paragraph {n}. {words}", fontsize=10)

		text = extract_text(_pdf(draw))
		order = [
			text.index(s)
			for s in (
				"Title",
				"Left paragraph 1",
				"Left paragraph 2",
				"Left paragraph 3",
				"Right paragraph 1",
				"Right paragraph 2",
				"Right paragraph 3",
			)
		]
		self.assertEqual(order, sorted(order))

	def test_ligatures_are_read_as_their_letters(self):
		def draw(page):
			page.insert_font(fontname="F0", fontbuffer=pymupdf.Font("helv").buffer)
			page.insert_text((72, 72), "The oﬃce staﬀ get eﬀective beneﬁts.", fontname="F0")

		text = extract_text(_pdf(draw))
		self.assertIn("The office staff get effective benefits.", text)
		self.assertFalse(any("ﬀ" <= ch <= "ﬆ" for ch in text))
