"use client";

import { CircleAlert, FileSignature, LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { ALERT, button, ICON, LINK, STROKE, SUB_LINE, TEXTAREA } from "../../src/controls";
import {
  type Call,
  type CompileAnswerView,
  compileRules,
  flipView,
  MANDATE_COPY,
  MAX_RULES_CHARS,
  type Replay,
  replayDraft,
  replaySummary,
  type Signed,
  signDraft,
} from "../../src/mandate-editor";
import { Field } from "../inbox/inbox-header";
import { Badge, Card, Code, Notice, Section, Sections, Working } from "../ui";
import { DiffCard, ReadBackCard } from "./read-back";

// The merchant's rules in plain English, compiled (PLAN E1), then read back, diffed against the
// mandate in force, replayed against the audit log's decisions and signed as the next version
// (PLAN E2). Built from Graphite's Textarea, Button, Badge and Card specs, as the attack form.

function Alert({ message }: { message: string }) {
  return (
    <p role="alert" className={ALERT.danger}>
      <CircleAlert
        size={ICON.md}
        strokeWidth={STROKE(ICON.md)}
        aria-hidden="true"
        className="mt-0.5 shrink-0"
      />
      <span>{message}</span>
    </p>
  );
}

function Spin() {
  return (
    <LoaderCircle
      size={ICON.lg}
      strokeWidth={STROKE(ICON.lg)}
      aria-hidden="true"
      className="motion-safe:animate-[spin_800ms_linear_infinite]"
    />
  );
}

function Flips({ replay }: { replay: Call<Replay> | null }) {
  if (replay === null) return <Working label={MANDATE_COPY.replaying} />;
  if (!replay.ok) return <Notice>{replay.message}</Notice>;
  const flips = replay.value.flips.map(flipView);
  return (
    <div className="flex flex-col gap-5">
      <div
        className="flex flex-col gap-1.5 text-body-sm text-primary-foreground"
        aria-live="polite"
      >
        {replaySummary(replay.value).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {flips.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {flips.map((flip) => (
            <li key={flip.key}>
              <Card as="article" variant="nested" aria-label={`${flip.title} ${flip.amount}`}>
                <span className="flex flex-wrap items-center gap-2 text-body-sm">
                  <Code>{flip.title}</Code>
                  <span className="tabular-nums text-primary-foreground">{flip.amount}</span>
                  <Badge tone={flip.before.tone}>{flip.before.label}</Badge>
                  <span className="text-secondary-foreground">to</span>
                  <Badge tone={flip.after.tone}>{flip.after.label}</Badge>
                </span>
                {flip.reasons.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-body-sm">
                    {flip.reasons.map((reason) => (
                      <li key={reason.code}>
                        <span className="text-primary-foreground">{reason.detail}</span>{" "}
                        <Code>{reason.code}</Code>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <span className={SUB_LINE}>
                  {flip.ticket !== null ? `Ticket ${flip.ticket}. ` : ""}
                  <Link href={flip.href} className={LINK}>
                    Decision #{flip.key}
                  </Link>
                </span>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SignPanel({ draft }: { draft: CompileAnswerView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Call<Signed> | null>(null);
  const version = draft.mandate.version;

  async function sign() {
    if (pending) return;
    setPending(true);
    const signed = await signDraft(draft.mandate, draft.base.hash);
    setPending(false);
    if (!signed.ok && signed.signedOut === true) router.refresh();
    setResult(signed);
  }

  return (
    <Card>
      <p className="text-body-sm text-secondary-foreground">{MANDATE_COPY.signLine(version)}</p>
      {result !== null && !result.ok ? <Alert message={result.message} /> : null}
      {result?.ok === true ? (
        <Notice tone="positive">
          {result.value.already_signed
            ? MANDATE_COPY.alreadySigned(result.value.version, result.value.seq)
            : MANDATE_COPY.signed(result.value.version, result.value.seq)}{" "}
          <Link href="/audit" className={LINK}>
            {MANDATE_COPY.openAuditLog}
          </Link>
        </Notice>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={sign}
            aria-busy={pending ? true : undefined}
            disabled={pending}
            className={button("primary", "lg", { icon: "leading" })}
          >
            {pending ? (
              <Spin />
            ) : (
              <FileSignature size={ICON.lg} strokeWidth={STROKE(ICON.lg)} aria-hidden="true" />
            )}
            {pending ? MANDATE_COPY.signing : MANDATE_COPY.sign(version)}
          </button>
        </div>
      )}
    </Card>
  );
}

function Draft({ draft, replay }: { draft: CompileAnswerView; replay: Call<Replay> | null }) {
  const { items, unchangedRules } = draft.diff;
  return (
    <Sections>
      <Section id="read-back" title={MANDATE_COPY.readBack} description={MANDATE_COPY.modelLine}>
        <div className="flex flex-col gap-5">
          <ReadBackCard
            readBack={draft.readBack}
            title={`Version ${draft.mandate.version} (draft)`}
            description={MANDATE_COPY.readBackLine}
            hash={draft.hash}
          />
          {draft.leftOut.length > 0 ? (
            <Card aria-label={MANDATE_COPY.leftOut} gap="tight">
              <p className="text-body-sm font-medium text-primary-foreground">
                {MANDATE_COPY.leftOut}
              </p>
              <p className={SUB_LINE}>{MANDATE_COPY.leftOutLine}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-primary-foreground">
                {draft.leftOut.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </Section>
      <Section
        id="changes"
        title={MANDATE_COPY.changes}
        description={MANDATE_COPY.unchangedRules(unchangedRules)}
      >
        {items.length === 0 ? (
          <Notice>{MANDATE_COPY.noChanges}</Notice>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <DiffCard key={`${item.area}-${item.id}`} item={item} />
            ))}
          </div>
        )}
      </Section>
      <Section id="flips" title={MANDATE_COPY.flips} description={MANDATE_COPY.flipsLine}>
        <Flips replay={replay} />
      </Section>
      <Section id="sign" title={MANDATE_COPY.sign(draft.mandate.version)}>
        <SignPanel key={draft.hash} draft={draft} />
      </Section>
    </Sections>
  );
}

export function MandateEditor() {
  const router = useRouter();
  const ids = useId();
  const [rules, setRules] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CompileAnswerView | null>(null);
  const [replay, setReplay] = useState<Call<Replay> | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    const compiled = await compileRules(rules);
    setPending(false);
    if (!compiled.ok) {
      if (compiled.signedOut === true) router.refresh();
      setError(compiled.message);
      return;
    }
    setDraft(compiled.value);
    setReplay(null);
    setReplay(await replayDraft(compiled.value.mandate));
  }

  return (
    <div className="flex flex-col gap-14">
      <Card as="section" aria-label={MANDATE_COPY.rulesLabel}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-6">
          <Field id={`${ids}-rules`} label={MANDATE_COPY.rulesLabel} help={MANDATE_COPY.rulesHelp}>
            <textarea
              id={`${ids}-rules`}
              rows={6}
              maxLength={MAX_RULES_CHARS}
              value={rules}
              onChange={(event) => setRules(event.target.value)}
              className={TEXTAREA}
              aria-describedby={`${ids}-rules-help`}
            />
          </Field>
          {error !== null ? <Alert message={error} /> : null}
          <div className="flex justify-end">
            <button
              type="submit"
              aria-busy={pending ? true : undefined}
              disabled={pending}
              className={button("primary", "lg", { icon: "leading" })}
            >
              {pending ? (
                <Spin />
              ) : (
                <Sparkles size={ICON.lg} strokeWidth={STROKE(ICON.lg)} aria-hidden="true" />
              )}
              {pending ? MANDATE_COPY.compiling : MANDATE_COPY.compile}
            </button>
          </div>
        </form>
      </Card>
      {draft !== null ? <Draft key={draft.hash} draft={draft} replay={replay} /> : null}
    </div>
  );
}
