import cases from "@eval/company/cases.json";
import { IcpDocSchema } from "@/core/icp";

export const ARM_SEED_PROFILES = cases
	.filter((entry) => entry.input.stage === "engine")
	.map(({ input }) => ({
		slug: input.slug,
		doc: IcpDocSchema.parse(input.profile),
		icpId: input.slug,
		organizationName: `eval-${input.slug}`,
	}));
