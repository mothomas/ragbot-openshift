"""make staleness: every container serves the code this checkout contains, and its assets match their source.

python3 staleness.py   exit 0 only if every case holds; prints a hash per container, never a file's contents.
python3 staleness.py --selftest   the comparisons, checked without a stack.

Application code reaches a container two ways — bind-mounted from the working tree, or baked into an image —
and until rag is installed and pinned (ADR-038 moves 2 and 4) nothing compares them. Four failures in this
audit came from that gap and three were first read as product defects: a bundle serving a method that had
been renamed, a sidebar that never mounted because the manifest named a file that was not on disk, an Error
Log row from a controller reading a column that had been removed, and a suite that passed for months against
an image predating the fix it was meant to prove.

The cost is not the four: it is that a result from a stack which might be serving stale code cannot be
trusted, so this runs before the checks that would inherit the doubt.
"""
import json
import subprocess
import sys
from pathlib import Path

from lib import PROJECT, ROOT

# app name -> where its Python lives in a container, and the tree this checkout serves it from
# each pair is the tree this checkout serves and the directory a container imports it from, and they must
# name the SAME subtree: frappe_ai is bind-mounted at its inner package, so comparing repository roots would
# report a difference that is only the harness's own files
APPS = {
    "rag": (ROOT / "rag", "apps/rag"),
    "frappe_ai": (Path("/Users/sarathi/Documents/L2X/reference-repos/frappe_ai/frappe_ai"),
                  "apps/frappe_ai/frappe_ai"),
}
SOURCE = (".ts", ".tsx", ".vue", ".js", ".jsx", ".css", ".scss")
failures = []


def case(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


def containers() -> list[str]:
    """The containers that serve the site under test.

    The demo's own containers are left out on purpose: they run the image a checkpoint built, so they are
    meant to differ from the working tree, and asserting otherwise would cry wolf on every run. What must
    not differ is what the site under test is served from.
    """
    out = subprocess.run(["docker", "ps", "--filter", f"name={PROJECT}-", "--format", "{{.Names}}"],
                         capture_output=True, text=True, timeout=60).stdout
    names = sorted(n for n in out.split() if n)
    under_test = [n for n in names if "-test-" in n]
    return under_test or names


def _in(container: str, script: str) -> str:
    p = subprocess.run(["docker", "exec", container, "sh", "-c", script],
                       capture_output=True, text=True, timeout=180)
    return p.stdout.strip()


def python_digest(container: str, app_dir: str) -> str:
    """One hash over an app's Python, as that container would import it."""
    return _in(container, f"cd {app_dir} 2>/dev/null && find . -name '*.py' -not -path '*/__pycache__/*' "
                          "| sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1")


def host_digest(tree: Path) -> str:
    """The same hash over this checkout, so the two are comparable."""
    files = sorted(p for p in tree.rglob("*.py") if "__pycache__" not in p.parts)
    lines = "".join(f"{_md5(p)}  ./{p.relative_to(tree)}\n" for p in files)
    return _md5_bytes(lines.encode())


def _md5(path: Path) -> str:
    import hashlib
    return hashlib.md5(path.read_bytes()).hexdigest()  # noqa: S324 - identity, not a signature


def _md5_bytes(b: bytes) -> str:
    import hashlib
    return hashlib.md5(b).hexdigest()  # noqa: S324 - identity, not a signature


def disagreeing(digests: dict[str, str]) -> list[str]:
    """The containers whose copy is not the one the majority serve."""
    if len(set(digests.values())) <= 1:
        return []
    top = max(set(digests.values()), key=lambda d: list(digests.values()).count(d))
    return sorted(name for name, d in digests.items() if d != top)


def missing_assets(container: str) -> list[str]:
    """Paths the asset manifest names that are not on disk, which is a bundle that cannot load."""
    out = _in(container, "python3 - <<'EOF'\n"
                         "import json, os\n"
                         "m = json.load(open('sites/assets/assets.json'))\n"
                         "print('\\n'.join(sorted(v for v in m.values()\n"
                         "      if v.startswith('/assets/') and not os.path.exists('sites' + v))))\n"
                         "EOF")
    return [line for line in out.splitlines() if line.strip()]


def stale_bundle(tree: Path, built: Path) -> tuple[float, float] | None:
    """The newest source and the newest built file, when the source is the later of the two."""
    if not built.exists():
        return None
    srcs = [p for p in tree.rglob("*") if p.suffix in SOURCE and "node_modules" not in p.parts]
    outs = [p for p in built.rglob("*") if p.is_file()]
    if not srcs or not outs:
        return None
    newest_src = max(p.stat().st_mtime for p in srcs)
    newest_out = max(p.stat().st_mtime for p in outs)
    return (newest_src, newest_out) if newest_src > newest_out else None


def selftest():
    """The comparisons, checked without a stack: `python3 staleness.py --selftest`."""
    assert disagreeing({"a": "1", "b": "1"}) == []
    assert disagreeing({"a": "1", "b": "1", "c": "2"}) == ["c"], "the odd one out is named"
    assert disagreeing({"a": "1"}) == []
    assert disagreeing({}) == []
    # a two-way split has no majority to be right, so both are reported rather than one picked
    assert len(disagreeing({"a": "1", "b": "2"})) == 1
    print("selftest ok")


def main():
    names = containers()
    case(bool(names), "the compose project is up", f"{len(names)} containers")
    if not names:
        return

    # a frontend serves assets and runs no Python, so its copy of an app is never imported and comparing
    # it would report a difference that cannot affect a result
    runs_python = [c for c in names if "frontend" not in c]
    for app, (tree, app_dir) in APPS.items():
        digests = {c: d for c in runs_python if (d := python_digest(c, app_dir))}
        if not digests:
            continue
        odd = disagreeing(digests)
        case(not odd, f"{app}: every container serves the same Python",
             f"{len(digests)} containers; disagreeing: {odd}" if odd else f"{len(digests)} containers agree")
        if tree.exists():
            here = host_digest(tree)
            served = sorted(set(digests.values()))
            case(here in served, f"{app}: what is served is what this checkout contains",
                 "" if here in served else f"checkout {here[:8]}, containers {[d[:8] for d in served]}")

    for c in names:
        gone = missing_assets(c)
        if gone or _in(c, "test -f sites/assets/assets.json && echo y"):
            case(not gone, f"{c}: the asset manifest names files that exist",
                 f"{len(gone)} missing: {gone[:2]}" if gone else "")

    for app, built in (("rag", ROOT / "rag/rag/public/ask"),
                       ("frappe_ai", APPS["frappe_ai"][0] / "public/dist")):
        tree = APPS[app][0]
        if not tree.exists():
            continue
        stale = stale_bundle(tree, built)
        case(stale is None, f"{app}: its built bundle is not older than its source",
             "" if stale is None else f"source is {int(stale[0] - stale[1])}s newer than the build")

    print(f"\n{PROJECT}: {len(names)} containers, {len(failures)} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
