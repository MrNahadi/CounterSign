CREATE TABLE "audit_log" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"entry_type" text NOT NULL,
	"ref_id" text,
	"at" text NOT NULL,
	"payload" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_log_prev_hash_unique" UNIQUE("prev_hash"),
	CONSTRAINT "audit_log_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
-- Added by hand (ADR 0022): drizzle-kit doesn't model triggers. Every UPDATE and DELETE on
-- audit_log is rejected, whoever runs it. Row-level triggers don't fire on TRUNCATE, which
-- stays possible for the demo reset.
CREATE FUNCTION "audit_log_reject_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only"
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION "audit_log_reject_change"();
