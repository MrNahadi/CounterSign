import { CARD_DESCRIPTION, MONO } from "../../src/controls";
import { DECISION_BADGES } from "../../src/decisions-view";
import {
  DIFF_LABELS,
  type DiffItemView,
  diffTitle,
  MANDATE_COPY,
  type ReadBackView,
} from "../../src/mandate-editor";
import { Badge, Card, CardHeading, Code } from "../ui";

// A mandate in Countersign's own words (mandate-readback.ts) and one diff item, shared by the
// mandate in force (server) and the compiled draft (client). No hooks, so both can render it.

const RULE_BADGES = {
  allow: { label: "Allows", tone: "positive" },
  step_up: { label: "Holds", tone: DECISION_BADGES.step_up.tone },
  deny: { label: "Denies", tone: DECISION_BADGES.deny.tone },
} as const;

export function ReadBackCard({
  readBack,
  title,
  description,
  hash,
}: {
  readBack: ReadBackView;
  title: string;
  description: string;
  hash: string;
}) {
  return (
    <Card as="article" aria-label={title}>
      <CardHeading as="h3" title={title} description={description} />
      <p className={CARD_DESCRIPTION}>
        {readBack.title}. Hash <span className={`${MONO} wrap-anywhere`}>{hash}</span>
      </p>
      <ol className="flex flex-col gap-4">
        {readBack.rules.map((rule) => (
          <li key={rule.id} className="flex flex-col gap-1.5 text-body-sm">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={RULE_BADGES[rule.decide].tone}>{RULE_BADGES[rule.decide].label}</Badge>
              <Code>{rule.id}</Code>
            </span>
            <span className="text-primary-foreground">{rule.sentence}</span>
            {rule.checks !== null ? (
              <span className="text-secondary-foreground">{rule.checks}</span>
            ) : null}
            {rule.reason !== null ? (
              <span className="text-secondary-foreground">{rule.reason}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <ul className="flex flex-col gap-1.5 text-body-sm text-secondary-foreground">
        {[...readBack.limits, ...readBack.payees, ...readBack.always].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Card>
  );
}

function Lines({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="flex flex-col gap-1 text-body-sm">
      <span className="text-caption-lg font-medium text-secondary-foreground">{label}</span>
      {lines.map((line) => (
        <span key={line} className="text-primary-foreground">
          {line}
        </span>
      ))}
    </div>
  );
}

export function DiffCard({ item }: { item: DiffItemView }) {
  const badge = DIFF_LABELS[item.kind];
  return (
    <Card as="article" variant="nested" aria-label={diffTitle(item)}>
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="text-body-sm font-medium text-primary-foreground">{diffTitle(item)}</span>
      </span>
      {item.before !== null ? <Lines label={MANDATE_COPY.before} lines={item.before} /> : null}
      {item.after !== null ? <Lines label={MANDATE_COPY.after} lines={item.after} /> : null}
    </Card>
  );
}
