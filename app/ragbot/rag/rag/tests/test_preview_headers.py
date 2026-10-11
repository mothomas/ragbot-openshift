import unittest
from unittest.mock import patch

from werkzeug.wrappers import Response

from rag import preview


def _render(mimetype):
	headers = {"Content-Disposition": "inline; filename=f", "Cache-Control": "public, max-age=3600"}
	drive = Response(b"x", mimetype=mimetype, headers=headers)
	with patch.object(preview, "get_file_content", return_value=drive):
		return preview.FilePage("ask/files").render()


class TestPreviewHeaders(unittest.TestCase):
	"""A file a user may read can still be hostile: nothing may run as a page on this site's origin."""

	def test_active_content_downloads_in_a_sandbox(self):
		active = ("text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript")
		for mimetype in active:
			response = _render(mimetype)
			self.assertTrue(response.headers["Content-Disposition"].startswith("attachment"), mimetype)
			self.assertEqual(response.headers["Content-Security-Policy"], "sandbox", mimetype)

	def test_what_metis_previews_stays_inline(self):
		for mimetype in ("application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"):
			self.assertTrue(_render(mimetype).headers["Content-Disposition"].startswith("inline"), mimetype)

	def test_no_preview_is_kept_by_a_shared_cache(self):
		for mimetype in ("application/pdf", "text/html"):
			cache = _render(mimetype).cache_control
			self.assertTrue(cache.private and not cache.public, mimetype)
