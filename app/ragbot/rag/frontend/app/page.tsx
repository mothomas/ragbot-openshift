"use client";
import { useSyncExternalStore } from "react";
import App from "@/components/App";
import FirstView from "@/components/FirstView";

const fixed = () => () => {};

// static, not next/dynamic: ssr:false would keep the app's chunk out of the exported HTML, and the browser
// would only ask for it a round trip later (H03)
export default function Page() {
  const inBrowser = useSyncExternalStore(
    fixed,
    () => true,
    () => false,
  );
  return inBrowser ? <App /> : <FirstView />;
}
