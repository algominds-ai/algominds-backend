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

// Four tables. `evidence` has no raw-payload column by design: it stores only
// the fields a capability reads, so R20's delete-by-person query is the whole
// data-deletion path. See docs/plans/2026-08-27-001-feature-gtm-engine-core-apis-plan.md
// U2 for the field list this mirrors verbatim.

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

// Contacts are evidence rows with `kind` of `email`, `phone`, or `linkedin`.
// There is no second contacts table (R18). Append-only: a value is never
// overwritten, only superseded by a newer row (see CLAUDE.md invariants).
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
		seenAt: timestamp("seen_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
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

// ponytail: this keeps only the "www." prefix and URL noise off a domain. It
// does not resolve a real public-suffix list, so a value such as
// `shop.acme.co.uk` normalizes to itself rather than collapsing to
// `acme.co.uk`. Upgrade path: swap in a public-suffix-list lookup (e.g.
// `tldts`) if a provider ever returns domains with an eTLD that needs that
// collapse. No provider seen so far needs it, so adding the dependency now
// has no test behind it.
export function normalizeDomain(input: string): string {
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
	const url = new URL(hasScheme ? input : `https://${input}`);
	const host = url.hostname.toLowerCase();
	return host.startsWith("www.") ? host.slice(4) : host;
}
