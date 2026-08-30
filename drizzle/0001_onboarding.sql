ALTER TABLE "run" ALTER COLUMN "icp_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "industry" text;