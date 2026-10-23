// The actions the gate can carry out, each with its executor in executors.ts (ADRs 0033 and
// 0035). An allow for anything else is denied ACTION_UNAVAILABLE (ADR 0028), and an approval for
// anything else is rejected ACTION_UNAVAILABLE (ADR 0032).

import type { Action } from "@countersign/mandate";

export const EXECUTABLE_ACTIONS = [
  "paypal.refund",
  "paypal.invoice.send",
  "paypal.dispute.accept_claim",
  "paypal.dispute.make_offer",
  "paypal.dispute.provide_evidence",
] as const satisfies readonly Action[];
export type ExecutableAction = (typeof EXECUTABLE_ACTIONS)[number];

export function isExecutable(action: Action): action is ExecutableAction {
  return (EXECUTABLE_ACTIONS as readonly Action[]).includes(action);
}
