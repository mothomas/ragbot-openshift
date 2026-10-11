"use client";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/solid";
import { requestId } from "@/lib/frappe";
import { useState } from "react";
import { AppMark } from "./Mark";

export default function SignIn() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const r = await fetch("/api/method/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...requestId(),
      },
      body: JSON.stringify({
        usr: form.get("email"),
        pwd: form.get("password"),
      }),
    }).catch(() => null);
    if (!r) {
      setError("Sign in failed. Try again.");
      return setBusy(false);
    }
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.message === "Logged In") return location.reload();
    if (r.ok) return location.assign("/login?redirect-to=/ask"); // two-factor or reset: Frappe finishes it
    setError(
      r.status === 401
        ? "Incorrect email or password."
        : "Sign in failed. Try again.",
    );
    setBusy(false);
  }

  const field =
    "text-sm bg-transparent outline-hidden placeholder:text-gray-600 dark:placeholder:text-gray-400";
  return (
    // the fields and button sit in the window's centre, the emblem and title above them; equal
    // padding keeps their room (80 + 24 + 32 + 20 px) on short windows without moving the centre
    <main className="relative min-h-dvh flex py-39 bg-white dark:bg-black text-black dark:text-gray-100">
      <form
        onSubmit={submit}
        className="relative m-auto w-full max-w-md px-4 md:px-0 flex flex-col"
      >
        <div className="absolute bottom-full inset-x-0 mb-5 flex flex-col items-center">
          {/* the full emblem, large enough that its Greek-key ring is drawn in whole pixels */}
          <AppMark className="block size-20 mb-6" />
          <h1 className="text-2xl text-center">Sign in to Metis</h1>
        </div>
        <label className="text-sm" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="text"
          autoComplete="username"
          required
          placeholder="Enter your email"
          className={`mt-[7px] ${field}`}
        />
        <label className="mt-2.5 text-sm" htmlFor="password">
          Password
        </label>
        <div className="mt-1.5 flex items-center">
          <input
            id="password"
            name="password"
            type={shown ? "text" : "password"}
            autoComplete="current-password"
            required
            placeholder="Enter your password"
            className={`flex-1 ${field}`}
          />
          <button
            type="button"
            aria-label={shown ? "Hide password" : "Show password"}
            onClick={() => setShown((s) => !s)}
            className="size-7 grid place-items-center"
          >
            {shown ? (
              <EyeSlashIcon className="size-4" />
            ) : (
              <EyeIcon className="size-4" />
            )}
          </button>
        </div>
        {error && (
          <p
            role="alert"
            className="mt-3 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
        <button
          disabled={busy}
          className="mt-[22px] h-10 rounded-full text-sm bg-gray-700/5 hover:bg-gray-700/10 dark:bg-gray-100/5 dark:hover:bg-gray-100/10 dark:text-gray-300 transition disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
