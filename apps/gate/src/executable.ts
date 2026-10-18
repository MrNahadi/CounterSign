// The actions the gate can carry out, beside the executors in propose.ts. Only a refund executes
// in this phase; an allow for anything else is denied ACTION_UNAVAILABLE (ADR 0028).

import type { Action } from "@countersign/mandate";

export const EXECUTABLE_ACTIONS: readonly Action[] = ["paypal.refund"];

export function isExecutable(action: Action): boolean {
  return EXECUTABLE_ACTIONS.includes(action);
}
