"""The greeting is drawn into the page itself, so the name in it is markup unless something escapes it."""

import unittest
from unittest.mock import patch

import frappe

from rag.www import ask

MARKUP = '<img src=x onerror=alert(1)>Ada"&'


class TestAskGreeting(unittest.TestCase):
	def test_a_name_with_markup_reaches_the_page_escaped(self):
		with patch.object(frappe.utils, "get_fullname", return_value=MARKUP + " Lovelace"):
			context = frappe._dict()
			ask.get_context(context)
		# frappe's jinja environment sets no autoescape, so this is the only thing standing between a
		# name and the page it is written into
		self.assertNotIn("<img", context.first_name)
		self.assertNotIn('"', context.first_name)
		self.assertIn("&lt;img", context.first_name)
		# the same name goes into the boot script, where `<` cannot be allowed to close the tag
		self.assertNotIn("<img", context.boot_json)
