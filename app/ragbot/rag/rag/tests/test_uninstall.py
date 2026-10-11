from unittest import TestCase

import frappe

import rag

JOBS = {"method": ("like", "rag.%")}
FIELDS = ["method", "frequency", "cron_format", "stopped"]


class TestUninstallScheduledJobs(TestCase):
	"""Uninstalling rag leaves no Scheduled Job Type row naming a rag method."""

	def restore(self, rows):
		for row in rows:
			frappe.get_doc({"doctype": "Scheduled Job Type", **row}).insert()

	def test_it_removes_every_row_naming_a_rag_method(self):
		rows = frappe.get_all("Scheduled Job Type", filters=JOBS, fields=FIELDS)
		self.assertTrue(rows, "installing rag left at least one scheduled job behind to clean up")
		self.addCleanup(self.restore, rows)
		rag.after_uninstall()
		self.assertEqual(frappe.get_all("Scheduled Job Type", filters=JOBS), [])
