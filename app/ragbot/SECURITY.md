# Security policy

## Reporting a vulnerability

Report privately through GitHub, at
[Security > Advisories > Report a vulnerability](https://github.com/tssarathi/ragbot/security/advisories/new).
Do not open a public issue, a pull request or a discussion for a vulnerability.

Include what you can of: the version or commit, the configuration, the smallest request or
file that shows the problem, and what an attacker gains. Do not include real credentials,
session ids or document contents.

Expect an acknowledgement within seven days and a first assessment within thirty. A fix ships
on `main`; there is no backport branch. You will be credited in the advisory unless you ask
not to be.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
| anything else | no |

ragbot is a demonstration harness, not a supported product. It has one branch and no releases.

## Scope

In scope: this repository. That is the `rag` Frappe app under `rag/`, the `/ask` frontend under
`rag/frontend/`, the Compose files, the Makefile, `mcp/Dockerfile` and `mcp/config.yaml`.

Out of scope, and to be reported to their own maintainers:

* Frappe, ERPNext and Frappe Drive — <https://github.com/frappe/frappe/security/policy>
* Ollama and the models it serves
* `frappe_ai`, `frappe-ai-agent` and `frappe-mcp-server`, which this repository builds and runs
  but does not contain

## Known limits of the demo, which are not vulnerabilities

These are properties of a local demonstration stack, documented rather than fixed.

* The stack publishes its HTTP port on `127.0.0.1` only and expects no proxy, no TLS and no
  authentication in front of it.
* `make .env` writes random passwords into `.env`, which is not committed. A deployment sets its
  own.
* The site talks to Ollama over plain HTTP. [PRIVACY.md](PRIVACY.md) lists every call that leaves
  a container and what it carries.
* Setting `OLLAMA_HOST=0.0.0.0` on the host publishes an unauthenticated model API to every
  network the host is on. [README.md](README.md) says to bind it to one address instead.
