import json
import socket
import unittest
from contextlib import contextmanager
from unittest.mock import patch

import frappe
import requests
from frappe.sessions import get_expired_threshold

from rag import status
from rag.ingest import health
from rag.library import documents
from rag.status import link, provider_of, summary
from rag.tests import drive_fixture


def _node(labels=(), provider_id=""):
	return {"metadata": {"labels": dict.fromkeys(labels, "x")}, "spec": {"providerID": provider_id}}


class TestProvider(unittest.TestCase):
	def test_labels_and_provider_ids_map_to_providers(self):
		self.assertEqual(provider_of(_node(["eks.amazonaws.com/nodegroup"])), "eks")
		self.assertEqual(provider_of(_node(provider_id="aws:///us-east-1a/i-1")), "eks")
		self.assertEqual(provider_of(_node(["node.openshift.io/os_id"], "aws:///us-east-1a/i-1")), "rosa")
		self.assertEqual(provider_of(_node(["node.openshift.io/os_id"])), "openshift")
		self.assertEqual(provider_of(_node(provider_id="digitalocean://123")), "digitalocean")

	def test_an_unknown_cluster_claims_nothing(self):
		"""The senior's chatbot defaulted an unknown cluster to on-prem OpenShift."""
		self.assertIsNone(provider_of(_node(["kubernetes.io/hostname"])))
		self.assertIsNone(provider_of({}))


class TestLocation(unittest.TestCase):
	def setUp(self):
		status.location.cache_clear()

	def tearDown(self):
		status.location.cache_clear()

	def test_nothing_answering_is_on_premises(self):
		with patch.object(status.requests, "request", side_effect=requests.ConnectionError):
			self.assertEqual(status.location(), "onprem")

	def test_the_cloud_whose_metadata_service_answers(self):
		def only(cloud):
			def answer(method, url, **_kw):
				r = requests.Response()
				r.status_code = 200 if url.startswith(status.METADATA[cloud][1]) else 404
				r.headers["Metadata-Flavor"] = "Google"
				return r

			return answer

		for cloud in status.METADATA:
			status.location.cache_clear()
			with patch.object(status.requests, "request", side_effect=only(cloud)):
				self.assertEqual(status.location(), cloud)

	def test_a_metadata_service_we_do_not_know_is_some_cloud(self):
		"""Oracle, Alibaba or OpenStack answer at 169.254.169.254 in their own way; that is not
		on-premises evidence."""
		r = requests.Response()
		r.status_code = 404
		with patch.object(status.requests, "request", return_value=r):
			self.assertEqual(status.location(), "cloud")

	def test_a_kubernetes_node_label_wins_over_metadata(self):
		with (
			patch.object(status, "_in_kubernetes", return_value=True),
			patch.object(status, "_node", return_value=_node(["eks.amazonaws.com/nodegroup"])),
			patch.object(status.requests, "request", side_effect=AssertionError("no metadata probe")),
		):
			self.assertEqual(status.location(), "eks")


def _answers(*bodies):
	"""requests.get stand-ins that answer with each JSON body in turn."""
	out = []
	for body in bodies:
		r = requests.Response()
		r.status_code = 200
		r._content = json.dumps(body).encode()
		out.append(r)
	return out


