import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/core/people/candidate";
import {
	personVerifyEvidenceRow,
	rawEvidenceRow,
	toNewPerson,
} from "../src/core/people/rows";

const candidate: Candidate = {
	id: 0,
	name: "Jordan Blake",
	title: "VP Revenue",
	company: "Acme",
	url: "https://linkedin.com/in/jordan-blake",
	location: "Austin, TX",
	since: "2022-01",
	seenBy: ["clay"],
};

describe("toNewPerson", () => {
	it("maps a deduped candidate into a storable verified row", () => {
		const row = toNewPerson(
			candidate,
			{ companyId: "company-1", organizationId: "org-1" },
			"verified",
			"champion",
		);

		expect(row).toEqual({
			organizationId: "org-1",
			companyId: "company-1",
			linkedinUrl: "https://linkedin.com/in/jordan-blake",
			name: "Jordan Blake",
			title: "VP Revenue",
			data: {
				status: "verified",
				basis: "champion",
				seenBy: ["clay"],
				since: "2022-01",
				location: "Austin, TX",
			},
		});
	});

	it("maps a roster candidate with no basis", () => {
		const row = toNewPerson(
			{ ...candidate, url: "https://linkedin.com/in/roster-person" },
			{ companyId: "company-1", organizationId: "org-1" },
			"roster",
			null,
		);

		expect(row?.data).toEqual({
			status: "roster",
			basis: null,
			seenBy: ["clay"],
			since: "2022-01",
			location: "Austin, TX",
		});
	});

	it("returns no row for a candidate with no linkedin url", () => {
		const row = toNewPerson(
			{ ...candidate, url: null },
			{ companyId: "company-1", organizationId: "org-1" },
			"roster",
			null,
		);

		expect(row).toBeNull();
	});
});

describe("rawEvidenceRow", () => {
	it("keeps a string reply unchanged", () => {
		const row = rawEvidenceRow(
			"run-company-1",
			"identity-create",
			"clay",
			'{"search_id":"abc"}',
		);

		expect(row).toEqual({
			subjectType: "run_company",
			subjectId: "run-company-1",
			kind: "identity-create",
			source: "clay",
			value: '{"search_id":"abc"}',
		});
	});

	it("serializes an object reply to json, unshaped", () => {
		const body = { picks: [{ id: 1, basis: "champion" }] };
		const row = rawEvidenceRow("run-company-1", "select", "workerModel", body);

		expect(row.value).toBe(JSON.stringify(body));
		expect(JSON.parse(row.value)).toEqual(body);
	});

	it("records a null reply as the literal string null", () => {
		const row = rawEvidenceRow("run-company-1", "select", "workerModel", null);

		expect(row.value).toBe("null");
	});
});

describe("personVerifyEvidenceRow", () => {
	it("subjects the row to the person, keeping the run_company link inside the value", () => {
		const verdict = { verdict: "CONFIRMED" };
		const row = personVerifyEvidenceRow({
			personId: "person-1",
			runCompanyId: "run-company-1",
			kind: "verify-poll",
			source: "exa",
			body: verdict,
		});

		expect(row).toEqual({
			subjectType: "person",
			subjectId: "person-1",
			kind: "verify-poll",
			source: "exa",
			value: JSON.stringify({ runCompanyId: "run-company-1", body: verdict }),
		});
	});
});
