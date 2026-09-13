import { expect, it } from "vitest";
import {
	peopleSearchRequest,
	ResearchPersonSchema,
	searchSubject,
} from "@/core/people/research";
import { verifyCandidate } from "./support";

const candidate = verifyCandidate(
	7,
	"Alex Doe",
	"Engineering Manager",
	"https://linkedin.com/in/alex",
);
const person = {
	decision: "verified",
	identityStatus: "supported",
	currentEmployerStatus: "supported",
	currentRoleStatus: "supported",
	buyerFit: "adjacent",
	name: "Alex Doe",
	title: "Engineering Manager",
	linkedinUrl: candidate.url,
	reason:
		"Leads technical staff affected by the recruiting offer; relevant influencer without proven signing authority.",
	roleEvidenceQuote: "Alex Doe, Engineering Manager at Example",
};
const reply = {
	requestId: "search-one",
	output: { content: person },
	results: [
		{
			id: "profile",
			url: "https://linkedin.com/in/alex",
			title: "Alex Doe",
			highlights: [person.roleEvidenceQuote],
			summary: null,
			company: null,
			person: null,
		},
	],
};

it("passes only the candidate without a category or system prompt", () => {
	const request = peopleSearchRequest(candidate);
	expect(JSON.parse(request.query.split("Context: ")[1] ?? "{}")).toEqual({
		candidate,
	});
	expect(request).toMatchObject({
		type: "deep",
	});
	expect(request.contents).toEqual({ highlights: true });
	expect(request.category).toBeUndefined();
	expect(request.systemPrompt).toBeUndefined();
	expect(request.includeDomains).toBeUndefined();
	expect(request.outputSchema).toMatchObject({
		required: expect.arrayContaining([
			"identityStatus",
			"currentEmployerStatus",
			"currentRoleStatus",
			"buyerFit",
			"reason",
			"roleEvidenceQuote",
		]),
	});
	const schema = JSON.parse(JSON.stringify(request.outputSchema));
	expect(Object.keys(schema.properties)).toHaveLength(10);
	expect(JSON.stringify(schema).match(/"properties":/g)).toHaveLength(1);
});

it("retains a provider-grounded role source absent from the result excerpts", () => {
	const url = "https://example.com/team/alex";
	expect(
		searchSubject(candidate, {
			...reply,
			results: [],
			output: {
				content: person,
				grounding: [{ field: "roleEvidenceQuote", citations: [{ url }] }],
			},
		}),
	).toMatchObject({ roleEvidence: { url, quote: person.roleEvidenceQuote } });
	expect(
		searchSubject(candidate, {
			...reply,
			results: [],
			output: {
				content: person,
				grounding: [{ field: "name", citations: [{ url }] }],
			},
		}),
	).toBeNull();
});

it("accepts adjacent responsibilities with supported employment and a quote on the returned profile", () => {
	expect(searchSubject(candidate, reply)).toMatchObject({
		decision: "verified",
		buyerFit: "adjacent",
		linkedinUrl: candidate.url,
		id: candidate.id,
		roleEvidence: { url: candidate.url, quote: person.roleEvidenceQuote },
	});
});

it("routes inconsistent statuses and unsupported quotes to fallback", () => {
	for (const changed of [
		{ currentEmployerStatus: "unresolved" },
		{ currentRoleStatus: "contradicted" },
		{ buyerFit: "unrelated" },
		{ identityStatus: "contradicted" },
		{ roleEvidenceQuote: "Invented exact quote" },
		{ roleEvidenceQuote: null },
	])
		expect(
			searchSubject(candidate, {
				...reply,
				output: { content: { ...person, ...changed } },
			}),
		).toBeNull();
	expect(searchSubject(candidate, { ...reply, output: null })).toBeNull();
});

it("keeps uncertain employment for fallback even when an unrelated title is inferred", () => {
	expect(
		ResearchPersonSchema.safeParse({
			...person,
			id: candidate.id,
			roleEvidence: null,
			decision: "rejected",
			buyerFit: "unrelated",
			currentEmployerStatus: "unresolved",
		}).success,
	).toBe(false);
	expect(
		ResearchPersonSchema.safeParse({
			...person,
			id: candidate.id,
			roleEvidence: null,
			decision: "rejected",
			currentEmployerStatus: "contradicted",
		}).success,
	).toBe(true);
	expect(
		searchSubject(candidate, {
			...reply,
			output: {
				content: {
					...person,
					decision: "unresolved",
					currentRoleStatus: "unresolved",
					roleEvidenceQuote: null,
				},
			},
		}),
	).toMatchObject({ decision: "unresolved" });
});
