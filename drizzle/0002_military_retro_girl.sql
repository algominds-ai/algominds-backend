CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"icp_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"status" text NOT NULL,
	"cost_dollars" real DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "icp" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_icp_id_icp_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_account_started_idx" ON "run" USING btree ("account_id","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "icp" ADD CONSTRAINT "icp_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_run_idx" ON "company" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "company_icp_found_at_idx" ON "company" USING btree ("icp_id","found_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "icp_account_idx" ON "icp" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "person_company_idx" ON "person" USING btree ("company_id");