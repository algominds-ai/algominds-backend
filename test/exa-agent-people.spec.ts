import { describe, expect, it } from "vitest";
import type { PeopleCompany } from "../src/core/person-candidates";
import type { ExaAgentPerson } from "../src/core/providers/exa-agent";
import {
	buildPersonAgentRunRequest,
	toExaSearchResult,
} from "../src/core/providers/exa-agent";

function targetCompany(name: string): PeopleCompany {
	return { id: "company-1", domain: "acme.example", name, exaId: null };
}

function agentPerson(fields: Partial<ExaAgentPerson> = {}): ExaAgentPerson {
	return {
		name: "Jane Doe",
		linkedinUrl: "https://linkedin.com/in/janedoe",
		title: "VP of Sales",
		location: "New York",
		companyName: "Acme",
		...fields,
	};
}

describe("buildPersonAgentRunRequest", () => {
	it("asks for the requested count in the query without pinning a schema minimum", () => {
		const request = buildPersonAgentRunRequest(
			{ query: "VP of Sales at Acme" },
			3,
			"low",
		);

		expect(request.query).toContain("VP of Sales at Acme");
		expect(request.query).toContain("3");
		expect(request.effort).toBe("low");
		const outputSchema = JSON.parse(JSON.stringify(request.outputSchema));
		expect(outputSchema.required).toEqual(["people"]);
		expect(outputSchema.properties.people.minItems).toBeUndefined();
		expect(outputSchema.properties.people.items.required).toEqual([
			"name",
			"linkedinUrl",
		]);
	});
});

describe("toExaSearchResult", () => {
	it("drops a person the agent gave no LinkedIn URL for", () => {
		const people = [agentPerson({ linkedinUrl: null })];

		const result = toExaSearchResult("run-1", people, "Acme");

		expect(result.results).toHaveLength(0);
	});

	it("builds a current work-history entry naming the target company, not the vendor", () => {
		const people = [agentPerson({ companyName: "a different name" })];

		const result = toExaSearchResult("run-1", people, "Acme");

		expect(result.results).toHaveLength(1);
		const entry = result.results[0]?.person?.workHistory[0];
		expect(entry).toEqual({
			title: "VP of Sales",
			from: null,
			current: true,
			companyId: null,
			companyName: "Acme",
		});
	});

	it("uses the LinkedIn URL as the result url and the person's name as the result title", () => {
		const people = [agentPerson({ name: "Max Freeman" })];

		const result = toExaSearchResult("run-1", people, "Acme");

		expect(result.results[0]?.url).toBe("https://linkedin.com/in/janedoe");
		expect(result.results[0]?.title).toBe("Max Freeman");
		expect(result.results[0]?.id).toBeNull();
		expect(result.results[0]?.summary).toBeNull();
		expect(result.results[0]?.company).toBeNull();
	});

	it("keeps the requestId as the result's own id", () => {
		const result = toExaSearchResult("run-42", [agentPerson()], "Acme");

		expect(result.requestId).toBe("run-42");
	});
});
