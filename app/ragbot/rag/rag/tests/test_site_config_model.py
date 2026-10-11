"""The Ollama address and the embedding model belong to the site, not to the worker's environment."""

import unittest
from unittest.mock import patch

import frappe
import requests

from rag import ingest

ELSEWHERE = {"rag_ollama_url": "http://elsewhere:11434", "rag_embed_model": "other-model"}


class TestSiteConfigModel(unittest.TestCase):
	def test_the_embedding_request_goes_where_this_site_says(self):
		sent = {}

		def post(url, json, timeout):
			sent.update(url=url, model=json["model"])
			raise requests.ConnectionError("recorded, never sent")

		with patch.dict(frappe.local.conf, ELSEWHERE), patch.object(ingest.requests, "post", post):
			self.assertRaises(requests.ConnectionError, ingest.embed, ["a question"], "search_query")
		self.assertEqual(sent, {"url": "http://elsewhere:11434/api/embed", "model": "other-model"})

	def test_health_measures_the_chunks_against_the_model_this_site_names(self):
		chunks = frappe.db.count("KB Chunk")
		if not chunks:
			self.skipTest("no chunks on this site")
		with patch.dict(frappe.local.conf, ELSEWHERE):
			self.assertEqual(ingest.health()["other_model"], chunks)

	def test_a_site_that_names_neither_keeps_the_address_and_model_it_has_today(self):
		for key in ELSEWHERE:
			self.assertIsNone(frappe.conf.get(key), f"this site must not name {key} for this check")
		self.assertEqual(ingest.ollama_url(), "http://host.docker.internal:11434")
		self.assertEqual(ingest.embed_model(), "nomic-embed-text")
