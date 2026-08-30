import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { config } from "@/config";
import {
	closeRun,
	createIcp,
	openRun,
	organizationSpendToday,
} from "@/core/db/queries";
import { normalizeDomain } from "@/core/db/schema";
import { buildIcp } from "@/core/onboard";
import type { IcpSeller } from "@/core/synthesize";

const OnboardIcpPayloadSchema = z.object({
	domain: z.string().min(1),
	note: z.string().nullish(),
	organizationId: z.string().min(1),
});

export type OnboardIcpPayload = z.infer<typeof OnboardIcpPayloadSchema>;

export type OnboardIcpSummary = {
	icpId: string;
	costDollars: number;
};

const IPV4_HOST = /^\d+(\.\d+)*$/;

/**
 * `domain` normalized to a public hostname, or a `NonRetryableError` for
 * anything else. `normalizeDomain` alone accepts `localhost` and an address
 * literal, and a paid crawl of either finds nothing.
 */
export function publicHostname(domain: string): string {
	let host: string;
	try {
		host = normalizeDomain(domain);
	} catch {
		throw new NonRetryableError(`onboardIcp: not a public hostname: ${domain}`);
	}
	if (!host.includes(".") || IPV4_HOST.test(host)) {
		throw new NonRetryableError(`onboardIcp: not a public hostname: ${domain}`);
	}
	return host;
}

/** Refuses the run once the account has spent its daily ceiling for today. */
async function refuseIfOverCeiling(
	env: Env,
	organizationId: string,
): Promise<void> {
	const spent = await organizationSpendToday(env, organizationId);
	if (spent >= config.spend.perAccountDailyDollars) {
		throw new NonRetryableError(
			`daily ceiling reached for this account: ${spent} of ${config.spend.perAccountDailyDollars} dollars`,
		);
	}
}

/**
 * The profile plus its cost as plain data, never the `CostLedger` instance
 * `buildIcp` returns it in: a `step.do` result is replayed from its
 * serialized form, which a class instance does not survive.
 */
type BuiltIcp = {
	description: string;
	seller: IcpSeller;
	costDollars: number;
};

async function buildAndPriceIcp(
	env: Env,
	domain: string,
	note: string | null,
): Promise<BuiltIcp> {
	const result = await buildIcp(env, domain, note);
	return {
		description: result.description,
		seller: result.seller,
		costDollars: result.ledger.total(),
	};
}

type PersistIcpInput = {
	env: Env;
	runId: string;
	organizationId: string;
	domain: string;
	built: BuiltIcp;
};

/**
 * Writes the profile, opens the run against it, and closes the run with the
 * ledger's total, all in one durable step. Returns the run's own `icpId`
 * rather than the row `createIcp` just inserted: a retried step that reaches
 * `createIcp` again would write a second icp row, and `openRun`'s replay
 * safety keeps the run pointed at whichever row won that race.
 */
async function persistIcp(input: PersistIcpInput): Promise<string> {
	const { env, runId, organizationId, domain, built } = input;
	const row = await createIcp(env, {
		domain,
		organizationId,
		description: built.description,
		seller: built.seller,
	});
	const runRow = await openRun(env, {
		id: runId,
		organizationId,
		icpId: row.id,
		capability: "onboarding",
		status: "running",
	});
	await closeRun(env, runId, {
		status: "complete",
		costDollars: built.costDollars,
	});
	return runRow.icpId;
}

/**
 * Reads a seller's own site into an ideal customer profile and stores it,
 * off the request path. Its spend counts against the account's daily
 * ceiling exactly as a companies or people run's does.
 */
export class OnboardIcpWorkflow extends WorkflowEntrypoint<
	Env,
	OnboardIcpPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<OnboardIcpPayload>>,
		step: WorkflowStep,
	): Promise<OnboardIcpSummary> {
		const payload = OnboardIcpPayloadSchema.parse(event.payload);
		const domain = publicHostname(payload.domain);

		await step.do("check-spend", config.stepConfig.databaseCall, () =>
			refuseIfOverCeiling(this.env, payload.organizationId),
		);

		const built = await step.do("build-icp", config.stepConfig.paidCall, () =>
			buildAndPriceIcp(this.env, domain, payload.note ?? null),
		);

		const icpId = await step.do(
			"save-icp",
			config.stepConfig.databaseCall,
			() =>
				persistIcp({
					env: this.env,
					runId: event.instanceId,
					organizationId: payload.organizationId,
					domain,
					built,
				}),
		);

		return { icpId, costDollars: built.costDollars };
	}
}
