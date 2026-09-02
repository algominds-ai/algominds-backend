CREATE TABLE "run_company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"domain" text NOT NULL,
	"company_id" uuid,
	"identity" text,
	"mode" text,
	"buyer_source" text,
	"spend_dollars" real DEFAULT 0 NOT NULL,
	"clay_records" integer DEFAULT 0 NOT NULL,
	"people_verified" integer DEFAULT 0 NOT NULL,
	"people_roster" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "run_company_run_domain_unique" UNIQUE("run_id","domain")
);
--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "icp_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "company" SET "organization_id" = "icp"."organization_id" FROM "icp" WHERE "company"."icp_id" = "icp"."id";--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_company" ADD CONSTRAINT "run_company_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_company" ADD CONSTRAINT "run_company_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_company_run_idx" ON "run_company" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_organization_domain_orphan_unique" ON "company" USING btree ("organization_id","domain") WHERE "company"."icp_id" is null;