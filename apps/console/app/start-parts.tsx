"use client";

import { Play, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { button, DESCRIPTION, FIELD_ERROR, ICON, STROKE } from "../src/controls";
import {
  launchScenario,
  type ResetSentence,
  requestReset,
  type ScenarioButton,
  type ScenarioCard as ScenarioCardView,
  START_COPY,
} from "../src/start-view";
import { Card, CardHeading, Notice, Spinner } from "./ui";

// The start page's two actions (ADR 0043): a scenario card that starts a run and opens it in the
// inbox, and the demo reset behind a confirm dialog. Both talk only to the console's own routes.
// Built from Graphite's Card, Button, Dialog, Notice and Spinner specs.

export function ScenarioCard({ card }: { card: ScenarioCardView }) {
  const router = useRouter();
  const id = useId();
  const [pending, setPending] = useState<ScenarioButton["mode"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(mode: ScenarioButton["mode"]) {
    if (pending !== null) return;
    setPending(mode);
    setError(null);
    const result = await launchScenario(card.id, mode);
    if (result.ok) {
      // The button stays pending until the inbox opens.
      router.push(result.href);
      return;
    }
    setPending(null);
    setError(result.message);
    if (result.signedOut) router.refresh();
  }

  return (
    <Card as="article" aria-labelledby={`${id}-title`}>
      <CardHeading as="h3" id={`${id}-title`} title={card.title} description={card.line} />
      <p className={DESCRIPTION}>{card.lookFor}</p>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          {card.buttons.map((choice) => (
            <button
              key={choice.mode}
              type="button"
              onClick={() => run(choice.mode)}
              disabled={pending !== null}
              aria-busy={pending === choice.mode ? true : undefined}
              aria-describedby={error !== null ? `${id}-error` : undefined}
              className={button(choice.variant, "md", { icon: "leading" })}
            >
              {pending === choice.mode ? (
                <Spinner size={ICON.md} />
              ) : (
                <Play size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
              )}
              {choice.label}
            </button>
          ))}
        </div>
        {error !== null ? (
          <p id={`${id}-error`} role="alert" className={FIELD_ERROR}>
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

const COPY = START_COPY.reset;

export function ResetDemo() {
  const router = useRouter();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ResetSentence | null>(null);

  async function confirm() {
    if (pending) return;
    setPending(true);
    const answer = await requestReset();
    setPending(false);
    dialog.current?.close();
    setResult({ sentence: answer.sentence, tone: answer.tone });
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-5">
      <button
        type="button"
        onClick={() => {
          setResult(null);
          dialog.current?.showModal();
        }}
        className={button("danger-subtle", "md", { icon: "leading" })}
      >
        <RotateCcw size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
        {COPY.button}
      </button>
      {result !== null ? <Notice tone={result.tone}>{result.sentence}</Notice> : null}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        // A reset under way can't be dismissed; its answer closes the dialog.
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        className="mx-0 mt-auto mb-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-3xl bg-modal p-7 text-primary-foreground shadow-xl backdrop:bg-overlay sm:m-auto sm:w-md sm:max-w-[calc(100vw-32px)] sm:rounded-3xl"
      >
        <div
          aria-hidden="true"
          className="mx-auto -mt-4 mb-4 h-1 w-8 rounded-full bg-border-strong sm:hidden"
        />
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h2 id={`${id}-title`} className="text-heading-6 font-semibold tracking-heading">
              {COPY.dialogTitle}
            </h2>
            <p id={`${id}-desc`} className={`${DESCRIPTION} leading-code-sm`}>
              {COPY.dialogDescription}
            </p>
          </header>
          <footer className="flex justify-end gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => dialog.current?.close()}
              className={button("secondary", "lg")}
            >
              {COPY.cancel}
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={pending}
              aria-busy={pending ? true : undefined}
              className={button("danger", "lg", { icon: "leading" })}
            >
              {pending ? (
                <Spinner size={ICON.lg} />
              ) : (
                <RotateCcw size={ICON.lg} strokeWidth={STROKE(ICON.lg)} aria-hidden="true" />
              )}
              {pending ? COPY.pending : COPY.confirm}
            </button>
          </footer>
        </div>
      </dialog>
    </div>
  );
}
