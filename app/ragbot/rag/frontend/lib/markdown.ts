import remend, { type RemendOptions } from "remend";

// Every chunk appends to the same answer, so formatting the whole text again per chunk costs its length
// squared. A block a later block has already started can no longer change, so it is formatted once and kept.

// Only remend's two escapes run on a settled block: everything else it does closes or trims what is still
// arriving, which a block a later block has started no longer has. Those two read remend's own backtick
// state, which the probes below make a settled block leave as it found it.
const ESCAPES: RemendOptions = {
  bold: false,
  boldItalic: false,
  htmlTags: false,
  images: false,
  inlineCode: false,
  italic: false,
  katex: false,
  links: false,
  setextHeadings: false,
  strikethrough: false,
};

const BLANK = /^[ \t]*$/;
// only a tilde fence may carry a backtick in its info string
const OPENS = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const CLOSES = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// indented, a list marker or a blockquote: the blank line before it may have been inside the block, not after it
const CONTINUES = /^(?:[ \t]|>|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;
// a link or footnote definition reaches the whole answer, and an HTML block may hold blank lines: neither is
// safe to cut, so an answer carrying one is formatted whole. A bracket that opens an inline link is neither.
const REACHES = /^ {0,3}(?:<|\[(?![^\]\n]*\]\())/;

type Scan = {
  text: string;
  done: string[];
  start: number;
  at: number;
  fence: string;
  blank: boolean;
  whole: boolean;
};

// A scan reads each line once and is settled by the text before it, so a longer text may carry on from where
// the last one stopped. ponytail: one entry, because one answer streams at a time; a miss costs a scan, not
// an answer.
let memo: Scan | null = null;

function scan(text: string): Scan {
  const s: Scan =
    memo && text.startsWith(memo.text)
      ? { ...memo, text }
      : {
          text,
          done: [],
          start: 0,
          at: 0,
          fence: "",
          blank: false,
          whole: false,
        };
  memo = s; // before the loop: a throw inside it must not leave the old entry holding a block it cut
  while (!s.whole) {
    const nl = text.indexOf("\n", s.at);
    if (nl === -1) break; // a line without its newline is still arriving
    const line = text.slice(s.at, nl);
    if (s.fence) {
      const close = CLOSES.exec(line);
      if (
        close &&
        close[1][0] === s.fence[0] &&
        close[1].length >= s.fence.length
      )
        s.fence = "";
    } else if (BLANK.test(line)) {
      s.blank = true;
    } else if (REACHES.test(line)) {
      s.whole = true;
    } else {
      if (s.blank && !CONTINUES.test(line)) cut(s);
      s.blank = false;
      const open = OPENS.exec(line);
      if (open) s.fence = open[1] ?? open[2];
    }
    s.at = nl + 1;
  }
  return s;
}

// remend closes the marker an answer ends inside, and reads every earlier marker to decide whether that one
// opens or closes. A block that changes what it does to a marker of its own reaches into the tail, so it
// does not settle yet; it settles with the tail once a later block makes it neutral.
const PROBES = ["`", "*", "**", "***", "_", "__", "~~", "$$"].map((m) => {
  const probe = `\n\n${m}z`;
  return [probe, remend(probe)] as const;
});
const neutral = (b: string) =>
  PROBES.every(([probe, alone]) => remend(b + probe) === b + alone);

function cut(s: Scan) {
  const block = remend(s.text.slice(s.start, s.at), ESCAPES);
  if (!neutral(block)) return;
  if (block.trim()) s.done.push(block); // blank lines before the answer's first block are not one
  s.start = s.at;
}

// ponytail: an answer with no blank line in it is one block and settles nothing, because cutting a paragraph
// would change what it renders as

/** The answer's settled blocks, then its tail, each ready to hand to the Markdown parser. */
export function blocks(text: string): string[] {
  const s = scan(text);
  // the line still arriving has not been read yet, and a definition on it already reaches what has settled
  return s.whole || (!s.fence && REACHES.test(text.slice(s.at)))
    ? [remend(text)]
    : [...s.done, remend(text.slice(s.start))];
}
