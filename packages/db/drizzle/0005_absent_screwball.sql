CREATE TABLE "dispute_drafts" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"drafted_by" text,
	"model" text NOT NULL,
	"model_versions" jsonb NOT NULL,
	"notes" jsonb,
	"facts_summary" jsonb,
	"agent_response" jsonb,
	"intent_id" text,
	"queued_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	CONSTRAINT "dispute_drafts_seq_unique" UNIQUE("seq"),
	CONSTRAINT "dispute_drafts_dispute_id_unique" UNIQUE("dispute_id"),
	CONSTRAINT "dispute_drafts_status_check" CHECK ("dispute_drafts"."status" IN ('queued', 'running', 'proposed', 'failed', 'not_run'))
);
--> statement-breakpoint
CREATE TABLE "evidence_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "evidence_documents_kind_check" CHECK ("evidence_documents"."kind" IN ('export', 'pdf'))
);
--> statement-breakpoint
CREATE INDEX "evidence_documents_dispute_id_idx" ON "evidence_documents" USING btree ("dispute_id");
--> statement-breakpoint
-- Added by hand (ADR 0035): drizzle-kit doesn't model triggers. Every UPDATE and DELETE on
-- evidence_documents is rejected, whoever runs it. Row-level triggers don't fire on TRUNCATE,
-- which stays possible for the demo reset.
CREATE FUNCTION "evidence_documents_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'evidence_documents is write-once';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evidence_documents_write_once"
BEFORE UPDATE OR DELETE ON "evidence_documents"
FOR EACH ROW EXECUTE FUNCTION "evidence_documents_reject_change"();
