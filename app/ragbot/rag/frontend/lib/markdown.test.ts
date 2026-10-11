import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";
import { describe, expect, it } from "vitest";
import { blocks } from "./markdown";

// The answer as ec3e463 formatted it: the whole text through remend, then one parse. The a/img overrides
// components/Markdown.tsx adds are per node, so they cannot tell a block from the answer it was cut out of.
const whole = (text: string) =>
  renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm] }, remend(text)),
  );
const incremental = (text: string) =>
  blocks(text)
    .map((b) =>
      renderToStaticMarkup(
        createElement(Markdown, { remarkPlugins: [remarkGfm] }, b),
      ),
    )
    .join("\n"); // one parse of the whole answer puts a newline between its top-level nodes

// mulberry32, so a failing answer can be reproduced from the seed the message prints
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KINDS = [
  "Leave accrues each month and the **balance** carries over, up to the cap in [the policy](https://example.invalid/p).",
  "The rate is 20~25 per cent, the code is `accrual_cap`, and the old wording was ~~half of that~~.",
  "## Where the figure comes from",
  "What the search found\n=====================",
  "| File | Passages | Distance |\n| --- | --- | --- |\n| report.pdf | 4 | 0.24 |\n| notes.md | 2 | 0.31 |",
  "- first point\n- second point\n- third point",
  "- loose point\n\n- second loose point",
  "1. first\n2. second\n3. third",
  "> The policy says the cap applies per financial year.\n>\n> It does not say what happens to the remainder.",
  "```python\ndef search(q: str) -> list[str]:\n\n    return rank(embed(q))\n```",
  "~~~text\na fence holding ``` inside it\n\nand a blank line\n~~~",
  "~~~`js\na fence whose info string carries a backtick\n\nand a blank line\n~~~",
  "    indented code\n\n    with a blank line in it",
  "---",
  "Some answers put a literal asterisk * in the middle and a stray ** pair after it.",
  "See [the guide][g] for the whole path.\n\n[g]: https://example.invalid/guide",
  "See [the guide][g] and [the policy][p] for the whole path.",
  "[g]: https://example.invalid/guide\n[p]: https://example.invalid/policy",
  "The cap applies per financial year.[^1]",
  "[^1]: Section 4 of the policy.",
  "[\nthe guide\n]: https://example.invalid/guide",
  "~~~ aa ``` ~~~\na tilde fence whose info string holds backticks\n\nand a blank line\n~~~",
  "Costs [ a lot of money, and the bracket never closes.",
  "<pre>\n\nraw html with a blank line\n\n</pre>",
  "<div>a raw html block</div>",
  "A trailing sentence that stops mid-",
];

const answer = (rnd: () => number, n: number) =>
  Array.from({ length: n }, () => KINDS[Math.floor(rnd() * KINDS.length)]).join(
    "\n\n",
  );

describe("formatting a streamed answer incrementally", () => {
  it("renders every random answer exactly as one whole-text parse does", () => {
    let settled = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = random(seed);
      const text = answer(rnd, 1 + Math.floor(rnd() * 6));
      // the model can stop anywhere, so half the answers are cut off mid-construct
      const cut =
        rnd() < 0.5 ? text : text.slice(0, 1 + Math.floor(rnd() * text.length));
      expect(incremental(cut), `seed ${seed}`).toBe(whole(cut));
      settled += blocks(cut).length - 1;
    }
    expect(settled).toBeGreaterThan(50); // the answers settled blocks, so the check was not vacuous
  });

  it("renders every prefix of a stream the way the whole text at that moment would", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = random(seed);
      const text = answer(rnd, 3);
      for (let i = 1; i <= text.length; i++)
        expect(incremental(text.slice(0, i)), `seed ${seed} at ${i}`).toBe(
          whole(text.slice(0, i)),
        );
    }
  });

  it("formats the answer whole while a definition's own line is still arriving", () => {
    for (const text of [
      "See [the guide][g] here.\n\nAnother paragraph.\n\n[g]: https://example.invalid/g\n",
      "The cap applies per year.[^1]\n\nAnother paragraph.\n\n[^1]: Section 4.\n",
    ])
      for (let i = 1; i <= text.length; i++)
        expect(incremental(text.slice(0, i)), `at ${i}`).toBe(
          whole(text.slice(0, i)),
        );
    // and only a definition does that: not a link opening a line, not a tag inside a fenced block
    expect(blocks("Para.\n\nNext.\n\n[g]: h").length).toBe(1);
    expect(
      blocks("Para.\n\n[Open it](https://example.invalid/p) for\nmore").length,
    ).toBe(2);
    expect(blocks("Para.\n\n```html\n<div>x</div>").length).toBe(2);
  });

  it("settles a block only once a later block has started, and never re-cuts one", () => {
    // a paragraph, a heading, a table, a tight list, a quote, a fenced block, a setext heading and a rule
    const text = [0, 2, 4, 5, 8, 9, 3, 13].map((i) => KINDS[i]).join("\n\n");
    let before: string[] = [];
    for (let i = 1; i <= text.length; i++) {
      const settled = blocks(text.slice(0, i)).slice(0, -1);
      expect(settled.slice(0, before.length), `at ${i}`).toEqual(before);
      before = settled;
    }
    // four cuts, not seven: a list and a quote may continue past the blank line before them, so the table,
    // the list and the quote settle as one
    expect(before.length).toBe(4);
  });

  it("leaves a fence, a table and a list alone while they are still arriving", () => {
    const open = "Before it.\n\n```python\ndef f():\n\n    return 1\n";
    expect(blocks(open).length).toBe(2);
    expect(blocks(open)[1]).toContain("def f():");
    const table = "Before it.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    expect(blocks(table)[1]).toContain("| 1 | 2 |");
    const list = "- one\n\n- two\n";
    expect(blocks(list)).toEqual([remend(list)]);
  });
});
