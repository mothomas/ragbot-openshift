"""/ask sends a Content-Security-Policy, so no injected script source, plugin, base or frame loads."""

import unittest

import frappe

from rag.www import ask


class TestAskHeaders(unittest.TestCase):
	def test_the_page_sends_a_content_security_policy(self):
		ask.get_context(frappe._dict())
		csp = frappe.local.response_headers.get("Content-Security-Policy") or ""
		for directive in ("default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'self'"):
			self.assertIn(directive, csp)
		self.assertIn("frame-ancestors 'self'", csp)
