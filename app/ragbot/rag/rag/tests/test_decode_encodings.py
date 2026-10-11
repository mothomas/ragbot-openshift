import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

from rag.ingest import extract_text

DATA = Path(__file__).parent / "data"
CYRILLIC = (
	"Ежегодный оплачиваемый отпуск\n\n"
	"Сотруднику предоставляется двадцать дней оплачиваемого отпуска после шести месяцев работы.\n"
)


def _doc(raw, mime="text/plain"):
	return SimpleNamespace(mime_type=mime, manager=SimpleNamespace(get_file=lambda d: BytesIO(raw)))


class TestNonWesternEncodings(unittest.TestCase):
	def test_a_shift_jis_upload_reads_as_japanese(self):
		raw = (DATA / "leave_policy.sjis.txt").read_bytes()
		self.assertEqual(extract_text(_doc(raw)), raw.decode("shift_jis"))

	def test_cp1251_reads_as_russian(self):
		# cp1252 decodes these bytes without raising, so this is the silent half: no replacement
		# character marks the damage, and the mojibake was embedded and reported ready.
		self.assertEqual(extract_text(_doc(CYRILLIC.encode("cp1251"))), CYRILLIC)

	def test_bytes_that_are_not_text_index_nothing(self):
		self.assertEqual(extract_text(_doc(bytes(range(256)) * 4)), "")
