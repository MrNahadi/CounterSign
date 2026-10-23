import {
  type AgentRun,
  type Database,
  type DisputeDraft,
  finishDraft,
  finishRun,
  listLatestDrafts,
  listThreads,
  queueDraft,
  readAttachment,
  readDraft,
  readLatestDraft,
  readRunsByThread,
  readThread,
  type ThreadTicket,
} from "@countersign/db";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { allowedIntentIds, heldCalls, readExecutions, readHeld } from "./executions";
import { newId, storeMessage } from "./intake";
import { DEFAULT_DAILY_RUN_CAP, overDailyCap } from "./limits";
import { checkMessage } from "./messages";
import type { RunQueue } from "./queue";

// Resolve's HTTP API (ADR 0030): `POST /messages` stores a customer message and queues its run;
// the thread readers return what the console's inbox shows. `POST /disputes` queues a dispute's
// evidence draft on the same queue, and the dispute readers return its latest draft (ADR 0035,
// 0037). Only the console's server routes, the gate's nudge and the CLI call it. Answers never
// hold a key or token: runs' traces hold none (ADR 0014), and drafts hold none either.

export const BODY_LIMIT = "10mb";

export type AppDeps = {
  db?: Database;
  /** The model each new run asks for (`GEMINI_MODEL`). */
  model: string;
  queue: RunQueue;
  /** Runs allowed per UTC date (`RESOLVE_DAILY_RUN_CAP`). Defaults to 200. */
  dailyCap?: number;
  /** The edge's clock: each ticket's received time and its run's queued time. */
  clock?: () => Date;
  log?: (line: string) => void;
};

const ThreadIdSchema = z.string().min(1).max(256);
const AttachmentIdSchema = z.string().regex(/^att_[0-9a-f]{32}$/);
// The same dispute ID `prepare_dispute_evidence` takes.
const DisputeIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const DisputeRequestSchema = z.strictObject({ dispute_id: DisputeIdSchema });

const NO_DATABASE = "Resolve has no database, so it can't take or show messages.";

const message = (res: Response, status: number, text: string) => {
  res.status(status).json({ message: text });
};

