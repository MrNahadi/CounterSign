"use client";

import { LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { APPROVALS_COPY, CONTROL_CLASSES, signIn } from "../src/approvals-view";
import { Spinner } from "./ui";

// The approver sign-in (ADR 0032), shared by every page the approvals cookie opens: the
// approvals board, the decisions and the audit log. Each page gives its title and its own line of
// copy. The key goes to the console's session route and is never stored in the browser.

export const SIGN_IN_COLUMN = "mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pt-5 pb-8 md:px-6";

export function SignIn({
  title,
  line,
  message,
}: {
  title: string;
  line: string;
  // A sentence to show first, such as "Sign in again.", or null.
  message: string | null;
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

  return (
    <div className={SIGN_IN_COLUMN}>
      <header className="flex flex-col gap-1">
        <h1 className="text-heading-6 font-semibold tracking-heading">{title}</h1>
        <p className="text-body-sm text-secondary-foreground">{line}</p>
      </header>
      <form noValidate onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-key`} className="text-body-sm font-medium text-primary-foreground">
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
            <p id={`${id}-help`} role="alert" className="text-caption-lg text-danger-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending ? true : undefined}
          className={`${CONTROL_CLASSES.signIn} pl-3`}
        >
          {pending ? (
            <Spinner size={20} />
          ) : (
            <LogIn size={20} strokeWidth={1.75} aria-hidden="true" />
          )}
          {APPROVALS_COPY.signIn}
        </button>
      </form>
    </div>
  );
}
