import { failureMessage } from "./format";
import { DRIVE, FRAPPE_AI } from "./peers";

type Boot = {
  user: string;
  full_name: string;
  first_name: string; // rag/www/ask.py splits it, so the page and the app never split it differently
  csrf_token: string;
  site_name: string;
  time_zone: string;
  currency: string;
  status_panel: boolean; // rag/www/ask.py reads rag_status_panel from the site's config
};

declare global {
  interface Window {
    boot?: Boot;
  }
}

// `base` only so this can be tested off a browser; in the page it is always the page's own URL
export function fromThisSite(
  url: string | undefined,
  base = location.href,
): boolean {
  if (!url) return false;
  try {
    return new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** The address a reader may open by hand: http or https, and not this site's own. Null for anything else. */
export function offSiteImage(
  url: string | undefined,
  base = location.href,
): URL | null {
  if (!url || fromThisSite(url, base)) return null;
  try {
    const resolved = new URL(url, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved
      : null;
  } catch {
    return null;
  }
}

export function boot(): Boot {
  return (
    window.boot ?? {
      user: "Guest",
      full_name: "Guest",
      first_name: "Guest",
      csrf_token: "",
      site_name: "",
      time_zone: "UTC",
      currency: "",
      status_panel: true,
    }
  );
}

// the export names nobody, so Frappe fills this slot with the reader's name when it serves the page
// (scripts/place.mjs writes the Jinja, rag/www/ask.py supplies the name)
const NAME_SLOT = "__METIS_FIRST_NAME__";

export const firstName = (): string =>
  typeof window === "undefined" ? NAME_SLOT : boot().first_name;

export class FrappeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function messageOf(
  body: Record<string, unknown>,
  status: number,
): string {
  try {
    const first = JSON.parse(String(body._server_messages ?? "[]"))[0];
    if (first) return String(JSON.parse(first).message).replace(/<[^>]+>/g, "");
  } catch {
    // not JSON; fall through to what the status says
  }
  return failureMessage(status);
}

// One uuid per request: the shape Frappe's monitor adopts as that transaction's trace id, returns on the
// response and puts on its Error Log rows (ADR-008). Empty where crypto.randomUUID is absent, which is off
// a secure context, because a request with no id beats no request at all.
export const requestId = (): Record<string, string> =>
  crypto.randomUUID ? { "X-Frappe-Request-Id": crypto.randomUUID() } : {};

async function send<T>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, {
    ...init,
    // last, so a caller's own headers cannot drop the id this request is known by
    headers: { Accept: "application/json", ...init.headers, ...requestId() },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new FrappeError(r.status, messageOf(body ?? {}, r.status));
  // a 2xx that is not JSON is a proxy's or a login page, not Frappe's answer
  if (body === null) throw new FrappeError(r.status, failureMessage(r.status));
  return body as T;
}

const query = (args: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(args).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );

export async function get<T>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await send<{ message: T }>(`/api/method/${method}?${query(args)}`))
    .message;
}

export async function post<T>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (
    await send<{ message: T }>(`/api/method/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": boot().csrf_token,
      },
      body: JSON.stringify(args),
    })
  ).message;
}

export async function list<T>(
  doctype: string,
  p: {
    fields: string[];
    filters?: unknown[];
    order_by?: string;
    limit?: number;
    start?: number;
  },
): Promise<T[]> {
  const q = query({
    fields: p.fields,
    order_by: p.order_by ?? "modified desc",
    limit: String(p.limit ?? 100),
    limit_start: String(p.start ?? 0),
  });
  if (p.filters) q.set("filters", JSON.stringify(p.filters));
  return (
    await send<{ data: T[] }>(
      `/api/resource/${encodeURIComponent(doctype)}?${q}`,
    )
  ).data;
}

// a file for one chat only: private, attached to the chat by name (the chat itself may not exist
// until the first question; Frappe links the file when it does), and never put in Drive
export async function attach(
  session: string,
  file: File,
): Promise<{ name: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("is_private", "1");
  form.append("doctype", FRAPPE_AI.session);
  form.append("docname", session);
  const body = await send<{ message: { name: string } }>(
    "/api/method/upload_file",
    {
      method: "POST",
      headers: { "X-Frappe-CSRF-Token": boot().csrf_token },
      body: form,
    },
  );
  return body.message;
}

// XMLHttpRequest, not fetch: fetch cannot report upload progress. rag's File hook indexes the new file.
export function driveUpload(
  file: File,
  team: string,
  parent: string,
  onProgress: (share: number) => void,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("team", team);
  form.append("parent", parent);
  form.append("total_file_size", String(file.size));
  form.append("file_modified", String(file.lastModified));
  form.append("uuid", crypto.randomUUID()); // Drive names its temporary upload after this
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/method/${DRIVE.upload}`);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Frappe-CSRF-Token", boot().csrf_token);
    for (const [k, v] of Object.entries(requestId()))
      xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) {
        try {
          return resolve(JSON.parse(xhr.responseText).message.name);
        } catch {
          return reject(
            new FrappeError(
              xhr.status,
              "Upload failed. Check the connection and try again.",
            ),
          );
        }
      }
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: the status says enough
      }
      reject(new FrappeError(xhr.status, messageOf(body, xhr.status)));
    };
    xhr.onerror = () =>
      reject(
        new FrappeError(
          0,
          "Upload failed. Check the connection and try again.",
        ),
      );
    xhr.send(form);
  });
}
