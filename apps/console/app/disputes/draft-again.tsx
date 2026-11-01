"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { button, FIELD_ERROR, ICON, STROKE } from "../../src/controls";
import { DISPUTES_COPY, draftAgain } from "../../src/disputes-view";
import { Spinner } from "../ui";

// "Draft again" on a failed draft (Graphite Button, secondary, small): posts to the console's
// route, then reloads the page's rows. A refusal shows its one sentence under the button.

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
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={click}
        disabled={pending}
        aria-busy={pending ? true : undefined}
        aria-describedby={error !== null ? `${id}-error` : undefined}
        className={button("secondary", "sm", { icon: "leading" })}
      >
        {pending ? (
          <Spinner size={ICON.sm} />
        ) : (
          <RotateCw size={ICON.sm} strokeWidth={STROKE(ICON.sm)} aria-hidden="true" />
        )}
        <span>{DISPUTES_COPY.draftAgain}</span>
        <span className="sr-only">{` for ${disputeId}`}</span>
      </button>
      {error !== null ? (
        <p id={`${id}-error`} role="alert" className={FIELD_ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
