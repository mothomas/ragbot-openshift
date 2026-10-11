__version__ = "0.0.1"


def after_uninstall():
	"""Drop every Scheduled Job Type row naming a rag method, including any an older rag scheduled."""
	import frappe

	frappe.db.delete("Scheduled Job Type", {"method": ("like", "rag.%")})
