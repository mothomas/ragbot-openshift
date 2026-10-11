"""Fail on a docstring or a JSDoc block that says more than its summary line and its sections."""

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECTION = re.compile(r"^\s*(Args|Arguments|Parameters|Returns|Yields|Raises|Attributes|Examples?):\s*$")
# unittest prints a test's docstring as its description, so a test may say as much as it likes
TEST = re.compile(r"(^|/)(tests?|e2e|__tests__)/|(^|/)test_[^/]+\.py$|\.(test|spec)\.[cm]?[jt]sx?$")
SKIP = re.compile(r"(^|/)(node_modules|\.next|out|__pycache__)/|\.d\.ts$")
JSDOC = re.compile(r"/\*\*[\s\S]*?\*/")


def allowed(doc: str, module: bool) -> bool:
	lines = doc.strip().splitlines()
	if len(lines) <= 1:
		return True
	if module:
		return False
	first = next((i for i, line in enumerate(lines) if SECTION.match(line)), 0)
	# a section's own body is indented under it; anything flush left after the summary is prose
	return first > 0 and all(
		not line.strip() or line.startswith((" ", "\t")) or SECTION.match(line) for line in lines[1:]
	)


def rel(path: Path) -> str:
	# a checkout under any directory called tests/ or e2e/ would otherwise skip the whole tree
	return path.as_posix().removeprefix(ROOT.parent.as_posix() + "/")


def findings(path: Path) -> list[str]:
	src = path.read_text(errors="ignore")
	name, out = rel(path), []
	if path.suffix == ".py":
		for node in ast.walk(ast.parse(src)):
			if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
				doc = ast.get_docstring(node, clean=True)
				if doc and not allowed(doc, isinstance(node, ast.Module)):
					out.append(f"{name}:{getattr(node, 'lineno', 1)}: docstring of {len(doc.splitlines())} lines")
	else:
		for m in JSDOC.finditer(src):
			breaks = m.group(0).count("\n")
			if breaks >= 3:
				line = src.count("\n", 0, m.start()) + 1
				out.append(f"{name}:{line}: JSDoc block of {breaks + 1} lines")
	return out


def sources(argv: list[str]) -> list[Path]:
	if argv:
		return [Path(a) for a in argv]
	fe = ROOT / "frontend"
	py = [*(ROOT / "rag").rglob("*.py"), *(ROOT / "tools").rglob("*.py")]
	return sorted([*py, *fe.rglob("*.ts"), *fe.rglob("*.tsx")])


def main(argv: list[str]) -> int:
	bad = []
	for path in sources(argv):
		if TEST.search(rel(path)) or SKIP.search(rel(path)) or path.suffix not in (".py", ".ts", ".tsx"):
			continue
		bad += findings(path)
	for line in bad:
		sys.stderr.write(line + "\n")
	if bad:
		sys.stderr.write(f"{len(bad)} docstring(s) say more than a summary line and their sections\n")
	return 1 if bad else 0


if __name__ == "__main__":
	raise SystemExit(main(sys.argv[1:]))
