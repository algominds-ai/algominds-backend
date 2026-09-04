import aris from "@eval/arm-seed/aris.json";
import carta from "@eval/arm-seed/carta.json";
import dental from "@eval/arm-seed/dental.json";
import form3 from "@eval/arm-seed/form3.json";
import hvac from "@eval/arm-seed/hvac.json";
import mstone from "@eval/arm-seed/mstone.json";
import { IcpDocSchema } from "@eval/icp-doc";
import { PROFILES } from "@eval/profiles";

const RAW_DOC_BY_SLUG: ReadonlyMap<string, unknown> = new Map<string, unknown>([
	["mstone", mstone],
	["aris", aris],
	["form3", form3],
	["carta", carta],
	["dental", dental],
	["hvac", hvac],
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
 * database currently holds for the same `icpId` — every arm searches
 * against the same six profiles.
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
