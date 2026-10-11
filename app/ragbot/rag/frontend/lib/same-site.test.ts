import { describe, expect, it } from "vitest";
import { fromThisSite, offSiteImage } from "./frappe";

// An answer's markdown image is fetched with no click, and an injected document decides its address,
// so it may only come from this site (OWASP LLM05, improper output handling).
const HERE = "http://audit.localhost:8081/ask";

describe("an image in an answer loads only from this site", () => {
  it("keeps this site's own images, however they are written", () => {
    for (const src of [
      "/files/leave-policy.png",
      "chart.png",
      "http://audit.localhost:8081/api/method/rag.preview?f=1",
      "//audit.localhost:8081/x.png",
    ])
      expect(fromThisSite(src, HERE), src).toBe(true);
  });

  it("refuses anywhere else, including the exfiltration shape", () => {
    for (const src of [
      "https://attacker.example/p.gif?q=PELICAN-7",
      "http://audit.localhost:8080/x.png", // another port is another origin
      "https://audit.localhost:8081/x.png", // another scheme is another origin
      "http://evil.audit.localhost:8081/x.png",
      "",
      undefined,
    ])
      expect(fromThisSite(src, HERE), String(src)).toBe(false);
  });
});

describe("an image from another site", () => {
  const base = "https://audit.localhost:8081/ask";

  it("is a link the reader can open, which names the site", () => {
    const off = offSiteImage(
      "https://images.example.com/chart.png?q=secret",
      base,
    );
    expect(off?.href).toBe("https://images.example.com/chart.png?q=secret");
    expect(off?.host).toBe("images.example.com");
  });

  it("is not a link when this site serves it, or when no browser could fetch it", () => {
    expect(offSiteImage("/files/chart.png", base)).toBeNull();
    expect(offSiteImage("data:image/png;base64,AAAA", base)).toBeNull();
    expect(offSiteImage("javascript:alert(1)", base)).toBeNull();
    expect(offSiteImage(undefined, base)).toBeNull();
  });
});
