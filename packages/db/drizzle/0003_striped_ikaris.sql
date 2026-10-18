CREATE TABLE "ticket_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "thread_id" text;--> statement-breakpoint
-- Hand-edited: a ticket stored before threads existed is its own thread (ADR 0030).
UPDATE "tickets" SET "thread_id" = "id";--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_attachments_ticket_id_idx" ON "ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_thread_id_idx" ON "tickets" USING btree ("thread_id");