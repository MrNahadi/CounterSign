ALTER TABLE "tickets" ADD COLUMN "origin" text DEFAULT 'console' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_origin_check" CHECK ("tickets"."origin" IN ('console', 'visitor'));