class TestRuntime(unittest.TestCase):
	def setUp(self):
		status._where.clear_cache()

	def tearDown(self):
		status._where.clear_cache()

	def test_each_cloud_names_its_region_and_zone(self):
		answers = {
			"http://169.254.169.254/latest/api/token": "tok",
			"http://169.254.169.254/latest/meta-data/placement/region": "us-east-1",
			"http://169.254.169.254/latest/meta-data/placement/availability-zone": "us-east-1a",
			"http://metadata.google.internal/computeMetadata/v1/instance/zone": (
				"projects/12/zones/australia-southeast1-b"
			),
			"http://169.254.169.254/metadata/instance/compute/location": "australiaeast",
			"http://169.254.169.254/metadata/instance/compute/zone": "2",
			"http://169.254.169.254/metadata/v1/region": "syd1",
		}

		def answer(method, url, **_kw):
			r = requests.Response()
			r.status_code, r._content = (200, answers[url].encode()) if url in answers else (404, b"")
			return r

		expected = {
			"ec2": ("us-east-1", "us-east-1a"),
			"gcp": ("australia-southeast1", "australia-southeast1-b"),
			"azure": ("australiaeast", "2"),
			"digitalocean": ("syd1", None),
			"onprem": (None, None),
		}
		with patch.object(status.requests, "request", side_effect=answer):
			for cloud, (region, zone) in expected.items():
				self.assertEqual(status._placement(cloud), {"region": region, "zone": zone}, cloud)

	def test_a_pod_names_its_node_only_when_told_it(self):
		"""Without NODE_NAME the API hands back some node in the cluster, maybe not this pod's."""
		node = _node(["eks.amazonaws.com/nodegroup"])
		node["metadata"]["labels"].update(
			{"topology.kubernetes.io/region": "ap-southeast-2", "topology.kubernetes.io/zone": "ap-southeast-2a"}
		)
		with (
			patch.object(status, "_in_kubernetes", return_value=True),
			patch.object(status, "_node", return_value=node),
			patch.object(status, "_namespace", return_value="metis"),
			patch.dict(status.os.environ, {"NODE_NAME": "ip-10-0-1-23"}),
		):
			where = status._where()
		self.assertEqual(
			{k: where[k] for k in ("region", "zone", "node", "namespace")},
			{"region": "ap-southeast-2", "zone": "ap-southeast-2a", "node": "ip-10-0-1-23", "namespace": "metis"},
		)
		status._where.clear_cache()
		with (
			patch.object(status, "_in_kubernetes", return_value=True),
			patch.object(status, "_node", return_value=node),
			patch.object(status, "_namespace", return_value="metis"),
			patch.dict(status.os.environ, {}, clear=False),
		):
			status.os.environ.pop("NODE_NAME", None)
			where = status._where()
		self.assertEqual((where["region"], where["zone"], where["node"]), (None, None, None))

	def test_this_container_is_described(self):
		out = summary()["runtime"]
		self.assertEqual(out["host"], socket.gethostname())
		self.assertEqual(len(out["ip"].split(".")), 4, "the address this server reaches the agent from")
		self.assertGreater(out["uptime_s"], 0)


@contextmanager
def _signed_in():
	"""Lend a live probe a session the agent will accept."""
	# a bench run has none: frappe.set_user leaves session.sid as the user's own name, and the agent asks
	# Frappe whose session a sid is before it answers (ADR-031). The cutoff is the one frappe's own
	# session read applies in get_session_data_from_db.
	sid = frappe.db.get_value(
		"Sessions",
		{"user": frappe.session.user, "lastupdate": (">", get_expired_threshold())},
		"sid",
		order_by="lastupdate desc",
	)
	if not sid:
		raise unittest.SkipTest(f"no open session of {frappe.session.user}'s to borrow: sign in to this site")
	was = frappe.local.session.sid
	try:
		frappe.local.session.sid = sid
		# both probes are kept for a minute, and whoever ran before this one used the bench's sid
		status._model_link.clear_cache()
		frappe.cache.delete_value(status.AGENT_STATE)
		yield
	finally:
		frappe.local.session.sid = was
		status._model_link.clear_cache()
		frappe.cache.delete_value(status.AGENT_STATE)


