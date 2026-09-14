import type { Input, Output } from "@eval/schema";

export const RUBRIC =
	"Judge every delivered company against the exact input profile. Check identity and active operating status, business model, geography, size, all hard requirements and exclusions, and source support. A vendor summary or the engine's own selectionReason is not independent proof. Cite the entity and evidence for failures. Do not penalize acceptable batch over-delivery. A source must concern this exact organization and support the actual requirement; a URL alone is not proof. Missing decisive evidence is insufficient. Never score precision only over the convenient labelled subset.";

export function checks(input: Input, output: Output) {
	if (input.suite !== "company") throw new Error("Expected company input");
	return [
		{
			name: "requested_yield",
			score: Math.min(1, output.entities.length / input.count),
		},
	];
}
