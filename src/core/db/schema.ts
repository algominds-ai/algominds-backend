import {
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import { organization } from "@/core/db/auth-schema";

export const icp = pgTable(
	"icp",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		domain: text("domain"),
		doc: jsonb("doc"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("icp_organization_idx").on(t.organizationId)],
);

/** One row per capability run. The id is the run id the route builds, so it carries no generated default. */
export const run = pgTable(
	"run",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		icpId: uuid("icp_id")
			.notNull()
			.references(() => icp.id),
		capability: text("capability").notNull(),
		status: text("status").notNull(),
		costDollars: real("cost_dollars").notNull().default(0),
		startedAt: timestamp("started_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(t) => [
		index("run_organization_started_idx").on(
			t.organizationId,
			t.startedAt.desc(),
		),
	],
);

/** One round of a run, kept so a finished run can be read back without paying to reproduce it. `plan` holds the whole search plan the synthesizer wrote. */
export const round = pgTable(
	"round",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		runId: text("run_id")
			.notNull()
			.references(() => run.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		plan: jsonb("plan"),
		found: integer("found").notNull(),
		rejected: jsonb("rejected"),
		startedAt: timestamp("started_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		unique("round_run_ordinal_unique").on(t.runId, t.ordinal),
		index("round_run_idx").on(t.runId),
	],
);

export const company = pgTable(
	"company",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		icpId: uuid("icp_id")
			.notNull()
			.references(() => icp.id),
		domain: text("domain").notNull(),
		name: text("name").notNull(),
		linkedinUrl: text("linkedin_url"),
		data: jsonb("data"),
		runId: text("run_id")
			.notNull()
			.references(() => run.id),
		foundAt: timestamp("found_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		unique("company_icp_domain_unique").on(t.icpId, t.domain),
		index("company_run_idx").on(t.runId),
		index("company_icp_found_at_idx").on(t.icpId, t.foundAt.desc()),
	],
);

export const person = pgTable(
	"person",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		companyId: uuid("company_id")
			.notNull()
			.references(() => company.id),
		linkedinUrl: text("linkedin_url"),
		name: text("name"),
		title: text("title"),
		data: jsonb("data"),
	},
	(t) => [
		index("person_company_idx").on(t.companyId),
		unique("person_organization_linkedin_unique").on(
			t.organizationId,
			t.linkedinUrl,
		),
	],
);

export const evidence = pgTable(
	"evidence",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		subjectType: text("subject_type").notNull(),
		subjectId: uuid("subject_id").notNull(),
		kind: text("kind").notNull(),
		value: text("value").notNull(),
		source: text("source").notNull(),
		confidence: real("confidence"),
		status: text("status"),
		seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("evidence_subject_kind_seen_idx").on(
			t.subjectType,
			t.subjectId,
			t.kind,
			t.seenAt.desc(),
		),
	],
);

export type Run = typeof run.$inferSelect;
export type NewRun = typeof run.$inferInsert;
export type Icp = typeof icp.$inferSelect;
export type NewIcp = typeof icp.$inferInsert;
export type Round = typeof round.$inferSelect;
export type NewRound = typeof round.$inferInsert;
export type Company = typeof company.$inferSelect;
export type NewCompany = typeof company.$inferInsert;
export type Person = typeof person.$inferSelect;
export type NewPerson = typeof person.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;

/**
 * Lowercases a domain or URL and removes one leading `www.`. Does not
 * collapse to a registrable domain (see `docs/solutions/domain-normalization.md`).
 */
export function normalizeDomain(input: string): string {
	const url = new URL(input.includes("://") ? input : `https://${input}`);
	const host = url.hostname.toLowerCase();
	return host.startsWith("www.") ? host.slice(4) : host;
}
