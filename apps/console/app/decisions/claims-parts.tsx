import {
  MONO,
  MONO_BREAK,
  SUB_LINE,
  TABLE,
  TABLE_BODY,
  TABLE_CARD,
  TABLE_HEAD_ROW,
  TD,
  TH,
  TR,
} from "../../src/controls";
import { type ClaimRowView, DECISION_COPY, type TraceRowView } from "../../src/decision-view";
import { Badge, Section } from "../ui";

// Claims vs records and how the gate decided (ADR 0034), as Graphite tables. Shared by a
// decision's page and the attack page, so both show the gate's records the same way.

// At phone width each pair stacks: the header row hides and each cell carries its own label.
const STACK_TABLE = `${TABLE} max-md:block`;
const STACK_ROW = `${TR} max-md:flex max-md:flex-col max-md:gap-2 max-md:px-4 max-md:py-4`;
const STACK_CELL = `${TD} max-md:h-auto max-md:p-0`;
const STACK_LABEL = "mb-1 block text-caption-lg font-medium text-secondary-foreground md:hidden";

export function ClaimsTable({ claims, id = "claims" }: { claims: ClaimRowView[]; id?: string }) {
  return (
    <Section id={id} title={DECISION_COPY.claimsHeading}>
      <div data-graphite="table" className={TABLE_CARD}>
        <div className="overflow-x-auto">
          <table className={STACK_TABLE}>
            <thead className="max-md:hidden">
              <tr className={TABLE_HEAD_ROW}>
                <th scope="col" className={TH}>
                  {DECISION_COPY.claimsColumn}
                </th>
                <th scope="col" className={TH}>
                  {DECISION_COPY.recordsColumn}
                </th>
                <th scope="col" className={TH}>
                  {DECISION_COPY.resultColumn}
                </th>
              </tr>
            </thead>
            <tbody className={`${TABLE_BODY} max-md:block`}>
              {claims.map((pair) => (
                <tr key={pair.check} className={STACK_ROW}>
                  <td className={`${STACK_CELL} md:w-2/5`}>
                    <span className={STACK_LABEL}>{DECISION_COPY.claimsColumn}</span>
                    {pair.claim === null ? (
                      <span className="text-secondary-foreground">{DECISION_COPY.noClaim}</span>
                    ) : (
                      <span className="flex flex-col gap-1">
                        <span className="text-primary-foreground">{pair.claim.text}</span>
                        {pair.claim.quote !== null ? (
                          <span className="text-secondary-foreground break-words">
                            {pair.claim.quote}
                          </span>
                        ) : null}
                        {pair.claim.simulated ? (
                          <span>
                            <Badge tone="neutral">{DECISION_COPY.simulated}</Badge>
                          </span>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className={STACK_CELL}>
                    <span className={STACK_LABEL}>{DECISION_COPY.recordsColumn}</span>
                    <span className="flex flex-col gap-1">
                      <span className="text-primary-foreground">{pair.record.lead}</span>
                      {pair.record.detail !== "" ? (
                        <span className="text-secondary-foreground">{pair.record.detail}</span>
                      ) : null}
                      {pair.record.sources.map((source) => (
                        <span
                          key={`${source.call}-${source.id}`}
                          className="text-secondary-foreground"
                        >
                          {`${source.words}, ${source.call} `}
                          <span className={MONO_BREAK}>{source.id}</span>
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className={STACK_CELL}>
                    <span className={STACK_LABEL}>{DECISION_COPY.resultColumn}</span>
                    <Badge tone={pair.verdict.tone}>{pair.verdict.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

export function TraceTable({ trace, id = "trace" }: { trace: TraceRowView[]; id?: string }) {
  return (
    <Section id={id} title={DECISION_COPY.traceHeading}>
      <div data-graphite="table" className={TABLE_CARD}>
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th scope="col" className={TH}>
                  {DECISION_COPY.traceCheck}
                </th>
                <th scope="col" className={TH}>
                  {DECISION_COPY.traceRecords}
                </th>
                <th scope="col" className={TH}>
                  {DECISION_COPY.traceResult}
                </th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY}>
              {trace.map((entry) => (
                <tr key={entry.verifier} className={TR}>
                  <td className={`${TD} min-w-48`}>
                    <span className="block text-primary-foreground">{entry.words}</span>
                    <span className={`${SUB_LINE} ${MONO}`}>{entry.verifier}</span>
                    <span className={SUB_LINE}>{entry.detail}</span>
                  </td>
                  <td className={`${TD} min-w-56`}>
                    {entry.records.length === 0 ? (
                      <span className="text-secondary-foreground">
                        {DECISION_COPY.noRecordsRead}
                      </span>
                    ) : (
                      entry.records.map((record) => (
                        <span
                          key={`${record.call}-${record.id}`}
                          className="block text-secondary-foreground"
                        >
                          {`${record.words}, ${record.call} `}
                          <span className={MONO_BREAK}>{record.id}</span>
                        </span>
                      ))
                    )}
                  </td>
                  <td className={TD}>
                    <Badge tone={entry.result.tone}>{entry.result.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}
