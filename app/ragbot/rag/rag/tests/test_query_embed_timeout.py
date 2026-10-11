from unittest import TestCase
from unittest.mock import MagicMock, patch

from rag import search
from rag.ingest import EMBED_DIM


class TestQueryEmbedTimeout(TestCase):
	"""A question waits seconds for Ollama, not the ten minutes an index batch may: a web thread is held."""

	def test_a_search_gives_up_before_its_caller_does(self):
		reply = MagicMock(json=lambda: {"embeddings": [[0.1] * EMBED_DIM]})
		with patch("rag.ingest.requests.post", return_value=reply) as post:
			search.search("what is the kestrel allowance")
		connect, read = post.call_args.kwargs["timeout"]
		self.assertLess(connect + read, 30)  # the MCP client gives up at 30 s
