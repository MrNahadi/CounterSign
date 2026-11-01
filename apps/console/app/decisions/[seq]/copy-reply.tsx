"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { button, ICON, STROKE } from "../../../src/controls";

// The suggested reply's copy button (Graphite Button, secondary, with the CodeCard's confirm: the
// icon swaps to a check for 2 seconds).

export function CopyReply({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`${button("secondary", "md", { icon: "leading" })} self-start`}
    >
      {copied ? (
        <Check size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
      ) : (
        <Copy size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}
