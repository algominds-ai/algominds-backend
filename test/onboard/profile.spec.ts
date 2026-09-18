import { afterEach, describe, expect, it } from "vitest";
import { writeSellerProfile } from "@/core/onboard";
import {
	chatCompletionResponse,
	exaSearchResultsResponse,
	fakeExaAndModel,
} from "../support/fetch";
import { requirementFixture } from "../support/icp";
import { buildIcp, onboardEnv, profileReply } from "./fixtures";

const acmePage = { url: "https://acme.example/", text: "Acme sells tooling." };
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("onboarding preserves targeting without financial rewriting", () => {
	it("keeps an open bound and a conjunctive financial condition in the stored profile", async () => {
		const rule = requirementFixture("at least $2M funding, no upper bound");
		rule.anyOf[0]?.allOf.push({
			text: "$1M to $150M annual revenue",
			window: null,
			sourceRule: null,
		});
		expect(rule.anyOf[0]?.allOf).toHaveLength(2);
		const gateway = fakeExaAndModel(
			[exaSearchResultsResponse([acmePage])],
			[
				chatCompletionResponse({
					content: profileReply({ requirements: [rule] }),
				}),
			],
		);
		globalThis.fetch = gateway.fetch;
		const note = "Funding AND revenue. No upper funding bound.";
		const written = await buildIcp(onboardEnv(), "acme.example", note);
		expect(written.profile?.icp.requirements).toEqual([rule]);
		expect(written.profile?.instructions).toBe(note);
		expect(written.profile?.version).toBe(1);
	});
	it("retains a buyer rubric without adding stored seniority bands", async () => {
		const buyer =
			"Recruiting manager or sole HR Manager; CTO only if a small-company founder.";
		const gateway = fakeExaAndModel(
			[],
			[chatCompletionResponse({ content: profileReply({ buyer }) })],
		);
		globalThis.fetch = gateway.fetch;
		const written = await writeSellerProfile(
			onboardEnv(),
			"acme.example",
			[acmePage],
			"Recruiting only.",
		);
		expect(written.profile?.icp.buyer).toBe(buyer);
		expect(written.profile?.seller.sourceUrls).toEqual([acmePage.url]);
	});
	it("refuses a profile citing a source the extraction never received", async () => {
		const reply = JSON.parse(profileReply());
		reply.seller.sourceUrls = ["https://unseen.example/"];
		const gateway = fakeExaAndModel(
			[],
			[chatCompletionResponse({ content: JSON.stringify(reply) })],
		);
		globalThis.fetch = gateway.fetch;
		await expect(
			writeSellerProfile(onboardEnv(), "acme.example", [acmePage], null),
		).rejects.toThrow();
	});
});
