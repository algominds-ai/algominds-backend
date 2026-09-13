ALTER TABLE "company" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "selection_reason" text;--> statement-breakpoint
UPDATE "company"
SET "description" = COALESCE(
	NULLIF("data"->'entity'->>'description', ''),
	NULLIF("data"->'entity'->>'industry', '')
)
WHERE "description" IS NULL;--> statement-breakpoint
ALTER TABLE "company" DROP COLUMN "industry";
