import functools
import json
import os
import socket
import time
from pathlib import Path
from urllib.parse import urlparse

import frappe
import redis
import requests
from frappe import _
from frappe.utils import cint
from frappe.utils.caching import redis_cache, site_cache

from rag.ingest import health

SERVICE_ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")
SPEEDS = 20  # answers the status panel's speed chart shows
PANEL_TTL = 60  # seconds the panel's two slow readings are kept; ADR-024

LINK_LOCAL = "http://169.254.169.254"  # every cloud but Google answers its metadata here
GCP_METADATA = "http://metadata.google.internal/computeMetadata/v1/"  # _placement takes it as a prefix
AZURE_API = "2021-02-01"

# Each cloud's instance metadata service, which answers only from inside that cloud.
METADATA = {
	"ec2": ("PUT", f"{LINK_LOCAL}/latest/api/token", {"X-aws-ec2-metadata-token-ttl-seconds": "60"}),
	"gcp": ("GET", GCP_METADATA, {"Metadata-Flavor": "Google"}),
	"azure": ("GET", f"{LINK_LOCAL}/metadata/instance?api-version={AZURE_API}", {"Metadata": "true"}),
	"digitalocean": ("GET", f"{LINK_LOCAL}/metadata/v1/id", {}),
}


def panel_on() -> bool:
	"""Whether this site serves the /ask Status panel; off takes summary(), location() and the panel with it."""
	# cint, because `bench set-config rag_status_panel 0` writes the string "0", which is true to bool()
	return bool(cint(frappe.conf.get("rag_status_panel", 1)))


def _agent_url() -> str:
	"""The agent's address as frappe_ai's own _agent_url() reads it: this site's config, no trailing slash."""
	return (frappe.conf.get("frappe_ai_agent_url") or "").rstrip("/")


@frappe.whitelist(methods=["GET"])
def summary() -> dict:
	"""Everything the /ask status panel shows, in one request."""
	if not panel_on():
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	frappe.has_permission("KB Chunk", "report", throw=True)
	return {
		"platform": platform(),
		"index": _index(),
		"runtime": {**_where(), "uptime_s": _uptime()},
		"model": _model_link(),
		"speeds": _speeds(),
	}


@redis_cache(ttl=PANEL_TTL)  # health() aggregates over every KB Chunk row and no index serves it
def _index() -> dict:
	# every problem health() finds has the same fix, re-indexing, so one flag is enough here
	h = health()
	return {"chunks": h["chunks"], "ok": not h["problems"]}


def _agent_config(url: str) -> tuple[dict | None, float | None]:
	"""The agent's /config and the round trip it took, or (None, None) when the agent does not answer."""
	start = time.monotonic()
	try:
		# this call hands the reader's sid to whatever address site_config names, so it passes the
		# check frappe_ai's own relay makes before doing the same: http to a public peer, or a
		# metadata or link-local one, is refused, and a private one needs the unsafe_ok escape
		from frappe_ai.api.chat import _validate_agent_url

		_validate_agent_url(url)
		# the agent refuses /config without a signed-in session (ADR-031); both callers run inside a
		# whitelisted handler, so frappe.session.sid is a real one
		r = requests.get(f"{url}/config", timeout=3, cookies={"sid": frappe.session.sid})
		r.raise_for_status()
	except requests.RequestException, ImportError, frappe.ValidationError:
		return None, None
	rtt_ms = round((time.monotonic() - start) * 1000, 1)
	try:
		return r.json(), rtt_ms
	except ValueError:
		return None, None


@redis_cache(ttl=PANEL_TTL)  # a /config call and a DNS lookup the surrounding timeout does not bound
def _model_link() -> dict | None:
	"""Where the agent's model is served from, as the agent is configured, and what that resolves to here."""
	url = _agent_url()
	config = _agent_config(url)[0] if url else None
	if config is None:
		return None
	base = urlparse(config.get("llm_base_url") or "")
	try:
		resolved = socket.gethostbyname(base.hostname) if base.hostname else None
	except OSError:
		resolved = None
	return {
		"provider": config.get("llm_provider"),
		"host": base.hostname,
		"endpoint": base.netloc or None,
		"resolved": resolved,
	}


