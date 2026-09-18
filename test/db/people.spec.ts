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
					name: "Jordan B.",
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
			expect(verified[0]?.name).toBe("Jordan Blake");

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
	it("keeps separately verified profiles separate without a proven alias", async () => {
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
					data: verifiedPersonData(),
				},
			]);

			expect(result[0]?.linkedinUrl).toBe(newSlugUrl);
			expect(result[0]?.title).toBe("Someone Else");
			expect(await namedPeople(fixture.org, "Ettienne Gous")).toHaveLength(2);
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	});
	it("relinks a verified alias while leaving the namesake untouched", async () => {
		const fixture = await seedPeopleFixture("upsert-alias");
		const oldSlugUrl = `${fixture.linkedinUrl}-old`;
		const newSlugUrl = `${fixture.linkedinUrl}-namesake`;
		try {
			await upsertPeople(
				testEnv,
				[oldSlugUrl, newSlugUrl].map((linkedinUrl) => ({
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl,
					name: "Ettienne Gous",
					title: "Sales Manager",
					data: verifiedPersonData(),
				})),
			);
			const correctedUrl = `${fixture.linkedinUrl}-canonical`;
			const corrected = await upsertPeople(testEnv, [
				{
					organizationId: fixture.org.id,
					companyId: fixture.companyA.id,
					linkedinUrl: correctedUrl,
					name: "Etienne Gous",
					title: "Sales Director",
					data: verifiedPersonData({ aliases: [oldSlugUrl] }),
				},
			]);
			expect(corrected[0]?.linkedinUrl).toBe(correctedUrl);
			expect(corrected[0]?.name).toBe("Etienne Gous");
			expect(corrected[0]?.title).toBe("Sales Director");
			expect(
				(await namedPeople(fixture.org, "Ettienne Gous"))[0]?.linkedinUrl,
			).toBe(newSlugUrl);
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

describe("upsertPeople: large rosters", () => {
	it("persists a large roster in order and returns final verified fields across batches", async () => {
		const fixture = await seedPeopleFixture("upsert-large");
		try {
			const rows = Array.from({ length: 11000 }, (_, index) => ({
				organizationId: fixture.org.id,
				companyId: fixture.companyA.id,
				linkedinUrl: `${fixture.linkedinUrl}-${index}`,
				name: `Buyer ${index}`,
				title: "Engineer",
				data: rosterPersonData(),
			}));
			const repeated = {
				organizationId: fixture.org.id,
				companyId: fixture.companyA.id,
				linkedinUrl: fixture.linkedinUrl,
				name: "Repeated buyer",
				title: "Old title",
				data: rosterPersonData(),
			};
			const oldUrl = `${fixture.linkedinUrl}-old`;
			const [original] = await upsertPeople(testEnv, [
				{ ...repeated, linkedinUrl: oldUrl },
			]);
			rows.unshift(repeated);
			rows.push({
				...repeated,
				title: "Current title",
				data: verifiedPersonData({ aliases: [oldUrl] }),
			});
			const saved = await upsertPeople(testEnv, rows);
			expect(saved.map((row) => row.linkedinUrl)).toEqual(
				rows.map((row) => row.linkedinUrl),
			);
			expect(saved[0]?.title).toBe("Current title");
			expect(saved.at(-1)?.id).toBe(saved[0]?.id);
			expect(saved[0]?.id).toBe(original?.id);
		} finally {
			await wipeOrganizations([fixture.org.id]);
		}
	}, 10_000);
});
