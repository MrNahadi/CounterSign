CREATE TABLE "carrier_shipments" (
	"tracking_number" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"carrier_name" text NOT NULL,
	"scan_events" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "carrier_shipments_status_check" CHECK ("carrier_shipments"."status" IN ('lost', 'stalled_10d', 'in_transit', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "seed_orders" (
	"order_number" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"paypal_order_id" text NOT NULL,
	"paypal_capture_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"payer_email" text NOT NULL,
	"buyer" text NOT NULL,
	"tracking_number" text NOT NULL,
	"role" text NOT NULL,
	"seeded_at" text NOT NULL,
	CONSTRAINT "seed_orders_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "seed_orders_paypal_capture_id_unique" UNIQUE("paypal_capture_id")
);
