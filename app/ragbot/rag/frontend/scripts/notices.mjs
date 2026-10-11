// `yarn licenses generate-disclaimer` alone is not enough: it drops every package with no file named
// license* or unlicense*, one of which is under LGPL-3.0-or-later. This appends what it dropped.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const yarn = (...args) =>
  execFileSync("yarn", ["-s", "licenses", ...args, "--production"], {
    cwd: app,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });

const table = yarn("list", "--json")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((o) => o.type === "table").data;
const at = Object.fromEntries(table.head.map((h, i) => [h, i]));

const files = (name) => {
  try {
    return readdirSync(join(app, "node_modules", name));
  } catch {
    return [];
  }
};
const pick = (name, re) => files(name).find((f) => re.test(f));
// yarn's own rule, so that "what yarn skipped" here means exactly what it skipped
const yarnFinds = (name) => pick(name, /^(un)?license($|\.)/i);

const missed = [];
for (const row of table.body) {
  const name = row[at.Name];
  if (yarnFinds(name)) continue;
  const spdx = row[at.License];
  if (!spdx || spdx === "UNKNOWN")
    throw new Error(
      `${name}@${row[at.Version]} ships no licence file and declares no licence, so it cannot be attributed.`,
    );
  const other = pick(name, /^(licen[cs]e|copying|notice)/i);
  const text = other
    ? readFileSync(join(app, "node_modules", name, other), "utf8").trim()
    : `No licence file was found for this package. Its manifest declares ${spdx}.`;
  missed.push(
    `The following software may be included in this product: ${name}. ` +
      `A copy of the source code may be downloaded from ${row[at.URL] || row[at.VendorUrl] || "its registry entry"}. ` +
      `This software contains the following license and notice below:\n\n${text}\n`,
  );
}

writeFileSync(
  join(app, "rag", "public", "ask", "THIRD-PARTY-NOTICES.txt"),
  [yarn("generate-disclaimer").trimEnd(), ...missed].join("\n\n-----\n\n") +
    "\n",
);
