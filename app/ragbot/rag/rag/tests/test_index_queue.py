from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from rag import ingest

BENCH = {"short": 300, "default": 300, "long": 1500}  # the three queues every bench has


def _bench(declares_index: bool):
	"""The mapping frappe.enqueue validates a queue against, with and without the workers entry."""
	declared = BENCH | ({"index": 1500} if declares_index else {})
	return patch.object(ingest, "get_queues_timeout", return_value=declared)


def _queues(call, declares_index=True) -> set[str]:
	with _bench(declares_index), patch.object(ingest.frappe, "enqueue") as enqueue:
		call()
	return {c.kwargs["queue"] for c in enqueue.call_args_list}


class TestIndexQueue(TestCase):
	"""Indexing runs on the bench's own index queue, so it never shares a worker with the chat relay.

	frappe_ai enqueues every chat turn's _stream_to_agent on long, and one worker serves a queue in
	order: an index job on long holds the answer until it finishes.
	"""

	def test_a_bench_that_declares_the_queue_indexes_on_it(self):
		with _bench(True):
			self.assertEqual(ingest.index_queue(), "index")

	def test_a_bench_without_the_workers_entry_keeps_the_old_queue(self):
		"""enqueue throws on a queue the bench has not declared, which would fail the upload itself."""
		with _bench(False):
			self.assertEqual(ingest.index_queue(), "long")

	def test_an_upload_does_not_queue_behind_the_chat_relay(self):
		doc = SimpleNamespace(name="file1")
		self.assertEqual(_queues(lambda: ingest._enqueue(doc)), {"index"})
		self.assertEqual(_queues(lambda: ingest._enqueue(doc), declares_index=False), {"long"})

	def test_the_hourly_retry_and_a_full_reindex_go_there_too(self):
		"""Both enqueue as well, and either can queue every file on the site at once."""
		with (
			patch.object(ingest, "_to_index", return_value=["file1"]),
			patch.object(ingest, "index_state", return_value="error"),
		):
			self.assertEqual(_queues(ingest.retry_failed), {"index"})
			self.assertEqual(_queues(ingest.reindex_all), {"index"})
