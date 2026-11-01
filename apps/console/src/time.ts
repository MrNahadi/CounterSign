// Times as the console shows them (brand book). Pure, and free of server-only imports, so client
// components can use them.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A length of time in whole seconds, rounded: "14s" under a minute, else "1m 08s". */
export function durationWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Relative under a week ("4m ago"), the date after (brand book). */
export function formatTime(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ago = now.getTime() - at;
  if (ago < 60_000) return "Just now";
  if (ago < 60 * 60_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < DAY_MS) return `${Math.floor(ago / (60 * 60_000))}h ago`;
  if (ago < 7 * DAY_MS) return `${Math.floor(ago / DAY_MS)}d ago`;
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
