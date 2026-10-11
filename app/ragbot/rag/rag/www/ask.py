import json

import frappe

from rag.status import panel_on

no_cache = 1

# an image in an answer is fetched with no click and the model writes its address, so only this site's
# own images load (S17); data: and blob: are Metis's own previews and uploads
CSP = (
	"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
	"img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'; "
	"frame-ancestors 'self'"
)


def get_context(context):
	full_name = frappe.utils.get_fullname(frappe.session.user)
	# The page carries the first view already drawn, greeting and all, so the browser paints it before a script
	# runs; the app redraws the same greeting once React is up. Both read this one name, split once, here.
	first_name = full_name.split(" ")[0]
	boot = {
		"user": frappe.session.user,
		"full_name": full_name,
		"first_name": first_name,
		"csrf_token": frappe.sessions.get_csrf_token(),
		"site_name": frappe.local.site,
		# Frappe stores naive datetimes in this zone; the browser reads them in it
		"time_zone": frappe.utils.get_system_timezone(),
		# the agent writes amounts in this currency and our blocks format them in it
		"currency": frappe.db.get_default("currency") or "",
		"status_panel": panel_on(),
	}
	# get_csrf_token stores the token on the session, and a GET is rolled back at the end
	frappe.db.commit()  # nosemgrep: frappe-manual-commit
	# `<` escaped so a name can never close the script tag it is written into
	context.boot_json = json.dumps(boot).replace("<", "\\u003c")
	# frappe's jinja environment sets no autoescape, so a name with markup in it would be markup here
	context.first_name = frappe.utils.escape_html(first_name)
	frappe.local.response_headers["Content-Security-Policy"] = CSP
