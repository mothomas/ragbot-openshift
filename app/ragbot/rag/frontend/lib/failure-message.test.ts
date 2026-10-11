import { afterEach, describe, expect, it, vi } from "vitest";
import { failureMessage } from "./format";
import { FrappeError, get, messageOf } from "./frappe";

// answers the audit stack returned for calls Metis makes (evidence/C30/bodies.json)
const LIVE_500 = {
  exception:
    "TypeError: create_folder() missing 1 required positional argument: 'file_name'",
  exc_type: "TypeError",
};
const LIVE_404 = {
  _server_messages: JSON.stringify([
    JSON.stringify({
      message: "File no-such-file not found",
      raise_exception: 1,
    }),
  ]),
  exc_type: "DoesNotExistError",
};

afterEach(() => vi.unstubAllGlobals());

describe("what a reader is told when a request fails", () => {
  it("never shows the traceback line Frappe puts in `exception`", () => {
    const said = messageOf(LIVE_500, 500);
    expect(said).not.toContain("create_folder");
    expect(said).not.toContain("TypeError");
    expect(said).toBe(failureMessage(500));
  });

  it("says what to do for each status, never a bare code", () => {
    for (const status of [401, 403, 404, 413, 429, 500, 502, 417]) {
      const said = failureMessage(status);
      expect(said, `${status}`).not.toMatch(/\d{3}/);
      expect(said, `${status}`).toMatch(/\. .+\.$/); // what happened, then what to do
    }
    expect(
      new Set([401, 403, 404, 413, 429, 500].map(failureMessage)).size,
    ).toBe(6);
  });

  it("keeps the message Frappe wrote for the user", () => {
    expect(messageOf(LIVE_404, 404)).toBe("File no-such-file not found");
  });

  it("hands the caller the sentence, not the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(LIVE_500), { status: 500 }),
      ),
    );
    await expect(get("drive.api.files.create_folder")).rejects.toThrow(
      failureMessage(500),
    );
    await expect(get("drive.api.files.create_folder")).rejects.toBeInstanceOf(
      FrappeError,
    );
  });
});
