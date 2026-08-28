CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"icp_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"data" jsonb,
	"run_id" text NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_icp_domain_unique" UNIQUE("icp_id","domain")
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"confidence" real,
	"status" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"product" text,
	"doc" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"linkedin_url" text,
	"name" text,
	"title" text,
	"data" jsonb,
	CONSTRAINT "person_linkedin_url_unique" UNIQUE("linkedin_url")
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
ALTER TABLE "company" ADD CONSTRAINT "company_icp_id_icp_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icp" ADD CONSTRAINT "icp_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_icp_id_icp_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_run_idx" ON "company" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "company_icp_found_at_idx" ON "company" USING btree ("icp_id","found_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_subject_kind_seen_idx" ON "evidence" USING btree ("subject_type","subject_id","kind","seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "icp_account_idx" ON "icp" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "person_company_idx" ON "person" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "run_account_started_idx" ON "run" USING btree ("account_id","started_at" DESC NULLS LAST);