class TestLink(unittest.TestCase):
	def test_the_agent_answers_with_a_round_trip(self):
		with _signed_in():
			out = link()
		self.assertEqual(set(out), {"location", "rtt_ms", "ok", "model", "runs", "checks"})
		self.assertTrue(out["ok"], "the demo agent, MCP server and model are up")
		self.assertEqual(out["checks"], {"agent": True, "tools": True, "model": True})
		self.assertGreater(out["rtt_ms"], 0)
		self.assertTrue(out["model"], "the agent names its model")
		self.assertEqual(out["runs"]["provider"], "ollama")
		self.assertGreater(out["runs"]["context"], 0, "the agent reports the window it asks Ollama for")

	def test_offline_has_no_round_trip(self):
		with patch.object(status.requests, "get", side_effect=requests.ConnectionError):
			out = link()
		del out["location"]
		# the agent reports on the tools server and the model, so with it down they are unknown
		checks = {"agent": False, "tools": None, "model": None}
		self.assertEqual(out, {"rtt_ms": None, "ok": False, "model": None, "runs": None, "checks": checks})

	def test_a_hosted_model_is_not_checked(self):
		"""The agent skips the model probe for hosted providers and still says ok."""
		health = {"mcp": {"ok": True}, "llm": {"ok": True, "skipped": True}, "healthy": True}
		with patch.object(status.requests, "get", side_effect=_answers({"llm_model": "gpt-x"}, health)):
			self.assertEqual(link()["checks"], {"agent": True, "tools": True, "model": None})


class TestStatus(unittest.TestCase):
	PROBE = "rag-status-probe@example.com"
	OUTSIDER = "rag-status-outsider@example.com"

	def test_the_panel_refuses_a_user_without_the_knowledge_base_role(self):
		try:
			frappe.set_user(drive_fixture.drive_user(self.OUTSIDER, drive_role=False))
			with self.assertRaises(frappe.PermissionError):
				summary()
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()

	def test_the_document_listing_refuses_a_user_without_the_knowledge_base_role(self):
		try:
			frappe.set_user(drive_fixture.drive_user(self.OUTSIDER, drive_role=False))
			with self.assertRaises(frappe.PermissionError):
				documents()
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()

	def test_documents_are_the_files_drive_lets_the_user_read(self):
		name = drive_fixture.drive_file("status-probe.txt", b"Shared on request.\n", "text/plain")
		try:
			probe = drive_fixture.drive_user(self.PROBE)
			frappe.set_user(probe)
			self.assertEqual([d["name"] for d in documents()], [], "nothing shared yet")
			frappe.set_user("Administrator")
			frappe.get_doc("File", name).share(user=probe, read=1)
			frappe.set_user(probe)
			self.assertEqual([d["name"] for d in documents()], [name])
		finally:
			frappe.set_user("Administrator")
			frappe.db.rollback()
			drive_fixture.remove(name)

	def test_summary_describes_platform_index_and_model(self):
		with _signed_in():
			out = summary()
		self.assertEqual(set(out), {"platform", "index", "runtime", "model", "speeds"})
		self.assertEqual(out["platform"], {"runtime": "docker", "provider": None})
		self.assertEqual(out["index"], {"chunks": frappe.db.count("KB Chunk"), "ok": not health()["problems"]})
		# the demo's agent reaches the host's own Ollama
		self.assertEqual(out["model"]["provider"], "ollama")
		self.assertEqual(out["model"]["endpoint"], "host.docker.internal:11434")
		self.assertEqual(len(out["model"]["resolved"].split(".")), 4)

	def test_speeds_come_from_the_usage_saved_with_answers(self):
		try:
			chat = {"doctype": "AI Chat Session", "name": frappe.generate_hash(), "title": "t"}
			session = frappe.get_doc(chat).insert()
			usage = {"output_tokens": 50, "output_seconds": 2.0, "first_token_s": 1.5}
			answer = {"doctype": "AI Chat Message", "session": session.name, "role": "assistant", "content": "x"}
			frappe.get_doc(answer | {"tool_result_json": json.dumps({"usage": usage})}).insert()
			# a hosted model reports no decode time: no speed, but a first token
			# "y", because a row repeating the one before it in the chat is refused (ADR-011)
			hosted = {"content": "y", "tool_result_json": json.dumps({"usage": {"first_token_s": 0.8}})}
			frappe.get_doc(answer | hosted).insert()
			speeds = summary()["speeds"]
			self.assertEqual(
				[{k: v for k, v in r.items() if k != "id"} for r in speeds[-2:]],
				[{"tps": 25.0, "ttft": 1.5}, {"tps": None, "ttft": 0.8}],
			)
			self.assertLessEqual(len(speeds), status.SPEEDS)
		finally:
			frappe.db.rollback()
