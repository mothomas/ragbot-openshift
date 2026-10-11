import { ASSETS } from "@/lib/peers";

export function AppMark({ className = "size-6" }: { className?: string }) {
  // Metis: Athena's olive tree in its Greek-key ring, painted in the text colour so it follows light and dark
  const url = `url(${ASSETS}/metis-emblem.svg) center / contain no-repeat`;
  return (
    <span
      aria-hidden="true"
      className={`${className} shrink-0 bg-black dark:bg-white`}
      style={{ mask: url, WebkitMask: url }}
    />
  );
}
