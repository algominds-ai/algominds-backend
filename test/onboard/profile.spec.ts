import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { applySizeBand } from "@/core/onboard";
import { IcpDocSchema, SENIOR_BANDS } from "@/core/synthesize";
import {
	chatCompletionResponse,
	exaSearchResultsResponse,
	fakeExaAndModel,
} from "../support/fetch";
import { buildIcp, onboardEnv, profileReply } from "./fixtures";

const ExaRequestBodySchema = z.object({
	query: z.string(),
	type: z.string().optional(),
	includeDomains: z.array(z.string()).optional(),
	additionalQueries: z.array(z.string()).optional(),
	contents: z.unknown().optional(),
});

const acmePage = { url: "https://acme.example/", text: "Acme sells tooling." };

describe("buildIcp: the Exa request shape", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends a deep search on the domain with ten variations and live-crawl fields", async () => {
		const gateway = fakeExaAndModel(
			[exaSearchResultsResponse([acmePage])],
			[chatCompletionResponse({ content: profileReply() })],
		);
		globalThis.fetch = gateway.fetch;

		await buildIcp(onboardEnv(), "acme.example");

		const body = ExaRequestBodySchema.parse(gateway.exaCalls[0]?.body);
		expect(body.type).toBe("deep");
		expect(body.includeDomains).toEqual(["acme.example"]);
		expect(body.additionalQueries).toHaveLength(10);
		expect(body.contents).toEqual({
			text: { maxCharacters: 4000 },
			maxAgeHours: 0,
			livecrawlTimeout: 12000,
		});
	});
});

describe("buildIcp: the profile it writes", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns the model's description and seller block when pages and a profile both come back", async () => {
		const gateway = fakeExaAndModel(
			[exaSearchResultsResponse([acmePage])],
			[chatCompletionResponse({ content: profileReply() })],
		);
		globalThis.fetch = gateway.fetch;

		const result = await buildIcp(onboardEnv(), "acme.example");

		expect(result.description).toBe("a four paragraph ideal customer profile");
		expect(result.seller).toEqual({
			domain: "acme.example",
			customers: ["Acme Corp"],
			competitorTest: "A competitor sells the same tooling to other vendors.",
		});
	});

	it("captures a buyer rubric of any length beside the seller profile", async () => {
		const longRubric =
			"The positives own the budget for this purchase. ".repeat(90);
		expect(longRubric.length).toBeGreaterThan(4000);
		const buyer = {
			rubric: longRubric,
			bands: [...SENIOR_BANDS],
			keywordBands: [{ band: "manager", keywords: ["revenue operations"] }],
		};
		const gateway = fakeExaAndModel(
			[exaSearchResultsResponse([acmePage])],
			[chatCompletionResponse({ content: profileReply({ buyer }) })],
		);
		globalThis.fetch = gateway.fetch;

		const result = await buildIcp(onboardEnv(), "acme.example");

		expect(result.buyer).toEqual(buyer);
		expect(() =>
			IcpDocSchema.parse({
				description: result.description,
				seller: result.seller,
				buyer: result.buyer,
			}),
		).not.toThrow();
	});

	it("keeps the buyer absent when onboarding cannot write one", async () => {
		const gateway = fakeExaAndModel(
			[
				exaSearchResultsResponse([
					{ url: acmePage.url, text: "Acme sells to agencies." },
				]),
			],
			[
				chatCompletionResponse({ content: "", finishReason: "length" }),
				chatCompletionResponse({ content: "", finishReason: "length" }),
			],
		);
		globalThis.fetch = gateway.fetch;
		const note =
			"We sell to agencies with more than fifty staff that bill their own clients directly, and never to the freelancers those agencies subcontract to.";

		const result = await buildIcp(onboardEnv(), "acme.example", note);

		expect(result.description).toBe(note);
		expect(result.buyer).toBeNull();
	});
});

describe("applySizeBand", () => {
	const proseFundingRequirement = {
		id: "r3",
		text: "The company has raised $2M in funding, consistent with a growth stage.",
		kind: "hard" as const,
		proof: "record" as const,
		windowDays: null,
	};

	it("appends a hard requirement stating both funding ends and the public-company exclusion, dropping the model's prose mention", () => {
		const result = applySizeBand([proseFundingRequirement], {
			minFundingTotal: 2_000_000,
			maxFundingTotal: 250_000_000,
			minRevenueAnnual: null,
			maxRevenueAnnual: null,
			publiclyListedExcluded: true,
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("r4");
		expect(result[0]?.kind).toBe("hard");
		expect(result[0]?.proof).toBe("record");
		expect(result[0]?.text).toContain("$2M to $250M in funding");
		expect(result[0]?.text).toContain(
			"Publicly listed companies do not qualify.",
		);
	});

	it("leaves the requirements unchanged when there is no size band", () => {
		const result = applySizeBand([proseFundingRequirement], null);

		expect(result).toEqual([proseFundingRequirement]);
	});

	it("keeps a requirement that mentions funds without a numeric figure", () => {
		const fundsRequirement = {
			id: "r3",
			text: "The company serves investment funds.",
			kind: "hard" as const,
			proof: "record" as const,
			windowDays: null,
		};

		const result = applySizeBand([fundsRequirement], {
			minFundingTotal: 2_000_000,
			maxFundingTotal: 250_000_000,
			minRevenueAnnual: null,
			maxRevenueAnnual: null,
			publiclyListedExcluded: false,
		});

		expect(result.map((req) => req.text)).toContain(
			"The company serves investment funds.",
		);
	});

	it("drops a requirement that states a numeric funding figure", () => {
		const numericFundingRequirement = {
			id: "r3",
			text: "The company has raised $2M–$250M.",
			kind: "hard" as const,
			proof: "record" as const,
			windowDays: null,
		};

		const result = applySizeBand([numericFundingRequirement], {
			minFundingTotal: 2_000_000,
			maxFundingTotal: 250_000_000,
			minRevenueAnnual: null,
			maxRevenueAnnual: null,
			publiclyListedExcluded: false,
		});

		expect(result.map((req) => req.text)).not.toContain(
			"The company has raised $2M–$250M.",
		);
		expect(result).toHaveLength(1);
	});
});
