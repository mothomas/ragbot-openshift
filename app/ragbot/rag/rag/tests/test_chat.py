import unittest
from unittest.mock import patch
from uuid import uuid7

import frappe
from frappe.database import get_db

from rag.chat import attachments, delete_chat, detach
from rag.ingest import EMBED_DIM, EMBED_MODEL, index_file
from rag.search import search


def _a_chat(title: str) -> str:
	# the frontend names a chat itself, before its first question
	session = frappe.get_doc(
		{"doctype": "AI Chat Session", "name": frappe.generate_hash(), "title": title}
	).insert()
	for role in ("user", "assistant"):
		message = {"doctype": "AI Chat Message", "session": session.name, "role": role, "content": "x"}
		frappe.get_doc(message).insert()
	return session.name


class TestDeleteChat(unittest.TestCase):
	PROBE = "rag-chat-probe@example.com"

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def test_a_chat_goes_with_its_messages(self):
		"""A session can't be deleted while messages link to it, so they go first."""
		name = _a_chat("to delete")
		delete_chat(name)
		self.assertFalse(frappe.db.exists("AI Chat Session", name))
		self.assertFalse(frappe.db.count("AI Chat Message", {"session": name}))

	def test_nobody_deletes_another_users_chat(self):
		name = _a_chat("not yours")
		frappe.get_doc(
			{"doctype": "User", "email": self.PROBE, "first_name": "Probe", "send_welcome_email": 0}
		).insert(ignore_permissions=True)
		frappe.set_user(self.PROBE)
		with self.assertRaises(frappe.PermissionError):
			delete_chat(name)
		frappe.set_user("Administrator")
		self.assertTrue(frappe.db.exists("AI Chat Session", name))
		self.assertEqual(frappe.db.count("AI Chat Message", {"session": name}), 2)


def _attach(session: str, name: str, text: str) -> str:
	"""What the composer's upload does: a private file on the chat, which may not exist yet."""
	doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": name,
			"content": text,
			"is_private": 1,
			"attached_to_doctype": "AI Chat Session",
			"attached_to_name": session,
		}
	).insert()
	index_file(doc.name)  # the job the upload queues, run here
	return doc.name


FACT = "The Zephyr project's launch code is PELICAN-7, and only the launch lead may read it aloud."


class TestAttachments(unittest.TestCase):
	PROBE = "rag-attach-probe@example.com"

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.rollback()

	def test_an_attachment_answers_only_in_its_own_chat(self):
		session = _a_chat("with a file")
		name = _attach(session, "zephyr.txt", FACT)
		stored = frappe.db.get_value("File", name, "file_name")  # Frappe renames a name already on disk
		expected = {"name": name, "file_name": stored, "file_size": len(FACT), "state": "ready"}
		self.assertEqual(attachments(session), [expected])
		found = search("What is the Zephyr launch code?", session=session)
		self.assertEqual(found[0]["file"], name, "the chat's own file is the best match")
		self.assertEqual(found[0]["file_name"], stored)
		self.assertTrue(found[0]["attachment"])
		everyone = [r["file"] for r in search("What is the Zephyr launch code?")]
		self.assertNotIn(name, everyone, "never in the knowledge base")
		other = _a_chat("another chat")
		self.assertNotIn(name, [r["file"] for r in search("What is the Zephyr launch code?", session=other)])

	def test_a_file_can_wait_for_its_chat(self):
		"""The agent creates the chat on the first question, after the files went up."""
		session = frappe.generate_hash()
		name = _attach(session, "zephyr.txt", FACT)
		self.assertEqual([a["state"] for a in attachments(session)], ["ready"])
		frappe.get_doc({"doctype": "AI Chat Session", "name": session, "title": "later"}).insert()
		self.assertEqual(search("What is the Zephyr launch code?", session=session)[0]["file"], name)

	def test_unreadable_files_say_so(self):
		session = _a_chat("binary")
		_attach(session, "photo.png", "not text")
		self.assertEqual([a["state"] for a in attachments(session)], ["failed"])

	def test_nobody_reads_another_users_chat_files(self):
		session = _a_chat("private")
		name = _attach(session, "zephyr.txt", FACT)
		frappe.get_doc(
			{"doctype": "User", "email": self.PROBE, "first_name": "Probe", "send_welcome_email": 0}
		).insert(ignore_permissions=True)
		frappe.set_user(self.PROBE)
		with self.assertRaises(frappe.PermissionError):
			search("What is the Zephyr launch code?", session=session)
		with self.assertRaises(frappe.PermissionError):
			attachments(session)
		with self.assertRaises(frappe.PermissionError):
			detach(name)

	def test_removing_a_file_or_its_chat_takes_its_chunks(self):
		session = _a_chat("cleanup")
		kept = _attach(session, "a.txt", FACT)
		dropped = _attach(session, "b.txt", FACT)
		detach(dropped)
		self.assertFalse(frappe.db.exists("File", dropped))
		self.assertFalse(frappe.db.count("KB Chunk", {"file": dropped}))
		delete_chat(session)
		self.assertFalse(frappe.db.exists("File", kept))
		self.assertFalse(frappe.db.count("KB Chunk", {"file": kept}))


