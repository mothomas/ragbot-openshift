from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import status


class TestWherePerSite(TestCase):
	"""One worker serves several sites; each gets the route to its own agent, not the first site's."""

	def _where_for(self, site, agent_url):
		conf = {"frappe_ai_agent_url": agent_url}
		with patch.object(frappe.local, "site", site), patch.dict(frappe.local.conf, conf):
			return status._where()["ip"]

	def test_each_site_keeps_its_own_route(self):
		loopback = self._where_for("c20-a.localhost", "http://127.0.0.1:8484")
		outside = self._where_for("c20-b.localhost", "http://192.0.2.1:8484")
		self.assertEqual(loopback, "127.0.0.1")
		self.assertNotEqual(outside, loopback)
