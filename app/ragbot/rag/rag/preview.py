import frappe
from drive.api.files import get_file_content
from frappe.website.page_renderers.base_renderer import BaseRenderer
from werkzeug.wrappers import Response

ENDPOINT = "ask/files"
# the types Metis's preview shows; anything else could run as a page on this origin
INLINE = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"}


class FilePage(BaseRenderer):
	"""Drive's file response and read check at /ask/files/<name>/<filename>, which a PDF viewer titles from."""

	def can_render(self):
		return self.path == ENDPOINT

	def render(self):
		response = get_file_content(entity_name=frappe.form_dict.name)
		if not isinstance(response, Response):  # a Drive document redirects to its editor
			raise frappe.DoesNotExistError
		if response.mimetype not in INLINE:
			disposition = response.headers.get("Content-Disposition", "inline")
			response.headers["Content-Disposition"] = disposition.replace("inline", "attachment", 1)
			response.headers["Content-Security-Policy"] = "sandbox"
		response.cache_control.public = False
		response.cache_control.private = True
		return response
