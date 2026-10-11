# Contributing

Thank you for looking. This is a demonstration stack, so the bar is "it still runs from a clean
machine and every gate is green", not feature completeness.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). A vulnerability goes
through [SECURITY.md](SECURITY.md), never a public issue.

## Before you start

Open an issue first for anything larger than a fix. [README.md](README.md) explains what the
stack is and how to run it; [PRIVACY.md](PRIVACY.md) and [SCALING.md](SCALING.md) hold the
claims a change must not quietly break.

## Setting up

```sh
ollama pull gemma4:26b && ollama pull nomic-embed-text
make setup
```

`make help` lists every target. `rag/` is bind-mounted, so a Python edit is in the containers at
once; the table under "Reaching the running stack" in [README.md](README.md) says what each kind
of change still needs.

## The gates

Run these before you open a pull request. The same commands run in CI.

```sh
make check                    # ruff, the frontend, backend and pinned service suites, index health, no new Error Log rows
cd rag && yarn lint           # eslint, including jsx-a11y
cd rag && yarn format:check   # prettier
cd rag && yarn typecheck      # tsc --noEmit
cd rag && yarn test           # vitest
cd rag && yarn build          # next build; nothing else type-checks the export
hadolint mcp/Dockerfile
npx --yes markdownlint-cli2
uvx --from import-linter lint-imports --config rag/.importlinter   # from rag/
```

`make check` builds the MCP server's and the agent's own suites in, because this repository pins
which commit of each the demo runs, so `go` and `uv` have to be on the host. It fetches that one
commit under `.build/` and checks it out again on every run, so the suite it runs is always the
commit the images are built from. `make service-suites` runs only those two and needs no stack,
which is what to use while moving a pin.

Installing [pre-commit](https://pre-commit.com/) runs the fast ones for you:

```sh
uvx pre-commit install
```

To run a workflow the way GitHub will, use [act](https://github.com/nektos/act):

```sh
act pull_request --workflows .github/workflows/ci.yml
```

`make check` needs the stack up, so it is not in CI; the hosted jobs run the same linters,
type checks, builds and unit tests against a MariaDB service, and the end-to-end run stays
local. [README.md](README.md) has the details under "Local CI".

## Commits

One line, a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) with a scope,
in the imperative:

```text
fix(search): return no passages when frappe_ai is absent
```

No body and no trailers. One meaningful change per commit; a structural change and a behavioural
one go in separate commits. [CHANGELOG.md](CHANGELOG.md) follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/): add your line under `## [Unreleased]`.

## Pull requests

* Keep the diff small enough to read in one sitting. Past about 400 changed lines, split it.
* A bug fix brings a test that fails without it.
* A change to a document must be true of the code on the same commit.
* Do not change what a user sees — wording, layout, colour, icons — without saying why in the
  pull request; those were chosen deliberately.
* Comments earn their place only where a competent developer would otherwise "fix" the code back
  into a bug. One line, at the trap.

## Licence

Contributions are licensed under `AGPL-3.0-or-later`, the same terms as the rest of the
repository. See [LICENSE](LICENSE).
