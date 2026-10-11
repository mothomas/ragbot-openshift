export type Mode = "system" | "light" | "dark";

export function getMode(): Mode {
  try {
    return (localStorage.getItem("theme") as Mode) || "system";
  } catch {
    return "system";
  }
}

export function setMode(mode: Mode): void {
  try {
    localStorage.setItem("theme", mode);
  } catch {
    // private windows: the choice lasts this page only
  }
  apply(mode);
}

export function apply(mode: Mode = getMode()): void {
  const dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
