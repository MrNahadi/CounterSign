// ledger.not_duplicate: nothing has executed against the capture before.

import {
  formatMoney,
  type Intent,
  isCurrency,
  isMinorUnits,
  type TraceEntry,
} from "@countersign/mandate";
import { entryFor } from "./entry";
import { CALLS, type RecordSnapshots, recordRefOr } from "./snapshots";

// Any earlier execution on the capture fails, whoever made it (ADR 0019). Replays of the same
// intent are answered before deciding, in phase 6.
export function ledgerNotDuplicate(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { captureId } = intent.target;
  const earlier = records.executions?.find((execution) => execution.captureId === captureId);
  const entry = entryFor("ledger.not_duplicate", [
    recordRefOr(earlier, { call: CALLS.executions, id: captureId }),
  ]);
  if (!records.executions) return entry("unknown", "No execution history");
  if (!earlier) return entry("pass", `Nothing has executed on capture ${captureId}`);
  // It executed whatever its amount, so a malformed one still fails, just without the amount.
  const { amount } = earlier;
  if (!isMinorUnits(amount.minor) || !isCurrency(amount.currency)) {
    return entry("fail", `Execution ${earlier.id} already targeted capture ${captureId}`);
  }
  return entry(
    "fail",
    `Execution ${earlier.id} already moved ${formatMoney(amount)} on capture ${captureId}`,
  );
}
