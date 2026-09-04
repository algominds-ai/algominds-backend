import ondato from "@eval/arm-seed/ondato.json";
import { IcpDocSchema } from "@eval/icp-doc";
import { PROFILES } from "@eval/profiles";

const RAW_DOC_BY_SLUG: ReadonlyMap<string, unknown> = new Map<string, unknown>([
	["ondato", ondato],
]);

export type ArmSeedProfile = {
	slug: string;
	icpId: string;
	organizationName: string;
	doc: ReturnType<typeof IcpDocSchema.parse>;
};

/**
 * The frozen profile document for every profile the eval measures, parsed
 * once at import time so a malformed seed file fails fast rather than mid
 * arm bootstrap. Fixed at this content regardless of what the shared dev
 * database currently holds for the same `icpId`.
 */
export const ARM_SEED_PROFILES: readonly ArmSeedProfile[] = PROFILES.map(
	(profile) => {
		const raw = RAW_DOC_BY_SLUG.get(profile.slug);
		if (raw === undefined) {
			throw new Error(`eval: no arm-seed document for profile ${profile.slug}`);
		}
		return {
			slug: profile.slug,
			icpId: profile.icpId,
			organizationName: `eval-${profile.slug}`,
			doc: IcpDocSchema.parse(raw),
		};
	},
);
