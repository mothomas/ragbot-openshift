# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). ragbot is a
demonstration stack with one branch and no releases, so it carries one section, `Unreleased`, and
a change is identified by its commit. This file starts at the commit that added it; everything
before that is in `git log`, whose messages are one-line Conventional Commits with a scope.

## [Unreleased]

### Added

- A correlation id: every request Metis makes carries `X-Frappe-Request-Id`, a new site keeps
  Frappe's monitor on so that id becomes the transaction's trace id, and the indexing job inherits
  it from the upload that queued it.
- An audit trail for retrieval: every answered search, and every re-read of a saved source,
  writes a Frappe Access Log row naming the reader, the chat, the file ids it returned and the
  request's trace id, never the question. A refused search and a failed embedding are logged once.
- `make retrieval` scores what retrieval finds against a frozen eval set: thirteen questions over
  the demo's own seven policy documents, recall@k and nDCG@k, no model judging anything.
- `make citations` asserts that every source an answer shows was a passage that answer actually
  retrieved, against the Access Log rows the search wrote.
- `.importlinter`: Metis's modules may sit on rag's core, and the core may not import Metis.
- `.markdownlint-cli2.jsonc`: every markdown document is linted, not only the README.
- `make sbom` writes a CycloneDX document for each image the demo runs.
- `.pre-commit-config.yaml`, running ruff, markdownlint, hadolint, actionlint, zizmor, pyrefly,
  bandit and the import contract, and `.github/dependabot.yml` to move the pins.
- `.github/workflows/ci.yml`, on every pull request and every push to `main`, and a Local CI
  section in the README saying what each job runs and what stays local.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, YAML issue forms, a pull request
  template, `CODEOWNERS` and `.editorconfig`; the README gains badges, a table of contents,
  Security, Background with an architecture diagram, and Maintainers.

### Changed

- `rag.search.search` takes its arguments in a `POST` body and refuses a `GET`. As a `GET` the
  question travelled in the query string, which every access log on the way keeps. A caller outside
  this repository, such as the MCP server's `search_knowledge_base`, has to change with it.
- `make check` also runs the MCP server's and the agent's own suites, at the commits this
  repository pins, fetched under `.build/` and checked out again on every run.
- Every base image, and every image the Compose file pulls, is pinned by digest.
- The MCP server's image takes its CA bundle from the base image instead of installing one.

### Fixed

- `rag.search.passages` annotates its `refs` argument, so Frappe validates it at the boundary.
- The two "Not permitted" refusals go through Frappe's translation function.

[unreleased]: https://github.com/tssarathi/ragbot/commits/main
