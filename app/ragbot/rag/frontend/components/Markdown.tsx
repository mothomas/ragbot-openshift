"use client";
import { Fragment, memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fromThisSite, offSiteImage } from "@/lib/frappe";
import { blocks } from "@/lib/markdown";

const elements: Components = {
  // remend writes this placeholder for a link still arriving; show its text only
  a: ({ href, children }) =>
    href === "streamdown:incomplete-link" ? (
      <span>{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  // an image fetches with no click, and the model writes its address: one from anywhere but this
  // site would carry whatever the answer was told to put in it, so it becomes a link the reader opens
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : undefined;
    if (fromThisSite(url)) return <img src={src as string} alt={alt ?? ""} />;
    const off = offSiteImage(url);
    if (!off) return <span>{alt || "Image unavailable"}</span>;
    return (
      <>
        <a href={off.href} target="_blank" rel="noopener noreferrer">
          {alt || "Image"}
        </a>{" "}
        (image on {off.host})
      </>
    );
  },
};

// A settled block keeps the text it was handed, so its parse and its elements are kept with it
const Block = memo(function Block({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={elements}>
      {text}
    </Markdown>
  );
});

// The markdown parser and its plugins, in their own chunk: the landing has no answer on it to render, so the
// greeting need not wait for them. <MarkdownText> in parts.tsx is what the rest of the app renders.
export default function Answer({ text }: { text: string }) {
  return blocks(text).map((block, i) => (
    // the newline one parse leaves between the answer's top-level nodes
    <Fragment key={i}>
      {i > 0 && "\n"}
      <Block text={block} />
    </Fragment>
  ));
}