def _speeds() -> list[dict] | None:
	"""This user's last SPEEDS answers, oldest first; tps is None for a hosted model (no decode time).

	Returns:
		None without frappe_ai: the chats these timings come from are its own, so the panel leaves
		the speeds out and shows its other checks.
	"""
	if "frappe_ai" not in frappe.get_installed_apps():
		return None
	rows = frappe.db.sql(
		"""
		SELECT m.name, m.tool_result_json FROM `tabAI Chat Message` m
		JOIN `tabAI Chat Session` s ON s.name = m.session
		WHERE s.user = %(user)s AND m.role = 'assistant' AND m.tool_result_json LIKE %(usage)s
		ORDER BY m.creation DESC, m.name DESC
		LIMIT %(n)s
		""",
		{"user": frappe.session.user, "usage": '%"usage"%', "n": SPEEDS},
		as_dict=True,
	)
	out = []
	for r in reversed(rows):
		try:
			usage = json.loads(r.tool_result_json).get("usage") or {}
		except ValueError, AttributeError:
			continue
		tps = round(usage["output_tokens"] / usage["output_seconds"], 1) if usage.get("output_seconds") else None
		out.append({"id": r.name, "tps": tps, "ttft": usage.get("first_token_s")})
	return out


@frappe.whitelist(methods=["GET"])
def link() -> dict:
	"""Where this runs and the agent's state, for the /ask top-bar chip, composer and health line."""
	url = _agent_url()
	# only the panel reads where this runs, and reading it probes four clouds' metadata services
	return {"location": location() if panel_on() else "", **(_agent_state(url) if url else _probe(url))}


AGENT_STATE = "rag:status:agent"  # the last probe of the agent, shared by every poll on this site


def _agent_state(url: str) -> dict:
	"""One agent probe per site at a time; other polls return the last result instead of holding a worker 8 s."""
	cache = frappe.cache
	try:
		mine = cache.set(cache.make_key(AGENT_STATE + ":probing"), 1, nx=True, ex=10)
	except redis.exceptions.ConnectionError:
		return _probe(url)  # without Redis every poll probes, as before
	last = cache.get_value(AGENT_STATE)
	if not mine and last:
		return last
	try:
		state = _probe(url)
		cache.set_value(AGENT_STATE, state, expires_in_sec=60)
	finally:
		if mine:
			cache.delete_value(AGENT_STATE + ":probing")
	return state


def _probe(url: str) -> dict:
	config, rtt_ms, ok, model, runs = None, None, False, None, None
	# None is unknown: the agent reports on the tools server and the model
	checks: dict[str, bool | None] = {"agent": False, "tools": None, "model": None}
	if url:
		config, rtt_ms = _agent_config(url)
	if config is not None:
		try:
			model = config.get("llm_model")
			# where the model runs and the context window the agent asks for: the composer's hover
			runs = {
				"provider": config.get("llm_provider"),
				# urlparse raises on an address it cannot read, such as an unclosed IPv6 literal
				"host": urlparse(config.get("llm_base_url") or "").hostname,
				"context": config.get("llm_num_ctx"),
			}
			checks["agent"] = True
			detail = requests.get(f"{url}/health", params={"detail": "true"}, timeout=5).json()
			llm = detail.get("llm") or {}
			checks["tools"] = (detail.get("mcp") or {}).get("ok") is True
			# the agent skips the probe for hosted models and still says ok; that is not an answer
			checks["model"] = None if llm.get("skipped") else llm.get("ok") is True
			ok = detail.get("healthy") is True
		except requests.RequestException, ValueError:
			pass
	return {
		"rtt_ms": rtt_ms if ok else None,
		"ok": ok,
		"model": model,
		"runs": runs,
		"checks": checks,
	}


@functools.cache  # per worker: where a server runs does not change while it runs
def location() -> str:
	"""A managed platform a node label proves, else the cloud whose metadata service answers, else onprem."""
	if _in_kubernetes() and (provider := provider_of(_node() or {})):
		return provider
	answered = False
	for cloud, (method, url, headers) in METADATA.items():
		try:
			r = requests.request(method, url, headers=headers, timeout=0.3)
		except requests.RequestException:
			continue
		answered = True
		if r.ok and (cloud != "gcp" or r.headers.get("Metadata-Flavor") == "Google"):
			return cloud
	# a metadata service we don't know (Oracle, Alibaba, OpenStack) still means a cloud
	return "cloud" if answered else "onprem"


@site_cache()  # per site: the agent's route comes from each site's own config
def _where() -> dict:
	"""Where this runs; a pod names its node only from NODE_NAME, as the API's first node may not be its own."""
	if _in_kubernetes():
		named = os.getenv("NODE_NAME")
		labels = (((_node() or {}).get("metadata") or {}).get("labels") or {}) if named else {}
		return {
			"region": labels.get("topology.kubernetes.io/region"),
			"zone": labels.get("topology.kubernetes.io/zone"),
			"node": named,
			"namespace": _namespace(),
			"pod": socket.gethostname(),
			"ip": _ip(),
		}
	return {**_placement(location()), "host": socket.gethostname(), "ip": _ip()}


