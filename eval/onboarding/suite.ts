import type { Input, Output } from "@eval/schema";
import { IcpDocSchema } from "@/core/icp";

export const RUBRIC =
	"Evaluate seller grounding and targeting fidelity separately in your rationale. The seller describes what this business sells, not its customers. Preserve the user's exact constraints, exclusions, geographic scope, buyer roles and ambiguities. Do not invent ICP requirements from marketing copy. The output must distinguish seller facts from prospective buyer criteria. A recorded profile is context, not ground truth. Unsupported facts or lost constraints fail; absent evidence is insufficient, never a pass.";

export function checks(input: Input, output: Output) {
	if (input.suite !== "onboarding")
		throw new Error("Expected onboarding input");
	const profile = output.profile;
	return [
		{
			name: "schema_valid",
			score: Number(IcpDocSchema.safeParse(profile).success),
		},
		{
			name: "instructions_preserved",
			score: Number(profile !== null && profile.instructions === input.note),
		},
		{
			name: "seller_preserved",
			score: Number(profile?.seller.domain === input.domain),
		},
		{ name: "extraction_complete", score: Number(profile?.extracted === true) },
	];
}
