"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

// The suggested reply's copy button (Graphite Button, secondary, with the CodeCard's confirm: the
// icon swaps to a check for 2 seconds).

const BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-component-on-container-strong pr-3 pl-2.5 text-body-sm font-medium text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97]";

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
    <button type="button" onClick={copy} className={`${BUTTON} self-start`}>
      {copied ? (
        <Check size={16} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}
