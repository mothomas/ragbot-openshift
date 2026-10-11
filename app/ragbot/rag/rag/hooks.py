app_name = "rag"
app_title = "RAG"
app_publisher = "Sarathi Thirumalai Soundararajan"
app_description = "Knowledge base over Frappe Drive"
app_license = "AGPL-3.0-or-later"
# Metis needs frappe_ai for its chats; search does not, so rag still answers where it was removed.
required_apps = ["drive", "frappe_ai"]
# on_doctype_update only fires when kb_chunk.json's md5 changes, which covers a fresh install
# but not an ordinary migrate: schema sync skips an unchanged doctype by migration_hash.
after_migrate = ["rag.kb.doctype.kb_chunk.kb_chunk.on_doctype_update"]
# install_app ends with sync_jobs() and remove_app calls nothing of the kind, so without this the
# scheduler_events below outlive the app as rows until some other app's migrate clears them.
after_uninstall = "rag.after_uninstall"

doc_events = {
	"File": {
		"on_update": "rag.ingest.on_file_update",
		"on_trash": "rag.ingest.on_file_trash",
	}
}

# The /ask frontend is one exported page; every path under it serves that page, except the
# file previews, which rag.preview serves from Drive.
website_route_rules = [
	{"from_route": "/ask/files/<name>/<path:filename>", "to_route": "ask/files"},
	{"from_route": "/ask/<path:app_path>", "to_route": "ask"},
]
page_renderer = ["rag.preview.FilePage"]

scheduler_events = {
	"hourly": ["rag.ingest.retry_failed"],
	"daily": ["rag.chat.purge_orphan_attachments"],
}

# rag.search.search writes one Access Log row per answered call, and frappe clears that doctype for
# nobody by default. 90 days is what it keeps its own Activity Log and Route History for; on a site
# that already exists the daily Log Settings job is what picks this up.
default_log_clearing_doctypes = {"Access Log": 90}
