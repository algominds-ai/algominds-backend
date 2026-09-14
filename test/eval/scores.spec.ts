import { options } from "@eval/args";
import { armDatabaseName } from "@eval/arm-db";
import { ARM_SEED_PROFILES } from "@eval/arm-seed";
import { runComponent, validateComponent } from "@eval/components";
import { sourceUrls } from "@eval/judge";
import { ExpectedSchema, failedOutput, InputSchema } from "@eval/schema";
import { referenceScores, structuralScores } from "@eval/scores";
import { expect, it } from "vitest";
import { fakeSecretEnv } from "../support/env";

it("rejects a component from another suite and malformed fixed inputs before provider calls", async () => {
	const input = InputSchema.parse({
		suite: "onboarding",
		slug: "form3",
		domain: "form3.tech",
		note: null,
		stage: "verification",
	});
	expect(() => validateComponent(input)).toThrow("not a onboarding component");
	await expect(
		runComponent(
			{ ...input, stage: "extraction", sample: [] },
			fakeSecretEnv({}),
		),
	).rejects.toThrow();
});

it("never awards completion or yield to an empty failed run", () => {
	const profile = ARM_SEED_PROFILES[0]?.doc;
	const input = InputSchema.parse({
		suite: "company",
		slug: "form3",
		profile,
		count: 3,
	});
	const scores = structuralScores(input, failedOutput("timed out"));
	for (const name of [
		"run_complete",
		"accounting_complete",
		"nonempty",
		"requested_yield",
	])
		expect(scores.find((score) => score.name === name)?.score).toBe(0);
});
it("does not infer onboarding quality from preserved instructions", () => {
	const profile = ARM_SEED_PROFILES[0]?.doc;
	const input = InputSchema.parse({
		suite: "onboarding",
		slug: "form3",
		domain: profile?.seller.domain,
		note: profile?.instructions,
	});
	const scores = structuralScores(input, {
		...failedOutput("failed"),
		profile: profile ?? null,
	});
	expect(
		scores.find((score) => score.name === "instructions_preserved")?.score,
	).toBe(1);
	expect(scores.find((score) => score.name === "run_complete")?.score).toBe(0);
	expect(
		scores.some((score) => score.name === "evidence_supported_quality"),
	).toBe(false);
});
it("keeps unlabelled and wrong-employer people in the denominator", () => {
	const expected = ExpectedSchema.parse({
		rubric: "Buyer fit",
		references: [
			{
				id: "person",
				company: "example.com",
				judgment: "accept",
				rationale: "Employer confirms role",
				sources: ["https://example.com/team"],
				reviewedAt: "2026-09-13T00:00:00Z",
			},
		],
	});
	const output = {
		...failedOutput("failed"),
		entities: [
			{
				id: "person",
				company: "other.com",
				name: "Person",
				title: null,
				data: null,
			},
			{
				id: "unknown",
				company: "example.com",
				name: "Other",
				title: null,
				data: null,
			},
		],
	};
	const scores = referenceScores(output, expected);
	expect(
		scores.find((score) => score.name === "accepted_reference_match_rate")
			?.score,
	).toBe(0);
	expect(scores.some((score) => score.name === "reference_recall")).toBe(false);
});
it("rejects duplicate domain cases, unsafe database names and malformed flags", () => {
	expect(() => armDatabaseName("../algo")).toThrow();
	expect(() => options(["people", "--trials", "2garbage"])).toThrow();
	expect(() => options(["people", "--unknown"])).toThrow();
	expect(() =>
		InputSchema.parse({
			suite: "people",
			slug: "form3",
			profile: ARM_SEED_PROFILES[0]?.doc,
			domains: ["example.com", "example.com"],
		}),
	).toThrow();
});
it("extracts public source URLs without treating prose or local endpoints as sources", () => {
	expect(
		sourceUrls({
			sources: [
				"https://example.com/team",
				"http://localhost:5432",
				"file:///etc/passwd",
				"Person works there",
			],
		}),
	).toEqual(["https://example.com/team"]);
});
