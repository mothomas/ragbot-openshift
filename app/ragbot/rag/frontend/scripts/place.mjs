// ask.html is a Jinja template: {% raw %} keeps Next's output from being read as Jinja, but for the boot line
// and for the reader's name in the greeting the export already carries drawn.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const front = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(front, "out");
const app = join(front, "..", "rag");
const assets = join(app, "public", "ask");

// lib/frappe.ts writes this into the greeting the export draws; the reader's name is the one thing about the
// first view the build cannot know. A rename on either side leaves it unreplaced, which the count below catches.
const NAME_SLOT = "__METIS_FIRST_NAME__";

rmSync(assets, { recursive: true, force: true });
cpSync(out, assets, {
  recursive: true,
  filter: (src) => !/\.(html|txt)$/.test(src),
});

// Everything about the reader that only their own browser knows, read before the first pixel so the first
// view the page carries is theirs: the theme they chose, the width they left the sidebar at, and whether this
// URL is the landing at all — a chat, the documents view and a signed-out reader each open on something else.
const first =
  "(function(){var r=document.documentElement;try{" +
  "var t=localStorage.getItem('theme')||'system';" +
  "var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);" +
  "r.classList.toggle('dark',d);" +
  "if(localStorage.getItem('sidebar')==='open')r.dataset.sidebar='open'}catch(e){}" +
  "var p=new URLSearchParams(location.search);" +
  "if(p.get('c')||p.get('view')==='documents'||(window.boot||{}).user==='Guest')" +
  "r.dataset.firstView='off'})()";
const boot = `{% endraw %}<script>window.boot={{ boot_json | safe }};${first}</script>{% raw %}`;
const html = readFileSync(join(out, "index.html"), "utf8").replace(
  "<head>",
  `<head>${boot}`,
);
const carried = html.split(NAME_SLOT).length - 1;
if (carried !== 1)
  throw new Error(
    `the exported greeting must carry ${NAME_SLOT} exactly once for Frappe to fill in, and carries it ` +
      `${carried} times. See lib/frappe.ts and components/FirstView.tsx.`,
  );
writeFileSync(
  join(app, "www", "ask.html"),
  `{% raw %}${html.replace(NAME_SLOT, "{% endraw %}{{ first_name }}{% raw %}")}{% endraw %}`,
);
