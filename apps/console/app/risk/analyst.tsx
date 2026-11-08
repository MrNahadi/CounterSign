"use client";

import { AllCommunityModule, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useMemo, useState } from "react";
import {
  ALERT,
  button,
  ICON,
  INPUT,
  INPUT_HEIGHT,
  MONO,
  STROKE,
  SUB_LINE,
} from "../../src/controls";
import {
  ANALYST_COPY,
  type AnalystChart,
  type AnalystGroup,
  type AnalystSpec,
  type AnalystWidget,
  analystWidget,
  askAnalyst,
  MAX_QUESTION_CHARS,
} from "../../src/risk-analyst";
import { formatMinor, RISK_CHART_CURRENCY, type RiskView } from "../../src/risk-view";
import { Field } from "../inbox/inbox-header";
import { Card, CardHeading } from "../ui";
import { graphiteGridTheme } from "./grid-theme";

// The Risk desk analyst (PLAN D2): a typed question goes to `POST /api/risk/analyst`, which
// answers with a widget spec from a fixed allowlist. The widget itself is built here, from the
// decisions the page already read (src/risk-analyst.ts), so the model picks what to show but
// never supplies a number. Graphite Input and Button specs, as the attack form.

const modules = [AllCommunityModule];
const NUMBER_CELL = "ag-right-aligned-cell tabular-nums";

const groupColumns = (label: string): ColDef<AnalystGroup>[] => [
  { field: "label", headerName: label, flex: 1, minWidth: 200 },
  {
    field: "count",
    headerName: "Decisions",
    width: 120,
    type: "numericColumn",
    cellClass: NUMBER_CELL,
  },
  {
    field: "usdMinor",
    headerName: "Amount",
    width: 140,
    type: "numericColumn",
    cellClass: NUMBER_CELL,
    valueFormatter: ({ value }) =>
      typeof value === "number" ? formatMinor(value, RISK_CHART_CURRENCY) : "",
  },
];

const GROUP_HEADINGS: Record<AnalystSpec["groupBy"], string> = {
  reason: "Reason code",
  decision: "Decision",
  action: "Action",
  day: "Day",
  agent: "Agent",
  none: "Group",
};

function Bars({ widget }: { widget: AnalystChart }) {
  const value = (group: AnalystGroup) =>
    widget.measure === "amount" ? group.usdMinor : group.count;
  const max = Math.max(1, ...widget.groups.map(value));
  return (
    <ul className="flex flex-col gap-3" aria-label={widget.title}>
      {widget.groups.map((group) => (
        <li key={group.label} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-body-sm">
            <span className={`${MONO} min-w-0 wrap-anywhere text-primary-foreground`}>
              {group.label}
            </span>
            <span className="tabular-nums text-primary-foreground">{group.display}</span>
          </div>
          <div className="h-2 rounded-xs bg-component" aria-hidden="true">
            <div
              className="h-full rounded-xs bg-brand-solid"
              style={{ width: `${(value(group) / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function WidgetBody({ widget, spec }: { widget: AnalystWidget; spec: AnalystSpec }) {
  const columns = useMemo(() => groupColumns(GROUP_HEADINGS[spec.groupBy]), [spec.groupBy]);
  if (widget.kind === "none") {
    return <p className={ALERT.neutral}>{widget.message}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <CardHeading as="h3" title={widget.title} description={ANALYST_COPY.modelLine} />
      {widget.kind === "total" ? (
        <p className="text-heading-5 font-semibold tracking-heading tabular-nums text-primary-foreground">
          {widget.total.display}
        </p>
      ) : widget.groups.length === 0 ? (
        <p className="text-body-sm text-secondary-foreground">{ANALYST_COPY.empty}</p>
      ) : widget.kind === "bars" ? (
        <Bars widget={widget} />
      ) : (
        <div data-graphite="table" className="overflow-hidden rounded-2xl shadow-border">
          <AgGridReact<AnalystGroup>
            modules={modules}
            theme={graphiteGridTheme}
            rowData={widget.groups}
            columnDefs={columns}
            domLayout="autoHeight"
            suppressCellFocus
          />
        </div>
      )}
      <p className={SUB_LINE}>{widget.notes.join(" ")}</p>
    </div>
  );
}

export function Analyst({ view }: { view: RiskView }) {
  const router = useRouter();
  const id = `${useId()}-question`;
  const [question, setQuestion] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [spec, setSpec] = useState<AnalystSpec | null>(null);
  const widget = useMemo(() => (spec === null ? null : analystWidget(spec, view)), [spec, view]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (question.trim().length < 3) {
      setProblem(ANALYST_COPY.tooShort);
      return;
    }
    setProblem(null);
    setPending(true);
    const answer = await askAnalyst(question);
    setPending(false);
    if (!answer.ok) {
      if (answer.signedOut === true) router.refresh();
      setError(answer.message);
      return;
    }
    setSpec(answer.spec);
  }

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeading
        id={`${id}-title`}
        title={ANALYST_COPY.title}
        description={ANALYST_COPY.description}
      />
      <form noValidate onSubmit={submit} className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <Field id={id} label={ANALYST_COPY.label} error={problem}>
            <input
              id={id}
              type="text"
              autoComplete="off"
              maxLength={MAX_QUESTION_CHARS}
              placeholder={ANALYST_COPY.placeholder}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className={`${INPUT} ${INPUT_HEIGHT.default}`}
              aria-invalid={problem !== null ? true : undefined}
              aria-describedby={`${id}-help`}
            />
          </Field>
        </div>
        <button
          type="submit"
          aria-busy={pending ? true : undefined}
          disabled={pending}
          className={`${button("primary", "lg", { icon: "leading" })} md:mt-7`}
        >
          {pending ? (
            <LoaderCircle
              size={ICON.lg}
              strokeWidth={STROKE(ICON.lg)}
              aria-hidden="true"
              className="motion-safe:animate-[spin_800ms_linear_infinite]"
            />
          ) : (
            <Sparkles size={ICON.lg} strokeWidth={STROKE(ICON.lg)} aria-hidden="true" />
          )}
          {pending ? ANALYST_COPY.asking : ANALYST_COPY.ask}
        </button>
      </form>
      {error !== null ? (
        <p role="alert" className={ALERT.danger}>
          <CircleAlert
            size={ICON.md}
            strokeWidth={STROKE(ICON.md)}
            aria-hidden="true"
            className="mt-0.5 shrink-0"
          />
          <span>{error}</span>
        </p>
      ) : null}
      {widget !== null && spec !== null ? (
        <div aria-live="polite">
          <WidgetBody widget={widget} spec={spec} />
        </div>
      ) : null}
    </Card>
  );
}
