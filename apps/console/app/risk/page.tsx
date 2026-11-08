import "server-only";
import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import { loadVerify } from "../../src/audit-routes";
import { STACK, SUB_LINE } from "../../src/controls";
import { loadRiskDecisions, RISK_COPY, type RiskView, riskView } from "../../src/risk-view";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Card, Notice, Page, PageHeader } from "../ui";
import { ChainStatus } from "./chain-status";
import { RiskGrids } from "./risk-grids";
import { RiskStudio } from "./risk-studio";

// The Risk desk (brief §5 item 11): money protected, decisions by reason code and chain status,
// read on the server from the gate's audit API with the approver's cookie. With an AG Studio
// licence key it's an AG Studio report in the Graphite theme; without one it falls back to AG Grid
// Community grids beside Graphite cards (brief §5 cut line). Nothing here moves money.

export const metadata: Metadata = { title: "Risk desk · Countersign console" };
export const dynamic = "force-dynamic";

function MoneyProtected({ money }: { money: RiskView["money"] }) {
  return (
    <Card aria-labelledby="money-protected-title" gap="tight">
      <h2
        id="money-protected-title"
        className="flex items-center gap-1.5 text-body-sm font-medium text-secondary-foreground"
      >
        <ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" />
        {RISK_COPY.moneyTitle}
      </h2>
      <p className="text-heading-5 font-semibold tracking-heading tabular-nums text-primary-foreground">
        {money.value}
      </p>
      <p className={SUB_LINE}>{money.line}</p>
    </Card>
  );
}

function CommunityDesk({ view }: { view: RiskView }) {
  return (
    <div className={STACK}>
      <div className="grid gap-(--grid-gap) md:grid-cols-2">
        <MoneyProtected money={view.money} />
        <Card aria-label={RISK_COPY.chainTitle} gap="tight">
          <ChainStatus chain={view.chain} />
        </Card>
      </div>
      <RiskGrids view={view} />
    </div>
  );
}

function StudioDesk({ view, licenseKey }: { view: RiskView; licenseKey: string }) {
  return (
    <div className="h-[80vh] min-h-160 overflow-hidden rounded-3xl bg-container shadow-border">
      <RiskStudio view={view} licenseKey={licenseKey} />
    </div>
  );
}

export default async function RiskPage() {
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  const signIn = (message: string | null) => (
    <ConsoleShell openApprovals={null}>
      <SignIn title={RISK_COPY.title} line={RISK_COPY.signInLine} message={message} />
    </ConsoleShell>
  );
  if (key === null) return signIn(null);

  const deps = { env: process.env };
  const [decisions, verify] = await Promise.all([
    loadRiskDecisions(key, deps),
    loadVerify(key, deps),
  ]);
  if ((!decisions.ok && decisions.status === 401) || (!verify.ok && verify.status === 401)) {
    return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  }
  const view = decisions.ok ? riskView(decisions.value, verify, new Date()) : null;
  const licenseKey = process.env.AG_STUDIO_LICENSE_KEY?.trim() || null;
  return (
    <ConsoleShell>
      <Page>
        <PageHeader
          title={RISK_COPY.title}
          description={view === null ? RISK_COPY.subtitle : `${RISK_COPY.subtitle} ${view.window}`}
        />
        <div className={STACK}>
          {view === null ? (
            <Notice>{decisions.ok ? null : decisions.message}</Notice>
          ) : (
            <>
              {view.notes.length > 0 ? (
                <Notice tone="warning">{view.notes.join(" ")}</Notice>
              ) : null}
              {licenseKey === null ? (
                <CommunityDesk view={view} />
              ) : (
                <StudioDesk view={view} licenseKey={licenseKey} />
              )}
            </>
          )}
        </div>
      </Page>
    </ConsoleShell>
  );
}
