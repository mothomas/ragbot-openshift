"""The status poll never waits on another poll's probe of the agent: it answers with the last result."""

import unittest
from unittest.mock import MagicMock, patch

import frappe
import redis

from rag import status


class TestAgentProbe(unittest.TestCase):
	def setUp(self):
		self._url = frappe.local.conf.get("frappe_ai_agent_url")
		frappe.local.conf["frappe_ai_agent_url"] = "http://test-agent:8484"
		# the same escape make test-site sets: the validator refuses a private peer without it
		self._ok = frappe.local.conf.get("frappe_ai_agent_url_unsafe_ok")
		frappe.local.conf["frappe_ai_agent_url_unsafe_ok"] = 1

	def tearDown(self):
		frappe.cache.delete_value(status.AGENT_STATE)
		frappe.cache.delete_value(status.AGENT_STATE + ":probing")
		frappe.local.conf["frappe_ai_agent_url"] = self._url
		frappe.local.conf["frappe_ai_agent_url_unsafe_ok"] = self._ok

	@patch("rag.status.requests.get")
	def test_a_poll_does_not_wait_on_a_probe_already_running(self, get):
		last = {"rtt_ms": 1.0, "ok": True, "model": "m", "runs": None, "checks": {"agent": True}}
		frappe.cache.set_value(status.AGENT_STATE, last)
		frappe.cache.set(frappe.cache.make_key(status.AGENT_STATE + ":probing"), 1, ex=10)
		self.assertEqual(status.link()["checks"], last["checks"])
		get.assert_not_called()

	@patch("rag.status.requests.get", side_effect=lambda url, **_kw: MagicMock(json=lambda: {"llm_model": "m"}))
	def test_without_redis_the_poll_still_probes(self, get):
		with patch.object(frappe.cache, "set", side_effect=redis.exceptions.ConnectionError):
			self.assertTrue(status.link()["checks"]["agent"])
		self.assertTrue(get.called)
