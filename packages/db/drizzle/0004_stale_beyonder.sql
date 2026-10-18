CREATE TABLE "agent_runs" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"mode" text NOT NULL,
	"model" text NOT NULL,
	"model_versions" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"reply" text,
	"trace" jsonb,
	"queued_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	CONSTRAINT "agent_runs_seq_unique" UNIQUE("seq"),
	CONSTRAINT "agent_runs_mode_check" CHECK ("agent_runs"."mode" IN ('protected', 'baseline')),
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" IN ('queued', 'running', 'replied', 'stopped', 'failed', 'not_run'))
);
--> statement-breakpoint
CREATE INDEX "agent_runs_thread_id_idx" ON "agent_runs" USING btree ("thread_id");