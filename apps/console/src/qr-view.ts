import { encode } from "uqr";
import { z } from "zod";

// The "Open on your phone" QR code (phase 9): the approvals URL and the SVG rects drawn from
// `uqr`'s module matrix. The page draws them with token classes, so no colour value lives here.

export const QR_COPY = {
  heading: "Open on your phone",
  line: "Scan to approve from your phone.",
} as const;

/** Quiet zone, in modules, around the code. */
export const QUIET_ZONE = 4;

const HttpUrl = z.url({ protocol: /^https?$/ });

/**
 * `CONSOLE_PUBLIC_URL` plus `/approvals` when it's a valid http(s) URL, else the request's origin
 * plus `/approvals`. Null when neither is usable.
 */
export function approvalsUrl(input: {
  publicUrl: string | undefined;
  origin: string | null;
}): string | null {
  for (const base of [input.publicUrl, input.origin ?? undefined]) {
    if (base === undefined || base.trim() === "") continue;
    const parsed = HttpUrl.safeParse(base.trim());
    if (!parsed.success) continue;
    const url = new URL(parsed.data);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/approvals`;
  }
  return null;
}

/** The request's origin from its forwarding headers; Render terminates TLS in front of the app. */
export function requestOrigin(headers: { get(name: string): string | null }): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host === null || host === "") return null;
  const forwarded = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  return `${proto}://${host}`;
}

export type QrRect = { x: number; y: number; width: number };
export type QrView = {
  url: string;
  /** Side of the square viewBox, quiet zone included. */
  size: number;
  /** Runs of dark modules, one rect per run, one module tall. */
  rects: QrRect[];
  label: string;
};

export function qrView(url: string): QrView {
  const { data, size } = encode(url, { ecc: "M", border: 0 });
  const rects: QrRect[] = [];
  for (let y = 0; y < size; y++) {
    const row = data[y] ?? [];
    let start = -1;
    for (let x = 0; x <= size; x++) {
      const dark = x < size && row[x] === true;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        rects.push({ x: start + QUIET_ZONE, y: y + QUIET_ZONE, width: x - start });
        start = -1;
      }
    }
  }
  return { url, size: size + QUIET_ZONE * 2, rects, label: `QR code for ${url}` };
}
