import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { approverKeyFromHeader } from "../src/approval-routes";
import { CARD_GAP, DESCRIPTION, LINK, STACK } from "../src/controls";
import { approvalsUrl, qrView, requestOrigin } from "../src/qr-view";
import { inboxAccess } from "../src/resolve-routes";
import { SCENARIO_CARDS, START_COPY, storefrontLink } from "../src/start-view";
import { ConsoleShell } from "./console-shell";
import { OpenOnPhone } from "./open-on-phone";
import { SignIn } from "./sign-in";
import { ResetDemo, ScenarioCard } from "./start-parts";
import { Card, Notice, Page, PageHeader, Section, Sections } from "./ui";

// The start page (ADR 0043): the judge's guide for everyone, then, once the gate takes the key,
// the scenarios, the phone code and the demo reset. The key is checked on the server at each
// render, as the inbox does.

export const metadata: Metadata = { title: START_COPY.title };
export const dynamic = "force-dynamic";

const TERM = "text-body-sm font-medium text-primary-foreground";

function Guide() {
  const storefront = storefrontLink(process.env);
  return (
    <Section title={START_COPY.stepsHeading}>
      <div className={STACK}>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-body-base text-primary-foreground marker:text-secondary-foreground">
          {START_COPY.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <Card variant="fill">
          <dl className={`flex flex-col ${CARD_GAP.default}`}>
            {[START_COPY.real, START_COPY.simulated].map((item) => (
              <div key={item.label} className="flex flex-col gap-1">
                <dt className={TERM}>{item.label}</dt>
                <dd className={DESCRIPTION}>{item.text}</dd>
              </div>
            ))}
          </dl>
        </Card>
        {storefront !== null ? (
          <p className={DESCRIPTION}>
            {START_COPY.storefront.before}
            <a href={storefront} className={LINK}>
              {START_COPY.storefront.link}
            </a>
            {START_COPY.storefront.after}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export default async function StartPage() {
  const requestHeaders = await headers();
  const key = approverKeyFromHeader(requestHeaders.get("cookie"));
  const access = await inboxAccess(key, { env: process.env });

  let rest: ReactNode;
  if (access.state === "unreachable") {
    rest = (
      <Section label={START_COPY.signIn.title}>
        <Notice>{access.message}</Notice>
      </Section>
    );
  } else if (access.state === "signed-out") {
    rest = (
      <SignIn
        level={2}
        title={START_COPY.signIn.title}
        line={START_COPY.signIn.line}
        message={access.message}
      />
    );
  } else {
    const url = approvalsUrl({
      publicUrl: process.env.CONSOLE_PUBLIC_URL,
      origin: requestOrigin(requestHeaders),
    });
    const qr = url === null ? null : qrView(url);
    rest = (
      <>
        <Section id="scenarios" title={START_COPY.scenariosHeading}>
          <div className={STACK}>
            {SCENARIO_CARDS.map((card) => (
              <ScenarioCard key={card.id} card={card} />
            ))}
          </div>
        </Section>
        {qr !== null ? <OpenOnPhone qr={qr} /> : null}
        <Section id="reset" title={START_COPY.reset.heading} description={START_COPY.reset.line}>
          <ResetDemo />
        </Section>
      </>
    );
  }

  return (
    <ConsoleShell>
      <Page width="form">
        <PageHeader title={START_COPY.heading} description={START_COPY.line} />
        <Sections>
          <Guide />
          {rest}
        </Sections>
      </Page>
    </ConsoleShell>
  );
}
