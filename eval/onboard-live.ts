import { env as testEnv } from "cloudflare:workers";
import { IcpDocSchema } from "@eval/icp-doc";
import {
	formatCheckLine,
	scoreOnboardProfile,
	summaryLine,
} from "@eval/onboard-score";
import { it } from "vitest";
import { z } from "zod";
import { readSellerPages, writeSellerProfile } from "@/core/onboard";

const LiveInputSchema = z.object({
	ONBOARD_LIVE_DOMAIN: z.string().min(1),
	ONBOARD_LIVE_NOTE: z.string(),
	ONBOARD_LIVE_FIXTURE: z.string(),
	ONBOARD_LIVE_EXA_KEY: z.string().min(1),
	ONBOARD_LIVE_AIG_TOKEN: z.string().min(1),
	ONBOARD_LIVE_GATEWAY_BASE_URL: z.string().min(1),
	ONBOARD_LIVE_MODEL_ROUTE: z.string().min(1),
});

/** `testEnv` with the vendor secrets and gateway routing replaced by the real values read from `.env`, since the local Secrets Store emulation this pool starts under never resolves them. */
function liveEnv(input: z.infer<typeof LiveInputSchema>): Env {
	return {
		...testEnv,
		EXA_API_KEY: { get: async () => input.ONBOARD_LIVE_EXA_KEY },
		CF_AIG_TOKEN: { get: async () => input.ONBOARD_LIVE_AIG_TOKEN },
		AI_GATEWAY_BASE_URL: input.ONBOARD_LIVE_GATEWAY_BASE_URL,
		MODEL_ROUTE_REASONING: input.ONBOARD_LIVE_MODEL_ROUTE,
	};
}

/** Runs the real onboarding call against live vendors and prints its score against the fixture; never writes to the database. */
it("writes and scores the live onboarding profile", {
	timeout: 180_000,
}, async () => {
	const startedAt = Date.now();
	const input = LiveInputSchema.parse(testEnv);
	const env = liveEnv(input);
	const fixture = IcpDocSchema.parse(JSON.parse(input.ONBOARD_LIVE_FIXTURE));
	const read = await readSellerPages(env, input.ONBOARD_LIVE_DOMAIN);
	const written = await writeSellerProfile(
		env,
		input.ONBOARD_LIVE_DOMAIN,
		read.pages,
		input.ONBOARD_LIVE_NOTE || null,
	);
	if (written.profile === null) {
		console.log("FAIL  the model wrote no profile");
		console.log(
			JSON.stringify({
				elapsedSeconds: (Date.now() - startedAt) / 1000,
				costDollars: read.ledger.total() + written.ledger.total(),
			}),
		);
		throw new Error("onboard eval: model wrote no profile");
	}
	const checks = scoreOnboardProfile(written.profile, {
		...fixture,
		instructions: input.ONBOARD_LIVE_NOTE || null,
	});
	for (const check of checks) console.log(formatCheckLine(check));
	console.log(summaryLine(checks));
	console.log(
		JSON.stringify({
			elapsedSeconds: (Date.now() - startedAt) / 1000,
			costDollars: read.ledger.total() + written.ledger.total(),
			readCostDollars: read.ledger.total(),
			modelCostDollars: written.ledger.total(),
		}),
	);
	console.log(
		JSON.stringify(
			{
				profile: written.profile,
			},
			null,
			2,
		),
	);
	if (checks.some((check) => !check.passed)) {
		throw new Error("onboard eval: structural check failed");
	}
});
