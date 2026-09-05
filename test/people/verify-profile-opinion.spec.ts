import { describe, expect, it } from "vitest";
import { CostLedger } from "@/core/cost";
import { profileOpinion } from "@/core/people/verify";
import { fakeModelEnv, fakeSecretEnv } from "../support/env";
import { chatCompletionResponse, exaContentsFetch } from "../support/fetch";

function profileFetch(text: string, reply: unknown): typeof fetch {
	const contentsFetch = exaContentsFetch({
		"https://linkedin.com/in/jane-doe": { text },
	});
	return async (input, init) =>
		String(input).includes("api.exa.ai/contents")
			? contentsFetch(input, init)
			: chatCompletionResponse({ content: JSON.stringify(reply) });
}

function profileEnv(): Env {
	return fakeModelEnv({}, fakeSecretEnv({ EXA_API_KEY: "test-exa-key" }));
}

describe("verify: the profile rescue reads the candidate's own LinkedIn text", () => {
	it("reports CURRENT for an entry the profile marks current at the target company", async () => {
		globalThis.fetch = profileFetch(
			[
				"## Experience",
				"### Director of Marketing - [VIP Play, Inc.](https://linkedin.com/company/vip-play) (Current)",
				"Aug 2025 - Jun 2026",
			].join("\n"),
			{
				employment: "CURRENT",
				title: "Director of Marketing",
				since: "Aug 2025",
			},
		);
		const opinion = await profileOpinion(
			{
				url: "https://linkedin.com/in/jane-doe",
				name: "Jane Doe",
				company: "VIP Play",
				domain: "vipplay.com",
				title: "Director of Marketing",
			},
			profileEnv(),
			new CostLedger(),
		);
		expect(opinion.employment).toBe("CURRENT");
		expect(opinion.title).toBe("Director of Marketing");
		expect(opinion.since).toBe("Aug 2025");
	});

	it("reports LEFT for an entry with an end date and no current entry at the company", async () => {
		globalThis.fetch = profileFetch(
			[
				"## Experience",
				"### Director of Marketing - [VIP Play, Inc.](https://linkedin.com/company/vip-play)",
				"Aug 2023 - Jun 2025",
			].join("\n"),
			{ employment: "LEFT", title: null, since: null },
		);
		const opinion = await profileOpinion(
			{
				url: "https://linkedin.com/in/jane-doe",
				name: "Jane Doe",
				company: "VIP Play",
				domain: "vipplay.com",
				title: "Director of Marketing",
			},
			profileEnv(),
			new CostLedger(),
		);
		expect(opinion.employment).toBe("LEFT");
		expect(opinion.title).toBeNull();
	});

	it("reports UNKNOWN when the profile text carries no Experience section", async () => {
		globalThis.fetch = profileFetch(
			"## Posts\nJane shared an article about growth marketing.",
			{ employment: "UNKNOWN", title: null, since: null },
		);
		const opinion = await profileOpinion(
			{
				url: "https://linkedin.com/in/jane-doe",
				name: "Jane Doe",
				company: "VIP Play",
				domain: "vipplay.com",
				title: "Director of Marketing",
			},
			profileEnv(),
			new CostLedger(),
		);
		expect(opinion.employment).toBe("UNKNOWN");
	});
});
