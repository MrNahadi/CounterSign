CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"sender_email" text,
	"sender_phone" text,
	"subject" text,
	"body" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"received_at" text NOT NULL,
	"simulated" boolean NOT NULL,
	CONSTRAINT "tickets_channel_check" CHECK ("tickets"."channel" IN ('email', 'chat'))
);
