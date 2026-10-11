// The Documents panel's own logic, kept out of the component so it can be read and tested on its own.

/** The five file families the --color-type-* tokens and components/FileIcons.tsx draw. */
export type Family = "pdf" | "doc" | "sheet" | "slides" | "other";

// Drive's file_type (drive/utils MIME_LIST_MAP), then the extension for a file Drive has not
// typed yet — an upload still on its way has a name and nothing else.
const OF_TYPE: Record<string, Family> = {
  PDF: "pdf",
  Document: "doc",
  "Frappe Document": "doc",
  Text: "doc",
  Code: "doc",
  "XML Data": "doc",
  Book: "doc",
  Spreadsheet: "sheet",
  Presentation: "slides",
};
const OF_EXT: Record<string, Family> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  txt: "doc",
  md: "doc",
  pages: "doc",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
};

export function familyOf(type?: string | null, title = ""): Family {
  const ext = splitName(title)[1].slice(1).toLowerCase();
  return OF_TYPE[type ?? ""] ?? OF_EXT[ext] ?? "other";
}

/** A filename split into the part that may be shortened and the extension that must survive it. */
export function splitName(title: string): [stem: string, ext: string] {
  const m = /^(.+)(\.[A-Za-z0-9]{1,10})$/.exec(title);
  return m ? [m[1], m[2]] : [title, ""];
}

/** A choice this browser remembers, in the shape lib/theme.ts remembers the colour mode. */
export function getPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private windows: the choice lasts this page only
  }
}