def _text(method: str, url: str, **kw) -> str | None:
	try:
		r = requests.request(method, url, timeout=0.3, **kw)
	except requests.RequestException:
		return None
	return r.text.strip() or None if r.ok else None


def _placement(cloud: str) -> dict:
	"""Region and zone from the metadata service of the cloud this runs in."""
	region = zone = None
	if cloud == "ec2":
		aws = f"{LINK_LOCAL}/latest/meta-data/placement"
		token = {"X-aws-ec2-metadata-token": _text("PUT", METADATA["ec2"][1], headers=METADATA["ec2"][2]) or ""}
		region = _text("GET", f"{aws}/region", headers=token)
		zone = _text("GET", f"{aws}/availability-zone", headers=token)
	elif cloud == "gcp":
		gcp = f"{GCP_METADATA}instance/zone"
		name = _text("GET", gcp, headers=METADATA["gcp"][2])  # projects/<number>/zones/<zone>
		zone = name.rsplit("/", 1)[-1] if name else None
		region = zone.rsplit("-", 1)[0] if zone else None
	elif cloud == "azure":
		azure = f"{LINK_LOCAL}/metadata/instance/compute"
		ask = {"params": {"api-version": AZURE_API, "format": "text"}, "headers": METADATA["azure"][2]}
		region = _text("GET", f"{azure}/location", **ask)
		zone = _text("GET", f"{azure}/zone", **ask)
	elif cloud == "digitalocean":
		region = _text("GET", f"{LINK_LOCAL}/metadata/v1/region")
	return {"region": region, "zone": zone}


def _ip() -> str | None:
	"""The address this server reaches the agent from; the UDP connect only picks a route, it sends nothing."""
	host = urlparse(_agent_url()).hostname
	if not host:
		return None
	try:
		with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
			s.connect((host, 9))
			return s.getsockname()[0]
	except OSError:
		return None


def _uptime() -> int | None:
	"""Seconds since this container started: its first process's start time, from /proc."""
	try:
		since_boot = float(Path("/proc/uptime").read_text().split()[0])
		ticks = int(Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()[19])
		return round(since_boot - ticks / os.sysconf("SC_CLK_TCK"))
	except OSError, ValueError, IndexError:
		return None


def _namespace() -> str | None:
	f = SERVICE_ACCOUNT / "namespace"
	return f.read_text().strip() if f.is_file() else None


_NODE: dict | None = None  # read once per worker; a failed read is not kept, because it may be a blip


def _in_kubernetes() -> bool:
	return (SERVICE_ACCOUNT / "token").is_file() and bool(os.getenv("KUBERNETES_SERVICE_HOST"))


def platform() -> dict:
	"""Where this server runs, claimed only as far as the evidence goes."""
	if _in_kubernetes():
		return {"runtime": "kubernetes", "provider": provider_of(_node() or {})}
	if Path("/.dockerenv").exists():
		return {"runtime": "docker", "provider": None}
	return {"runtime": None, "provider": None}


def provider_of(node: dict) -> str | None:
	labels = (node.get("metadata") or {}).get("labels") or {}
	provider_id = str((node.get("spec") or {}).get("providerID") or "")
	on_aws = provider_id.startswith("aws://") or any(k.startswith("eks.amazonaws.com/") for k in labels)
	if any(k.startswith(("node.openshift.io/", "hypershift.openshift.io/")) for k in labels):
		return "rosa" if on_aws else "openshift"
	if on_aws:
		return "eks"
	if provider_id.startswith("digitalocean://"):
		return "digitalocean"
	return None


def _node() -> dict | None:
	"""One node, read with the service account; needs `get` on nodes (`list` without NODE_NAME), else None."""
	global _NODE
	if _NODE is not None:
		return _NODE
	host, port = os.environ["KUBERNETES_SERVICE_HOST"], os.getenv("KUBERNETES_SERVICE_PORT", "443")
	name = os.getenv("NODE_NAME")
	path = f"/api/v1/nodes/{name}" if name else "/api/v1/nodes?limit=1"
	try:
		r = requests.get(
			f"https://{host}:{port}{path}",
			headers={"Authorization": f"Bearer {(SERVICE_ACCOUNT / 'token').read_text().strip()}"},
			verify=str(SERVICE_ACCOUNT / "ca.crt"),
			timeout=2,
		)
		r.raise_for_status()
		body = r.json()
	except OSError, requests.RequestException, ValueError:
		return None
	_NODE = (body.get("items") or [None])[0] if "items" in body else body
	return _NODE