def _worker():
	"""A second session on the site's database, as the queue worker is to a web request."""
	conf = frappe.local.conf
	return get_db(
		socket=conf.db_socket,
		host=conf.db_host,
		port=conf.db_port,
		user=conf.db_user,
		password=conf.db_password,
		cur_db_name=conf.db_name,
	)


class TestIndexingRaces(unittest.TestCase):
	"""A chat deleted while its file is being indexed. The worker's side runs on its own
	connection, so the setup is committed and removed by name afterwards."""

	def setUp(self):
		self.session = _a_chat("race")
		self.file = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": "race.txt",
				"content": FACT,
				"is_private": 1,
				"attached_to_doctype": "AI Chat Session",
				"attached_to_name": self.session,
			}
		).insert()
		frappe.db.commit()
		self.worker = _worker()

	def tearDown(self):
		self.worker.close()
		frappe.set_user("Administrator")
		frappe.db.rollback()
		frappe.db.delete("KB Chunk", {"file": self.file.name})
		frappe.db.delete("File", {"name": self.file.name})
		frappe.db.delete("AI Chat Message", {"session": self.session})
		frappe.db.delete("AI Chat Session", {"name": self.session})
		frappe.db.commit()

	def test_a_file_deleted_while_it_embeds_gets_no_chunks(self):
		"""Embedding takes seconds; a delete committed meanwhile must stop the job writing chunks."""

		def embed_while_the_chat_goes(texts, prefix="search_document"):
			self.worker.sql("DELETE FROM `tabFile` WHERE name=%s", self.file.name)
			self.worker.commit()
			return [[0.1] * EMBED_DIM for _ in texts]

		with patch("rag.ingest.embed", side_effect=embed_while_the_chat_goes):
			index_file(self.file.name)
		self.assertEqual(frappe.db.count("KB Chunk", {"file": self.file.name}), 0)

	def test_a_chat_goes_even_when_its_chunks_landed_after_the_request_began(self):
		"""The job commits chunks after this request's snapshot; MariaDB's snapshot isolation then
		refuses to delete them (1020), which must not fail the delete."""
		frappe.db.sql("SELECT name FROM `tabFile` WHERE name=%s", self.file.name)  # the request's snapshot
		self.worker.sql(
			"INSERT INTO `tabKB Chunk` (name, creation, modified, owner, modified_by, file, seq, content, model,"
			" embedding) VALUES (%s, NOW(6), NOW(6), 'Administrator', 'Administrator', %s, 0, %s, %s,"
			" VEC_FromText(%s))",
			(str(uuid7()), self.file.name, FACT, EMBED_MODEL, str([0.1] * EMBED_DIM)),
		)
		self.worker.commit()
		delete_chat(self.session)
		self.assertFalse(frappe.db.exists("File", self.file.name))
		self.assertFalse(frappe.db.count("KB Chunk", {"file": self.file.name}))
