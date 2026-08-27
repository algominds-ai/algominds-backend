import {
	index,
	jsonb,
	pgTable,
	real,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

export const icp = pgTable("icp", {
	id: uuid("id").primaryKey().defaultRandom(),
	domain: text("domain").notNull(),
	product: text("product"),
	doc: jsonb("doc"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const company = pgTable(
	"company",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		icpId: uuid("icp_id")
			.notNull()
			.references(() => icp.id),
		domain: text("domain").notNull(),
		name: text("name").notNull(),
		data: jsonb("data"),
		runId: text("run_id"),
		foundAt: timestamp("found_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [unique("company_icp_domain_unique").on(t.icpId, t.domain)],
);

export const person = pgTable("person", {
	id: uuid("id").primaryKey().defaultRandom(),
	companyId: uuid("company_id")
		.notNull()
		.references(() => company.id),
	linkedinUrl: text("linkedin_url").unique(),
	name: text("name"),
	title: text("title"),
	data: jsonb("data"),
});

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

export type Icp = typeof icp.$inferSelect;
export type NewIcp = typeof icp.$inferInsert;
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
