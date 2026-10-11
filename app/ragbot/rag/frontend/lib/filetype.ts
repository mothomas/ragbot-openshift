// Which --color-type-* a file's name belongs to. The name is the one already on screen, so a source
// with no name in Drive ("Document") falls to `other` rather than guessing.
type Kind = "pdf" | "doc" | "sheet" | "slides" | "other";

const BY_EXT: Record<string, Kind> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  txt: "doc",
  md: "doc",
  markdown: "doc",
  htm: "doc",
  html: "doc",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
};

export const fileKind = (name: string): Kind =>
  // a name with no dot has no extension to read: "report" is not the extension of anything
  (name.includes(".") && BY_EXT[name.split(".").pop()!.toLowerCase()]) ||
  "other";
