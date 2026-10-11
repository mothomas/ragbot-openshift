"use client";
import { useEffect, useState } from "react";
import { get } from "./frappe";

type Doc = {
  name: string;
  file_name: string;
  owner: string;
  modified: string;
  file_size: number | null;
  mime_type: string | null;
  indexed: boolean;
};

let cache: Promise<Doc[]> | null = null;

export function documents(refresh = false): Promise<Doc[]> {
  if (refresh || !cache) {
    const load = get<Doc[]>("rag.library.documents");
    load.catch(() => {
      if (cache === load) cache = null; // one failed load must not answer for the page's life
    });
    cache = load;
  }
  return cache;
}

// `refresh` moves after Documents changes Drive, so names and counts elsewhere follow.
// `docs` is null until the first load lands; `failed` says the load did not arrive.
export function useDocuments(refresh = 0): {
  docs: Doc[] | null;
  failed: boolean;
} {
  const [state, setState] = useState<{ docs: Doc[] | null; failed: boolean }>({
    docs: null,
    failed: false,
  });
  useEffect(() => {
    documents(refresh > 0).then(
      (docs) => setState({ docs, failed: false }),
      () => setState((s) => ({ ...s, failed: true })),
    );
  }, [refresh]);
  return state;
}
