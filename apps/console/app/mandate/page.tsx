import "server-only";
import { hashMandate, parseMandate } from "@countersign/mandate";
import supportMandate from "@countersign/mandate/fixtures/kikapu-studio-v3.json";
import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  APPROVAL_ROUTE_MESSAGES,
  approverKeyFromHeader,
  checkKey,
} from "../../src/approval-routes";
import { MANDATE_COPY } from "../../src/mandate-editor";
import { readBackMandate } from "../../src/mandate-readback";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Notice, Page, PageHeader, Section, Sections } from "../ui";
import { MandateEditor } from "./mandate-editor";
import { ReadBackCard } from "./read-back";

// The merchant changes their rules (brief §6, PLAN E1 and E2): the mandate in force in
// Countersign's words, then plain-English rules compiled into a draft, read back, diffed, replayed
// against the audit log's decisions and signed as the next version. The mandate in force is the
// support agent's signed file, the one the gate loads (apps/gate/src/principals.ts).

export const metadata: Metadata = { title: "Mandate · Countersign console" };
export const dynamic = "force-dynamic";

const current = parseMandate(supportMandate);

export default async function MandatePage() {
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  const signIn = (message: string | null) => (
    <ConsoleShell openApprovals={null}>
      <SignIn title={MANDATE_COPY.title} line={MANDATE_COPY.signInLine} message={message} />
    </ConsoleShell>
  );
  if (key === null) return signIn(null);
  const checked = await checkKey(key, { env: process.env });
  if (!checked.ok && checked.status === 401) return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);

  return (
    <ConsoleShell>
      <Page>
        <PageHeader title={MANDATE_COPY.title} description={MANDATE_COPY.description} />
        {!checked.ok ? (
          <Notice>{checked.message}</Notice>
        ) : (
          <Sections>
            <Section id="in-force" title={MANDATE_COPY.inForce}>
              {current.ok ? (
                <ReadBackCard
                  readBack={readBackMandate(current.mandate)}
                  title={`Version ${current.mandate.version}`}
                  description={MANDATE_COPY.inForceLine}
                  hash={hashMandate(current.mandate).hash}
                />
              ) : (
                <Notice>{current.error}</Notice>
              )}
            </Section>
            <Section id="change" title={MANDATE_COPY.changeTitle}>
              <MandateEditor />
            </Section>
          </Sections>
        )}
      </Page>
    </ConsoleShell>
  );
}
