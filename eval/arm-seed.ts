import { PROFILES } from "@eval/profiles";
import { type IcpDoc, IcpDocSchema } from "@/core/icp";
import arisOutput from "../exports/onboarding-cycle-2026-09-06/aris-candidate-final.json";
import finalControlsInputs from "../exports/onboarding-cycle-2026-09-06/final-controls-inputs.json";
import form3Output from "../exports/onboarding-cycle-2026-09-06/form3-candidate-final.json";
import ondatoOutput from "../exports/onboarding-cycle-2026-09-06/original-final.json";
import realAccountsInputs from "../exports/onboarding-cycle-2026-09-06/real-accounts-inputs.json";

/** Historical arm JSON uses the removed pre-v1 schema and is unsupported. */
export const UNSUPPORTED_LEGACY_ARM_SEEDS = Object.freeze(
	PROFILES.map((profile) => profile.slug),
);

export type ArmSeedProfile = {
	slug: string;
	icpId: string;
	organizationName: string;
	doc: IcpDoc;
};

type CanonicalOutput = { output: unknown };

const recordedInputs = [...realAccountsInputs, ...finalControlsInputs];

function note(id: string): string {
	const input = recordedInputs.find((entry) => entry.id === id);
	if (!input?.note) throw new Error(`eval: missing exact note for ${id}`);
	return input.note;
}

function canonical(input: CanonicalOutput, instructions: string): IcpDoc {
	if (!input.output || typeof input.output !== "object") {
		throw new Error("eval: recorded onboarding output is not an object");
	}
	return IcpDocSchema.parse({
		...input.output,
		version: 1,
		extracted: true,
		instructions,
	});
}

const CANONICAL_BY_SLUG: ReadonlyMap<string, IcpDoc> = new Map([
	["form3", canonical(form3Output, note("form3-candidate-final"))],
	["aris", canonical(arisOutput, note("aris-candidate-final"))],
	["ondato", canonical(ondatoOutput, note("original-final"))],
]);

/** Only recorded v1 outputs are runnable; legacy fixtures remain excluded. */
export const ARM_SEED_PROFILES: readonly ArmSeedProfile[] = PROFILES.flatMap(
	(profile) => {
		const doc = CANONICAL_BY_SLUG.get(profile.slug);
		return doc
			? [
					{
						slug: profile.slug,
						icpId: profile.icpId,
						organizationName: `eval-${profile.slug}`,
						doc,
					},
				]
			: [];
	},
);
