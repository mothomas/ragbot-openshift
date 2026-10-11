from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import status


class TestStatusWithoutFrappeAi(TestCase):
	"""rag runs without frappe_ai: the status panel then shows its other checks and leaves out only the
	answer speeds, which come from frappe_ai's chats. No 500, and no Error Log row."""

	def test_the_summary_leaves_out_only_the_speeds(self):
		apps = [a for a in frappe.get_installed_apps() if a != "frappe_ai"]
		with patch.object(frappe, "get_installed_apps", return_value=apps):
			out = status.summary()
		self.assertIsNone(out["speeds"])
		self.assertEqual(set(out), {"platform", "index", "runtime", "model", "speeds"})
		self.assertEqual(out["index"], status._index())
		self.assertEqual(out["platform"], status.platform())
		self.assertTrue(out["runtime"]["ip"], "the panel still says where this runs")
