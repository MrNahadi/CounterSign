"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { DISPUTES_COPY, draftAgain } from "../../src/disputes-view";
import { Spinner } from "../ui";

// "Draft again" on a failed draft (Graphite Button, secondary, small): posts to the console's
// route, then reloads the page's rows. A refusal shows its one sentence under the button.

const BUTTON =
  "inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg bg-component-on-container-strong pr-2 pl-1.5 text-body-sm font-medium text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground disabled:shadow-none motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97]";

export function DraftAgain({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function click() {
    if (pending) return;
    setPending(true);
    const result = await draftAgain(disputeId);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={click}
        disabled={pending}
        aria-busy={pending ? true : undefined}
        aria-describedby={error !== null ? `${id}-error` : undefined}
        className={BUTTON}
      >
        {pending ? (
          <Spinner size={14} />
        ) : (
          <RotateCw size={14} strokeWidth={1.5} aria-hidden="true" />
        )}
        <span>{DISPUTES_COPY.draftAgain}</span>
        <span className="sr-only">{` for ${disputeId}`}</span>
      </button>
      {error !== null ? (
        <p id={`${id}-error`} role="alert" className="text-caption-lg text-danger-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
