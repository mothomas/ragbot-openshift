"""The status probe sends the caller's session to the agent, which refuses /config without one."""

import unittest
from unittest.mock import MagicMock, patch

import frappe

from rag import status


class TestAgentConfigCarriesTheSid(unittest.TestCase):
	def setUp(self):
		self._url = frappe.local.conf.get("frappe_ai_agent_url")
		frappe.local.conf["frappe_ai_agent_url"] = "http://test-agent:8484"
		# the same escape make test-site sets: the validator refuses a private peer without it
		self._ok = frappe.local.conf.get("frappe_ai_agent_url_unsafe_ok")
		frappe.local.conf["frappe_ai_agent_url_unsafe_ok"] = 1

	def tearDown(self):
		frappe.cache.delete_value(status.AGENT_STATE)
		frappe.local.conf["frappe_ai_agent_url"] = self._url
		frappe.local.conf["frappe_ai_agent_url_unsafe_ok"] = self._ok

	@patch("rag.status.requests.get", return_value=MagicMock(json=lambda: {"llm_model": "m"}))
	def test_the_probe_sends_the_session_cookie(self, get):
		status._agent_config("http://test-agent:8484")

		self.assertEqual(get.call_args.kwargs.get("cookies"), {"sid": frappe.session.sid})
