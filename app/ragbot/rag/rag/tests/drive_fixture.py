"""Drive files a test owns: made the way Drive's upload makes them, then indexed with a known vector."""

from unittest.mock import patch

import frappe
from drive.api.files import get_upload_path
from drive.api.product import create_team
from drive.utils import create_drive_file, get_default_team, get_file_type, get_home_folder
from drive.utils.files import FileManager

from rag import ingest


def vector(axis: int) -> list[float]:
	return [1.0 if i == axis else 0.0 for i in range(ingest.EMBED_DIM)]


def vectors(axis: int = 0):
	"""A stand-in for `embed`: one fixed vector per text, so a test never calls the live model."""
	return lambda texts, *a, **k: [vector(axis) for _ in texts]


def pdf(text: str) -> bytes:
	import pymupdf

	doc = pymupdf.open()
	doc.new_page().insert_text((72, 72), text)
	try:
		return doc.tobytes()
	finally:
		doc.close()


def admin_team() -> str:
	"""Administrator's personal team: Drive's new-user hook makes one for every user but Administrator."""
	return get_default_team() or create_team("Administrator", "Administrator", personal=1)


def drive_file(file_name: str, data: bytes, mime: str, axis: int = 0) -> str:
	team = admin_team()
	home, manager = get_home_folder(team), FileManager()

	def path(d):  # as Drive's upload_file builds it
		return "/" + str(manager.get_disk_path(d, home))

	with patch.object(ingest, "_enqueue"):  # indexed below, with a known vector, not by the worker
		doc = create_drive_file(team, file_name, home["name"], get_file_type(mime), path, mime, len(data))
	upload = get_upload_path(f"{doc.name}_{file_name}")
	upload.write_bytes(data)
	manager.upload_file(upload, doc, create_thumbnail=False)
	with patch.object(ingest, "embed", side_effect=vectors(axis)):
		ingest.index_file(doc.name)
	frappe.db.commit()
	return doc.name


def drive_user(email: str, drive_role: bool = True) -> str:
	"""A second signed-in user, with nothing shared with them."""
	if not frappe.db.exists("User", email):
		frappe.get_doc({"doctype": "User", "email": email, "first_name": "Probe", "send_welcome_email": 0}).insert(
			ignore_permissions=True
		)
	# drive's after_insert hook gives every new user the Drive User role, which is also KB Chunk's
	# report role, so one without it has to have it taken away again
	if not drive_role:
		frappe.get_doc("User", email).remove_roles("Drive User")
	return email


def remove(*names: str) -> None:
	for name in names:
		frappe.delete_doc("File", name, force=True, ignore_permissions=True)
	frappe.db.commit()
