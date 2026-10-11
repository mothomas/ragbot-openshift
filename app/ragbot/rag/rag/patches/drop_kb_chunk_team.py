from frappe.model import delete_fields


def execute():
	"""Drop KB Chunk.team, which nothing ever read; schema sync leaves a removed DocField's column behind."""
	delete_fields({"KB Chunk": ["team"]}, delete=1)
