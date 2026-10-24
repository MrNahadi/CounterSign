// payee.allowlisted: a payout's payee is on the deciding mandate's payee list.

import { type Intent, normalizePayeeEmail, type TraceEntry } from "@countersign/mandate";
import { entryFor } from "./entry";
import { CALLS, type RecordSnapshots, recordRefOr } from "./snapshots";

// The payee's email, ignoring case and outer spaces, against the list. A missing list is unknown
// and an unlisted email fails, so neither can pass a rule that requires it.
export function payeeAllowlisted(intent: Intent, records: RecordSnapshots): TraceEntry {
  const { target } = intent;
  if (target.kind !== "payee") return entryFor("payee.allowlisted", [])("unknown", "Not a payout");
  const list = records.payees ?? null;
  const entry = entryFor("payee.allowlisted", [
    recordRefOr(list, { call: CALLS.payees, id: null }),
  ]);
  if (!list) return entry("unknown", "No payee list");
  const email = normalizePayeeEmail(target.email);
  const payee = list.payees.find((listed) => normalizePayeeEmail(listed.email) === email);
  return payee
    ? entry("pass", `${payee.name} (${email}) is on payee list ${list.id}`)
    : entry("fail", `${email} isn't on payee list ${list.id}`);
}
