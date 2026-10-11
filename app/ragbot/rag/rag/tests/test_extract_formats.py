import unittest
from io import BytesIO
from types import SimpleNamespace

from rag.ingest import extract_text


def _doc(raw, mime):
	return SimpleNamespace(mime_type=mime, manager=SimpleNamespace(get_file=lambda d: BytesIO(raw)))


class TestExtractFormats(unittest.TestCase):
	"""Plain-text formats Drive labels application/* are read, and a web page is read as its text."""

	def test_text_formats_drive_labels_application_are_read(self):
		for mime, raw in (
			("application/json", b'{"leave": "20 days"}'),
			("application/yaml", b"leave: 20 days\n"),
			("application/sql", b"SELECT leave FROM policy;\n"),
			("application/toml", b'[policy]\nleave = "20 days"\n'),
		):
			self.assertEqual(extract_text(_doc(raw, mime)), raw.decode(), mime)

	def test_a_web_page_is_read_as_its_text(self):
		html = (
			b"<html><head><style>p{color:red}</style></head>"
			b"<body><p>Leave is 20 days.</p><script>track()</script></body></html>"
		)
		for mime in ("text/html", "application/xhtml+xml"):
			text = extract_text(_doc(html, mime))
			self.assertIn("Leave is 20 days.", text, mime)
			self.assertNotIn("<p>", text, mime)
			self.assertNotIn("track()", text, mime)
			self.assertNotIn("color:red", text, mime)