const firstLine = (body: string): string => {
  const line = body.split(/\r?\n/).find((part) => part.trim() !== "") ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

const ticketView = (ticket: ThreadTicket) => ({
  ticket_id: ticket.id,
  channel: ticket.channel,
  sender_email: ticket.senderEmail,
  sender_phone: ticket.senderPhone,
  subject: ticket.subject,
  body: ticket.body,
  attachments: ticket.attachments.map(({ id, contentType }) => ({
    id,
    content_type: contentType,
  })),
  received_at: ticket.receivedAt,
  simulated: ticket.simulated,
});

const runView = (run: AgentRun) => ({
  run_id: run.id,
  ticket_id: run.ticketId,
  mode: run.mode,
  model: run.model,
  model_versions: run.modelVersions,
  status: run.status,
  outcome: run.outcome,
  reply: run.reply,
  queued_at: run.queuedAt,
  started_at: run.startedAt,
  finished_at: run.finishedAt,
  trace: run.trace,
});

// The gate's agent response names its outcome in `decision` (`pending_approval` for a step-up).
const responseStatus = (response: unknown): string | null => {
  const decision = (response as { decision?: unknown } | null)?.decision;
  return typeof decision === "string" ? decision : null;
};

// The dispute's reason and amount for the console's list, from the facts summary once the draft
// has prepared it; null before then, or when the summary doesn't read.
const SummaryDisputeSchema = z.object({
  dispute: z.object({
    reason_words: z.string().min(1).max(2000),
    amount: z.object({
      minor: z.int(),
      currency: z.string().min(1),
      display: z.string().min(1).max(2000),
    }),
  }),
});

const summaryDispute = (summary: unknown) => {
  const parsed = SummaryDisputeSchema.safeParse(summary);
  return parsed.success ? parsed.data.dispute : null;
};

const draftView = (draft: DisputeDraft) => ({
  draft_id: draft.id,
  dispute_id: draft.disputeId,
  status: draft.status,
  outcome: draft.outcome,
  drafted_by: draft.draftedBy,
  model: draft.model,
  model_versions: draft.modelVersions,
  agent_response_status: responseStatus(draft.agentResponse),
  intent_id: draft.intentId,
  dispute: summaryDispute(draft.factsSummary),
  queued_at: draft.queuedAt,
  started_at: draft.startedAt,
  finished_at: draft.finishedAt,
});

const draftDetail = (draft: DisputeDraft) => ({
  ...draftView(draft),
  facts_summary: draft.factsSummary,
  notes: draft.notes,
  agent_response: draft.agentResponse,
});

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  const clock = deps.clock ?? (() => new Date());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use((_req, res, next) => {
    if (deps.db === undefined) message(res, 503, NO_DATABASE);
    else next();
  });
  const db = () => deps.db as Database;

  app.post("/messages", express.json({ limit: BODY_LIMIT }), async (req, res) => {
    const checked = await checkMessage(db(), req.body);
    if (!checked.ok) {
      message(res, 400, checked.problem);
      return;
    }
    // A message past the day's cap is still stored; its run ends `not_run` with no model call.
    const arrivedAt = clock();
    const capped = await overDailyCap(db(), arrivedAt, deps.dailyCap ?? DEFAULT_DAILY_RUN_CAP);
    let stored: Awaited<ReturnType<typeof storeMessage>>;
    try {
      stored = await storeMessage(db(), checked.value.message, {
        mode: checked.value.mode,
        model: deps.model,
        clock: () => arrivedAt,
      });
    } catch (error) {
      deps.log?.(`A message couldn't be stored: ${error instanceof Error ? error.name : "error"}.`);
      message(res, 500, "Resolve couldn't store the message. Try again.");
      return;
    }
    if (capped) {
      try {
        await finishRun(db(), stored.runId, {
          status: "not_run",
          outcome: "daily_cap",
          reply: null,
          modelVersions: [],
          trace: null,
          finishedAt: clock().toISOString(),
        });
      } catch (error) {
        deps.log?.(
          `A capped run couldn't be closed: ${error instanceof Error ? error.name : "error"}.`,
        );
      }
    } else {
      deps.queue.enqueue(stored.runId);
    }
    res.status(202).json({
      ticket_id: stored.ticketId,
      thread_id: stored.threadId,
      run_id: stored.runId,
    });
  });

  app.post("/disputes", express.json({ limit: BODY_LIMIT }), async (req, res) => {
    const checked = DisputeRequestSchema.safeParse(req.body);
    if (!checked.success) {
      message(res, 400, "The request must be { dispute_id } with a PayPal dispute ID.");
      return;
    }
    // A draft past the day's cap is still stored, `not_run`, so the dispute shows why.
    const arrivedAt = clock();
    let queued: Awaited<ReturnType<typeof queueDraft>>;
    let capped: boolean;
    try {
      capped = await overDailyCap(db(), arrivedAt, deps.dailyCap ?? DEFAULT_DAILY_RUN_CAP);
      queued = await queueDraft(db(), {
        id: newId("drf"),
        disputeId: checked.data.dispute_id,
        model: deps.model,
        queuedAt: arrivedAt.toISOString(),
      });
    } catch (error) {
      deps.log?.(`A draft couldn't be queued: ${error instanceof Error ? error.name : "error"}.`);
      message(res, 500, "Resolve couldn't queue the draft. Try again.");
      return;
    }
    if (!queued.created) {
      res.status(200).json(draftView(queued.draft));
      return;
    }
    let draft = queued.draft;
    if (capped) {
      try {
        await finishDraft(db(), draft.id, {
          status: "not_run",
          outcome: "daily_cap",
          finishedAt: clock().toISOString(),
        });
        draft = (await readDraft(db(), draft.id)) ?? draft;
      } catch (error) {
        deps.log?.(
          `A capped draft couldn't be closed: ${error instanceof Error ? error.name : "error"}.`,
        );
      }
    } else {
      deps.queue.enqueue(draft.id);
    }
    res.status(202).json(draftView(draft));
  });

  app.get("/disputes", async (_req, res) => {
    const drafts = await listLatestDrafts(db());
    res.json({ drafts: drafts.map(draftView) });
  });

  app.get("/disputes/:id", async (req, res) => {
    const id = DisputeIdSchema.safeParse(req.params.id);
    const draft = id.success ? await readLatestDraft(db(), id.data) : null;
    if (draft === null) {
      message(res, 404, "There's no draft for that dispute.");
      return;
    }
    res.json(draftDetail(draft));
  });

  app.get("/threads", async (_req, res) => {
    const summaries = await listThreads(db());
    const threads = [];
    for (const summary of summaries) {
      const runs = await readRunsByThread(db(), summary.threadId);
      const latest = runs.at(-1);
      threads.push({
        thread_id: summary.threadId,
        channel: summary.first.channel,
        sender_email: summary.first.senderEmail,
        sender_phone: summary.first.senderPhone,
        subject: summary.first.subject,
        preview: firstLine(summary.first.body),
        latest_activity_at: summary.latestActivityAt,
        latest_run: latest
          ? { run_id: latest.id, mode: latest.mode, status: latest.status, outcome: latest.outcome }
          : null,
      });
    }
    res.json({ threads });
  });

  app.get("/threads/:id", async (req, res) => {
    const id = ThreadIdSchema.safeParse(req.params.id);
    const tickets = id.success ? await readThread(db(), id.data) : [];
    if (!id.success || tickets.length === 0) {
      message(res, 404, "There's no thread with that ID.");
      return;
    }
    const runs = [];
    for (const run of await readRunsByThread(db(), id.data)) {
      const executions = await readExecutions(db(), allowedIntentIds(run.trace));
      const held = await readHeld(db(), heldCalls(run.trace), clock());
      runs.push({ ...runView(run), executions, held });
    }
    res.json({ thread_id: id.data, messages: tickets.map(ticketView), runs });
  });

  app.get("/attachments/:id", async (req, res) => {
    const id = AttachmentIdSchema.safeParse(req.params.id);
    const attachment = id.success ? await readAttachment(db(), id.data) : null;
    if (attachment === null) {
      message(res, 404, "There's no photo with that ID.");
      return;
    }
    res
      .status(200)
      .set({
        "content-type": attachment.contentType,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      })
      .send(Buffer.from(attachment.bytes));
  });

  app.use((_req, res) => {
    message(res, 404, "Resolve has nothing at that address.");
  });

  // Body-parser refusals (unreadable JSON, over 10 MB) and anything unexpected: one sentence.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type =
      typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
    if (type === "entity.too.large") {
      message(res, 400, "The message is larger than 10 MB.");
      return;
    }
    if (type === "entity.parse.failed" || type === "encoding.unsupported") {
      message(res, 400, "The message must be a JSON object.");
      return;
    }
    deps.log?.(`A request failed: ${error instanceof Error ? error.name : "error"}.`);
    message(res, 500, "Resolve couldn't answer that. Try again.");
  });

  return app;
}
