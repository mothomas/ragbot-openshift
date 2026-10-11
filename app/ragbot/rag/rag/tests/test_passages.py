"""An answer saves where it read a passage; the text comes back under the reader's own permissions."""

import unittest

import frappe

from rag.search import passages
from rag.tests import test_chat as tc
from rag.tests.drive_fixture import drive_file, remove

PROBE = "rag-passages-probe@example.com"


def _probe() -> str:
	if not frappe.db.exists("User", PROBE):
		frappe.get_doc(
			{
				"doctype": "User",
				"email": PROBE,
				"first_name": "Probe",
				"send_welcome_email": 0,
				"roles": [{"role": "Drive User"}],
			}
		).insert(ignore_permissions=True)
	return PROBE


def _text(rows: list[dict]) -> set[str]:
	return {r["content"] for r in rows}


class TestPassages(unittest.TestCase):
	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def test_the_passage_comes_back_for_a_reader_who_may_still_open_the_file(self):
		name = drive_file("policy.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		try:
			rows = passages([{"file": name, "seq": 0}])
			self.assertEqual(_text(rows), {"The Kestrel allowance is 600 AUD."})
			self.assertEqual(rows[0]["seq"], 0)
		finally:
			remove(name)

	def test_a_reader_who_lost_the_file_gets_nothing_back_for_it(self):
		shared, private = (
			drive_file("shared.txt", b"Travel is booked online.", "text/plain"),
			drive_file("private.txt", b"The Zephyr launch code is 4417.", "text/plain"),
		)
		try:
			frappe.get_doc("File", shared).share(user=_probe(), read=1)
			frappe.set_user(PROBE)
			rows = passages([{"file": shared, "seq": 0}, {"file": private, "seq": 0}])
			self.assertEqual(_text(rows), {"Travel is booked online."})
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()
			remove(shared, private)

	def test_a_file_in_a_trashed_folder_stops_handing_its_passage_back(self):
		name = drive_file("policy.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		parent = frappe.db.get_value("File", name, "folder")
		try:
			self.assertTrue(passages([{"file": name, "seq": 0}]))
			frappe.db.set_value("File", parent, "status", "Removed", update_modified=False)
			self.assertEqual(passages([{"file": name, "seq": 0}]), [])
		finally:
			frappe.db.rollback()
			remove(name)

	def test_an_attachment_answers_only_to_whoever_attached_it(self):
		session = tc._a_chat("passages")
		name = tc._attach(session, "attached.txt", tc.FACT)
		try:
			self.assertEqual(_text(passages([{"file": name, "seq": 0}])), {tc.FACT})
			frappe.set_user(_probe())
			self.assertEqual(passages([{"file": name, "seq": 0}]), [])
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()

	def test_a_place_that_holds_no_passage_answers_nothing(self):
		name = drive_file("policy.txt", b"The Kestrel allowance is 600 AUD.", "text/plain")
		try:
			self.assertEqual(passages([{"file": name, "seq": 99}]), [])
			self.assertEqual(passages([{"file": "no-such-file", "seq": 0}]), [])
		finally:
			remove(name)
