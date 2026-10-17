// Recording one decided proposal in the audit log (ADR 0022): the mandate's version entry, the
// first time that version is used, and the decision entry, in one transaction under the
// ledger's lock. A separate step the caller runs after decide(), which never touches the log.

import { and, asc, auditLog, type Database, eq } from "@countersign/db";
import {
  AppendRejectedError,
  type AppendRejectionCode,
  type AuditLogWriter,
  type ChainRow,
  withAuditLog,
} from "@countersign/ledger";
import { hashMandate, type Mandate } from "@countersign/mandate";
import { z } from "zod";
import type { Decided } from "./decide";

// The longest proposal text a decision entry keeps, in UTF-16 code units.
export const PROPOSAL_TEXT_LIMIT = 16_384;

export type RecordInput = {
  // The proposal exactly as the agent sent it, before the gate normalized it.
  proposal: unknown;
  principal: string;
  mandate: Mandate;
  decided: Decided;
};

export type RecordProblem = "MANDATE_VERSION_CONFLICT" | AppendRejectionCode;

export type RecordResult =
  | { ok: true; mandateSeq: number; mandateEntry: ChainRow | null; decision: ChainRow }
  | { ok: false; problem: RecordProblem; detail: string };

export const mandateRef = (mandate: Pick<Mandate, "id" | "version">): string =>
  `${mandate.id}@v${mandate.version}`;

// The proposal's JSON text. Proposals arrive as parsed JSON, so this only falls back for a
// value JSON can't hold, and then still records something rather than nothing.
function proposalJson(proposal: unknown): string {
  try {
    const text = JSON.stringify(proposal);
    if (typeof text === "string") return text;
  } catch {
    // Falls through to the plain text below.
  }
  try {
    return String(proposal);
  } catch {
    return "";
  }
}

// Cuts the text at the limit, one code unit sooner if the cut would split a surrogate pair.
export function proposalText(proposal: unknown): { text: string; truncated: boolean } {
  const full = proposalJson(proposal);
  if (full.length <= PROPOSAL_TEXT_LIMIT) return { text: full, truncated: false };
  const last = full.charCodeAt(PROPOSAL_TEXT_LIMIT - 1);
  const next = full.charCodeAt(PROPOSAL_TEXT_LIMIT);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  const end = splitsPair ? PROPOSAL_TEXT_LIMIT - 1 : PROPOSAL_TEXT_LIMIT;
  return { text: full.slice(0, end), truncated: true };
}

const LoggedMandateSchema = z.object({ hash: z.string() });

// The hash a logged mandate.version entry holds, or null when it can't be read.
function loggedHash(row: ChainRow): string | null {
  try {
    const parsed = LoggedMandateSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data.hash : null;
  } catch {
    return null;
  }
}

class MandateVersionConflict extends Error {}

async function findMandateEntry(log: AuditLogWriter, ref: string): Promise<ChainRow | undefined> {
  const [row] = await log.tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entryType, "mandate.version"), eq(auditLog.refId, ref)))
    .orderBy(asc(auditLog.seq))
    .limit(1);
  return row;
}

// Writes the mandate's version entry if this version isn't logged yet, then the decision
// entry. Nothing is written if the version is logged with a different hash, or if either
// entry is rejected.
export async function recordDecision(db: Database, input: RecordInput): Promise<RecordResult> {
  const { proposal, principal, mandate, decided } = input;
  const { record, response } = decided;
  const { hash } = hashMandate(mandate);
  if (
    record.mandate.id !== mandate.id ||
    record.mandate.version !== mandate.version ||
    record.mandate.hash !== hash
  ) {
    throw new Error("recordDecision was given a different mandate from the one decided with");
  }
  const ref = mandateRef(mandate);
  const { text, truncated } = proposalText(proposal);

  try {
    return await withAuditLog(db, async (log): Promise<RecordResult> => {
      const logged = await findMandateEntry(log, ref);
      if (logged !== undefined) {
        const loggedMandateHash = loggedHash(logged);
        if (loggedMandateHash !== hash) {
          throw new MandateVersionConflict(
            `Mandate ${mandate.id} version ${mandate.version} is logged with hash ` +
              `${loggedMandateHash ?? "(unreadable)"}, not ${hash}`,
          );
        }
      }
      const mandateEntry =
        logged === undefined
          ? await log.append({
              entryType: "mandate.version",
              refId: ref,
              at: record.decidedAt,
              payload: { mandate, hash },
            })
          : null;
      const mandateSeq = (mandateEntry ?? logged)?.seq;
      if (mandateSeq === undefined) throw new Error("no mandate entry to point at");
      const decision = await log.append({
        entryType: "decision",
        refId: record.intentId,
        at: record.decidedAt,
        payload: {
          principal,
          mandateSeq,
          proposal: text,
          proposalTruncated: truncated,
          record,
          response,
        },
      });
      return { ok: true, mandateSeq, mandateEntry, decision };
    });
  } catch (error) {
    if (error instanceof MandateVersionConflict) {
      return { ok: false, problem: "MANDATE_VERSION_CONFLICT", detail: error.message };
    }
    if (error instanceof AppendRejectedError) {
      return { ok: false, problem: error.rejection.problem, detail: error.rejection.detail };
    }
    throw error;
  }
}
