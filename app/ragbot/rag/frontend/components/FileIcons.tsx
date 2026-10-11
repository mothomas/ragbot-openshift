// Five glyphs copied from Tabler Icons rather than taken as a dependency: file-type-pdf, file-text,
// file-spreadsheet, presentation and file, at their published 24x24 outline geometry. One distinct
// shape per family — the tint never carries the meaning on its own. No vendor's own icon artwork.
//
// MIT License
//
// Copyright (c) 2020-2026 Paweł Kuna
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// https://github.com/tabler/tabler-icons

import type { Family } from "@/lib/documents";

const SHEET = "M14 3v4a1 1 0 0 0 1 1h4";
const PAGE =
  "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2";

export const GLYPHS: Record<Family, string[]> = {
  // tabler/file-type-pdf: the page cut short above the letters P, D and F
  pdf: [
    SHEET,
    "M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4",
    "M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6",
    "M17 18h2",
    "M20 15h-3v6",
    "M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1",
  ],
  // tabler/file-text: the page with three lines of writing
  doc: [SHEET, PAGE, "M9 9l1 0", "M9 13l6 0", "M9 17l6 0"],
  // tabler/file-spreadsheet: the page with a table of cells
  sheet: [SHEET, PAGE, "M8 11h8v7h-8l0 -7", "M8 15h8", "M11 11v7"],
  // tabler/presentation: a screen on a stand, not a page at all
  slides: [
    "M3 4l18 0",
    "M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-10",
    "M12 16l0 4",
    "M9 20l6 0",
    "M8 12l3 -3l2 2l3 -3",
  ],
  // tabler/file: the bare page
  other: [SHEET, PAGE],
};

// Tailwind reads these class names from the source, so each one is written out.
const TINT: Record<Family, string> = {
  pdf: "text-type-pdf",
  doc: "text-type-doc",
  sheet: "text-type-sheet",
  slides: "text-type-slides",
  other: "text-type-other",
};

// aria-hidden: the filename beside it already ends in the extension, so the glyph adds no meaning
// a reader would otherwise miss (WCAG 2.2 1.4.1).
export function FileIcon({
  family,
  className = "",
}: {
  family: Family;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${TINT[family]} ${className}`}
    >
      {GLYPHS[family].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
