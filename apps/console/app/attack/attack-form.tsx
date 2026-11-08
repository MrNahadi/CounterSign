"use client";

import { CircleAlert, LoaderCircle, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import {
  ATTACK_CHANNELS,
  ATTACK_COPY,
  type AttackField,
  attackRequest,
  sendAttack,
} from "../../src/attack";
import {
  ALERT,
  button,
  FIELD,
  FORM,
  ICON,
  INPUT,
  INPUT_HEIGHT,
  LABEL,
  STROKE,
  TEXTAREA,
} from "../../src/controls";
import { MAX_BODY_CHARS } from "../../src/resolve-schemas";
import { Field, Segmented } from "../inbox/inbox-header";
import { Card } from "../ui";

// The visitor's attack: a sender, a channel and a message, sent to Resolve in protected mode
// through `POST /api/attack`. Built from Graphite's Input, Textarea, Segmented control and Button
// specs, as the inbox's composer is. On success the page opens the attack's result.

type Problem = { field: AttackField; problem: string } | null;

export function AttackForm() {
  const router = useRouter();
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;
  const [channel, setChannel] = useState<"email" | "chat">("email");
  const [senderEmail, setSenderEmail] = useState("");
  const [body, setBody] = useState("");
  const [problem, setProblem] = useState<Problem>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const errorFor = (field: AttackField) => (problem?.field === field ? problem.problem : null);
  const invalid = (field: AttackField) => ({
    "aria-invalid": problem?.field === field ? true : undefined,
    "aria-describedby": id(`${field}-help`),
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setSendError(null);
    const composed = attackRequest({ channel, senderEmail, body });
    if (!composed.ok) {
      setProblem({ field: composed.field, problem: composed.problem });
      return;
    }
    setProblem(null);
    setPending(true);
    const sent = await sendAttack(composed.request);
    setPending(false);
    if (!sent.ok) {
      if (sent.signedOut === true) router.refresh();
      setSendError(sent.message);
      return;
    }
    router.push(`/attack?thread=${encodeURIComponent(sent.threadId)}`);
  }

  return (
    <Card as="section" aria-label="Write an attack">
      <form noValidate onSubmit={submit} className="flex flex-col gap-6">
        <div className={FORM}>
          <div className={FIELD}>
            <span className={LABEL}>{ATTACK_COPY.channelLabel}</span>
            <div>
              <Segmented
                label={ATTACK_COPY.channelLabel}
                options={ATTACK_CHANNELS}
                value={channel}
                onChange={setChannel}
              />
            </div>
          </div>

          <Field
            id={id("senderEmail")}
            label={ATTACK_COPY.senderLabel}
            help={ATTACK_COPY.senderHelp}
            error={errorFor("senderEmail")}
          >
            <input
              id={id("senderEmail")}
              type="email"
              autoComplete="off"
              placeholder="customer@example.com"
              value={senderEmail}
              onChange={(event) => setSenderEmail(event.target.value)}
              className={`${INPUT} ${INPUT_HEIGHT.default}`}
              {...invalid("senderEmail")}
            />
          </Field>

          <Field
            id={id("body")}
            label={ATTACK_COPY.messageLabel}
            help={ATTACK_COPY.messageHelp}
            error={errorFor("body")}
          >
            <textarea
              id={id("body")}
              rows={6}
              maxLength={MAX_BODY_CHARS}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className={TEXTAREA}
              {...invalid("body")}
            />
          </Field>

          {sendError !== null ? (
            <p role="alert" className={ALERT.danger}>
              <CircleAlert
                size={ICON.md}
                strokeWidth={STROKE(ICON.md)}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              <span>{sendError}</span>
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            aria-busy={pending ? true : undefined}
            disabled={pending}
            className={button("primary", "lg", { icon: "leading" })}
          >
            {pending ? (
              <LoaderCircle
                size={ICON.lg}
                strokeWidth={STROKE(ICON.lg)}
                aria-hidden="true"
                className="motion-safe:animate-[spin_800ms_linear_infinite]"
              />
            ) : (
              <Send size={ICON.lg} strokeWidth={STROKE(ICON.lg)} aria-hidden="true" />
            )}
            {pending ? ATTACK_COPY.sending : ATTACK_COPY.send}
          </button>
        </div>
      </form>
    </Card>
  );
}
