import { describe, expect, it } from "vitest";
import { failureMessage } from "./format";
import { messageOf } from "./frappe";

// Frappe puts its own message in `_server_messages`, a JSON array of JSON strings each holding a
// `message` that may carry markup; everything else about the failure is internal (ADR-019, C30).
// lib/failure-message.test.ts holds two bodies captured live; these are the envelopes it lacks.
const envelope = (...messages: object[]) =>
  JSON.stringify(messages.map((m) => JSON.stringify(m)));

describe("messageOf", () => {
  it("takes the first message when Frappe sent several", () => {
    expect(
      messageOf(
        {
          _server_messages: envelope(
            { message: "First" },
            { message: "Second" },
          ),
        },
        417,
      ),
    ).toBe("First");
  });

  it("strips the markup Frappe wraps its messages in", () => {
    expect(
      messageOf(
        {
          _server_messages: envelope({
            message: "<b>File</b> not <i>found</i>",
            title: "Message",
          }),
        },
        417,
      ),
    ).toBe("File not found");
  });

  it("says what the status says when there is no message it can read", () => {
    // a proxy's HTML error page, or a half-written body
    for (const body of [
      { _server_messages: "<html>502 Bad Gateway</html>" },
      { _server_messages: '["{\\"message\\": \\"cut o' },
      { _server_messages: "[]" },
    ])
      expect(messageOf(body, 502)).toBe(failureMessage(502));
  });

  it("prefers Frappe's message over the status when both are there", () => {
    // failure-message.test.ts's live 404 body carries exc_type but no `exception`, so only this
    // says which of the two wins
    const said = messageOf(
      {
        _server_messages: envelope({ message: "Not permitted" }),
        exception: "frappe.exceptions.PermissionError",
      },
      403,
    );
    expect(said).toBe("Not permitted");
    expect(said).not.toBe(failureMessage(403));
  });
});
