"""The /ask status panel is one site_config key, and turning it off takes its endpoints with it."""

import unittest
from unittest.mock import patch

import frappe

from rag import status
from rag.www import ask

KEY = "rag_status_panel"


class TestStatusPanelSwitch(unittest.TestCase):
	def setUp(self):
		self._had = KEY in frappe.local.conf
		self._was = frappe.local.conf.get(KEY)

	def tearDown(self):
		frappe.local.conf.pop(KEY, None)
		if self._had:
			frappe.local.conf[KEY] = self._was

	def test_a_site_that_says_nothing_gets_the_panel(self):
		frappe.local.conf.pop(KEY, None)
		self.assertTrue(status.panel_on())
		context = frappe._dict()
		ask.get_context(context)
		self.assertIn('"status_panel": true', context.boot_json)

	def test_off_refuses_the_summary_and_tells_the_page(self):
		# bench set-config writes the string, site_config.json written by hand holds the number
		frappe.local.conf[KEY] = "0"
		self.assertFalse(status.panel_on())
		frappe.local.conf[KEY] = 0
		self.assertFalse(status.panel_on())
		with self.assertRaises(frappe.PermissionError):
			status.summary()
		context = frappe._dict()
		ask.get_context(context)
		self.assertIn('"status_panel": false', context.boot_json)

	def test_off_stops_the_cloud_metadata_probes(self):
		"""location() asks four clouds' metadata services; only the panel reads what it answers."""
		frappe.local.conf[KEY] = 0
		with patch.object(status, "location", side_effect=AssertionError("probed with the panel off")):
			self.assertEqual(status.link()["location"], "")
