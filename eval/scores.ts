import { checks as companyChecks } from "@eval/company/suite";
import { checks as onboardingChecks } from "@eval/onboarding/suite";
import { checks as peopleChecks } from "@eval/people/suite";
import type { Expected, Input, Output } from "@eval/schema";

export function referenceScores(output: Output, expected: Expected) {
	const labels = output.entities.map((entity) =>
		expected.references.find(
			(reference) =>
				reference.id === entity.id && reference.company === entity.company,
		),
	);
	const accepted = labels.filter(
		(label) => label?.judgment === "accept",
	).length;
	const labelled = labels.filter(
		(label) => label !== undefined && label.judgment !== "unresolved",
	).length;
	const count = output.entities.length;
	const scores: { name: string; score: number | null }[] = [
		{ name: "reference_coverage", score: count ? labelled / count : 0 },
		{
			name: "accepted_reference_match_rate",
			score: count ? accepted / count : 0,
		},
	];
	if (expected.closedWorld) {
		const positives = expected.references.filter(
			(reference) => reference.judgment === "accept",
		);
		const found = positives.filter((reference) =>
			output.entities.some(
				(entity) =>
					entity.id === reference.id && entity.company === reference.company,
			),
		);
		scores.push({
			name: "reference_recall",
			score: positives.length ? found.length / positives.length : null,
		});
	}
	return scores;
}

export function structuralScores(input: Input, output: Output) {
	if (input.stage !== "engine")
		return [
			{
				name: "run_complete",
				score: Number(output.status === "complete" && output.error === null),
			},
			{ name: "component_output", score: Number(output.component !== null) },
			{
				name: "accounting_complete",
				score: Number(output.costDollars !== null && output.seconds !== null),
			},
		];
	const checks =
		input.suite === "onboarding"
			? onboardingChecks
			: input.suite === "company"
				? companyChecks
				: peopleChecks;
	return [
		{
			name: "run_complete",
			score: Number(output.status === "complete" && output.error === null),
		},
		{
			name: "accounting_complete",
			score: Number(output.costDollars !== null && output.seconds !== null),
		},
		{
			name: "nonempty",
			score: Number(
				input.suite === "onboarding"
					? output.profile !== null
					: output.entities.length > 0,
			),
		},
		{
			name: "unique_entities",
			score: Number(
				new Set(output.entities.map((entity) => entity.id)).size ===
					output.entities.length,
			),
		},
		...checks(input, output),
	];
}
