import "@fontsource-variable/inter";
import "./globals.css";
import type { Metadata } from "next";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS } from "@/lib/peers";

// the icon's own hash in its URL: browsers, Safari above all, keep a favicon past a change
const v = createHash("sha256")
  .update(readFileSync(join(process.cwd(), "frontend/public/favicon.svg")))
  .digest("hex")
  .slice(0, 8);
const icon = (file: string) => `${ASSETS}/${file}?v=${v}`;

export const metadata: Metadata = {
  title: "Metis",
  icons: {
    icon: [
      { url: icon("favicon.svg"), type: "image/svg+xml" },
      { url: icon("favicon-32.png"), sizes: "32x32", type: "image/png" },
    ],
    apple: icon("apple-touch-icon.png"),
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // the boot script sets the theme class before React loads, so the first paint is right
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="text-gray-700 dark:text-gray-100 bg-white dark:bg-gray-900">
        {children}
      </body>
    </html>
  );
}
