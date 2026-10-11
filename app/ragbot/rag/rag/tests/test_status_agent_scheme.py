from unittest import TestCase
from unittest.mock import patch

import frappe

from rag import status


class TestAgentUrlScheme(TestCase):
	"""The status panel hands the reader's sid to the configured agent, so it checks the address first."""

	def probe(self, url, unsafe_ok):
		conf = {**frappe.local.conf, "frappe_ai_agent_url_unsafe_ok": unsafe_ok}
		with (
			patch.object(frappe.local, "conf", frappe._dict(conf)),
			patch.object(status.requests, "get") as sent,
		):
			return status._agent_config(url), sent

	def test_it_refuses_plain_http_to_a_public_address(self):
		# an address literal, so the check reaches the scheme rule without a DNS lookup in CI
		(config, rtt), sent = self.probe("http://93.184.216.34:8484", None)
		self.assertEqual((config, rtt), (None, None))
		sent.assert_not_called()

	def test_it_refuses_a_cloud_metadata_address(self):
		(config, rtt), sent = self.probe("http://169.254.169.254", 1)
		self.assertEqual((config, rtt), (None, None))
		sent.assert_not_called()

	def test_it_still_probes_the_private_agent_local_development_configures(self):
		url = (frappe.conf.get("frappe_ai_agent_url") or "").rstrip("/")
		self.assertTrue(url, "this site names an agent")
		(_config, _rtt), sent = self.probe(url, 1)
		sent.assert_called_once()
