"""/ask's own backstop: the browser refuses an image from anywhere but this site, whatever renders it."""

import unittest

import frappe

from rag.www import ask


class TestAskImagePolicy(unittest.TestCase):
	def test_only_this_sites_images_load(self):
		ask.get_context(frappe._dict())
		csp = frappe.local.response_headers.get("Content-Security-Policy") or ""
		self.assertIn("img-src 'self' data: blob:", csp)
		self.assertNotIn("img-src *", csp)
