import { env as testEnv } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withConnection } from "@/core/db/client";
import type { Organization } from "@/core/db/queries";
import { upsertPeople } from "@/core/db/queries";
import type { Company } from "@/core/db/schema";
import { person } from "@/core/db/schema";
import {
	seedCompanyFor,
	seedOrganization,
	seedRunFor,
	wipeOrganizations,
} from "../support/db";
import { rosterPersonData, verifiedPersonData } from "../support/rows";

type PeopleFixture = {
	org: Organization;
	companyA: Company;
	companyB: Company;
	linkedinUrl: string;
};

async function seedPeopleFixture(label: string): Promise<PeopleFixture> {
	const org = await seedOrganization(label);
	const opened = await seedRunFor(org, "people");
	const companyA = await seedCompanyFor(org, opened, `${label}-old`);
	const companyB = await seedCompanyFor(org, opened, `${label}-new`);
	return {
		org,
		companyA,
		companyB,
		linkedinUrl: `https://linkedin.com/in/${label}-${crypto.randomUUID()}`,
	};
}

async function namedPeople(org: Organization, name: string) {
	return withConnection(testEnv, "direct", db, (c) =>
		c
			.select()
			.from(person)
			.where(and(eq(person.organizationId, org.id), eq(person.name, name))),
	);
}

describe("upsertPeople: the verified employer wins and sticks", () => {
	it("moves a verified person to the verified employer, and a later roster row never moves them back", async () => {
		const fixture = await seedPeopleFixture("upsert-move");

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Jordan Blake",
					title: "Manager",
					data: rosterPersonData(),
				},
			]);
			const verified = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Jordan Blake",
					title: "VP Revenue",
					data: verifiedPersonData(),
				},
			]);

			expect(verified[0]?.companyId).toBe(fixture.companyB.id);

			const afterRoster = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: fixture.linkedinUrl,
					name: "Jordan Blake",
					title: "Someone Else",
					data: rosterPersonData(),
				},
			]);

			expect(afterRoster[0]?.companyId).toBe(fixture.companyB.id);
			expect(afterRoster[0]?.title).toBe("VP Revenue");
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
});

describe("upsertPeople: renamed linkedin url", () => {
	it("corrects the url without touching a verified person's title or data", async () => {
		const fixture = await seedPeopleFixture("upsert-relink");
		const oldSlugUrl = `${fixture.linkedinUrl}-old`;
		const newSlugUrl = `${fixture.linkedinUrl}-new`;
		const verified = verifiedPersonData({ since: "2025-01" });

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: oldSlugUrl,
					name: "Ettienne Gous",
					title: "Sales Manager",
					data: verified,
				},
			]);
			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: newSlugUrl,
					name: "Ettienne Gous",
					title: "Someone Else",
					data: rosterPersonData(),
				},
			]);

			expect(result[0]?.linkedinUrl).toBe(newSlugUrl);
			expect(result[0]?.title).toBe("Sales Manager");
			expect(result[0]?.data).toEqual(verified);
			const stored = await namedPeople(fixture.org, "Ettienne Gous");
			expect(stored).toHaveLength(1);
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
});

describe("upsertPeople: same name, different companies", () => {
	it("keeps two different people with the same name at different companies separate", async () => {
		const fixture = await seedPeopleFixture("upsert-same-name");
		const urlAtA = `${fixture.linkedinUrl}-a`;
		const urlAtB = `${fixture.linkedinUrl}-b`;

		try {
			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: urlAtA,
					name: "Alex Kim",
					title: "Account Executive",
				},
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: urlAtB,
					name: "Alex Kim",
					title: "Product Manager",
				},
			]);

			expect(result).toHaveLength(2);
			expect(result.map((row) => row.companyId).sort()).toEqual(
				[fixture.companyA.id, fixture.companyB.id].sort(),
			);
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
});

describe("upsertPeople: exact url beats a namesake", () => {
	it("moves an exact linkedin url match ahead of a name match, leaving the namesake untouched", async () => {
		const fixture = await seedPeopleFixture("upsert-precedence");
		const movedUrl = `${fixture.linkedinUrl}-moved`;
		const namesakeUrl = `${fixture.linkedinUrl}-namesake`;

		try {
			await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: movedUrl,
					name: "Jordan Blake",
					title: "Old Title",
				},
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: namesakeUrl,
					name: "Jordan Blake",
					title: "Namesake Title",
				},
			]);
			const result = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyB.id,
					linkedinUrl: movedUrl,
					name: "Jordan Blake",
					title: "New Title",
					data: verifiedPersonData({ since: "2026-01" }),
				},
			]);

			expect(result[0]?.linkedinUrl).toBe(movedUrl);
			expect(result[0]?.companyId).toBe(fixture.companyB.id);
			const stored = await namedPeople(fixture.org, "Jordan Blake");
			const namesake = stored.find((row) => row.linkedinUrl === namesakeUrl);
			expect(namesake?.title).toBe("Namesake Title");
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
});
