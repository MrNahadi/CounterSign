"use client";

import { LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { APPROVALS_COPY, CONTROL_CLASSES, signIn } from "../src/approvals-view";
import { FIELD, FIELD_ERROR, FORM, ICON, LABEL, STROKE } from "../src/controls";
import { Page, PageHeader, Spinner } from "./ui";

// The approver sign-in (ADR 0032), shared by every page the approvals cookie opens: the
// approvals board, the decisions and the audit log. Each page gives its title and its own line of
// copy. The key goes to the console's session route and is never stored in the browser.

export function SignIn({
  title,
  line,
  message,
  level = 1,
}: {
  title: string;
  line: string;
  // A sentence to show first, such as "Sign in again.", or null.
  message: string | null;
  // 1 is a page of its own; 2 sits inside a page that has its own title (the start page).
  level?: 1 | 2;
}) {
  const router = useRouter();
  const id = useId();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(message);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    const result = await signIn(key);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setKey("");
    setError(null);
    router.refresh();
  }

  const form = (
    <>
      <PageHeader as={level === 1 ? "h1" : "h2"} title={title} description={line} />
      <form noValidate onSubmit={submit} className={`${FORM} max-w-sm`}>
        <div className={FIELD}>
          <label htmlFor={`${id}-key`} className={LABEL}>
            {APPROVALS_COPY.keyLabel}
          </label>
          <input
            id={`${id}-key`}
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-invalid={error !== null ? true : undefined}
            aria-describedby={error !== null ? `${id}-help` : undefined}
            className={CONTROL_CLASSES.keyInput}
          />
          {error !== null ? (
            <p id={`${id}-help`} role="alert" className={FIELD_ERROR}>
              {error}
            </p>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending ? true : undefined}
          className={CONTROL_CLASSES.signIn}
        >
          {pending ? (
            <Spinner size={ICON.xl} />
          ) : (
            <LogIn size={ICON.xl} strokeWidth={STROKE(ICON.xl)} aria-hidden="true" />
          )}
          {APPROVALS_COPY.signIn}
        </button>
      </form>
    </>
  );
  return level === 1 ? <Page width="form">{form}</Page> : <section>{form}</section>;
}
