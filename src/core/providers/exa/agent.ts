import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { exaFetch, extractRequestId } from "@/core/providers/exa/http";
import {
	CompanyEvidenceSchema,
	CompanyRecordSchema,
	nullableString,
} from "@/core/providers/exa/search";

const JsonValueSchema = z.json();

const EXA_AGENT_EFFORTS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"auto",
	"max",
] as const;

const EXA_AGENT_PROVIDERS = [
	"fiber",
	"financial_datasets",
	"similarweb",
	"baselayer",
	"affiliate",
	"particle",
	"jinko",
] as const;

const ExaAgentRunRequestSchema = z.object({
	query: z.string(),
	input: z
		.object({
			exclusion: z.array(z.record(z.string(), JsonValueSchema)).optional(),
			data: z.array(z.record(z.string(), JsonValueSchema)).optional(),
		})
		.optional(),
	systemPrompt: z.string().optional(),
	outputSchema: JsonValueSchema,
	effort: z.enum(EXA_AGENT_EFFORTS).optional(),
	dataSources: z
		.array(z.object({ provider: z.enum(EXA_AGENT_PROVIDERS) }))
		.max(5)
		.optional(),
});

/** The fields a caller may send to `startAgentRun`, before defaults are applied. */
export type ExaAgentRunRequest = z.input<typeof ExaAgentRunRequestSchema>;

const ExaAgentStartResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

const ExaAgentCostSchema = z.object({
	total: z.number().finite().nonnegative(),
	agentCompute: z.number().nullish(),
	search: z.number().nullish(),
	emails: z.number().nullish(),
	phoneNumbers: z.number().nullish(),
});

/** A LinkedIn company page, which is `/company/<name>`, never the `/in/<name>` of a person. */
export const LINKEDIN_COMPANY_URL_PATTERN =
	"^(https?://)?([a-z]{2,3}\\.)?linkedin\\.com/company/[^\\s/?#]+/?$";

const linkedinCompanyUrl = z
	.string()
	.nullish()
	.transform((value) =>
		value && new RegExp(LINKEDIN_COMPANY_URL_PATTERN, "i").test(value)
			? value
			: null,
	);

/** The shared company record plus the fields only the agent can give: the company's own site, its LinkedIn page, and the page that proves the signal. */
export const ExaAgentCompanySchema = CompanyRecordSchema.extend({
	website: nullableString,
	linkedinUrl: linkedinCompanyUrl,
	evidence: z.array(CompanyEvidenceSchema),
});

/** One company as Exa's agent reports it, matching the `outputSchema` a caller sent to `startAgentRun`. */
export type ExaAgentCompany = z.infer<typeof ExaAgentCompanySchema>;

/** An agent that finds nothing reports `companies: null`, which is an empty round and not a bad shape. */
const ExaAgentStructuredOutputSchema = z.object({
	companies: z
		.array(ExaAgentCompanySchema)
		.nullable()
		.transform((companies) => companies ?? []),
});

const LINKEDIN_PROFILE_URL_PATTERN =
	/^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/?#]+\/?$/i;

/** A LinkedIn profile URL an agent reported, or null when it is not one. */
export const agentLinkedinUrl = z
	.string()
	.nullish()
	.transform((value) =>
		value && LINKEDIN_PROFILE_URL_PATTERN.test(value) ? value : null,
	);

const AgentRunEnvelopeSchema = z.object({
	id: z.string(),
	status: z.string(),
	output: z
		.object({
			text: z.string().optional(),
			structured: z.unknown().nullish(),
		})
		.nullish(),
	costDollars: ExaAgentCostSchema.nullish(),
});

const TERMINAL_FAILURE_STATUSES: string[] = [
	"failed",
	"errored",
	"canceled",
	"cancelled",
];

const RawTerminalRunSchema = z.object({
	status: z.string().optional(),
	costDollars: ExaAgentCostSchema.nullish(),
});

const EXA_AGENT_COST_KEYS = [
	"agentCompute",
	"search",
	"emails",
	"phoneNumbers",
] as const;

function agentCostDetail(
	cost: Omit<z.infer<typeof ExaAgentCostSchema>, "total">,
): Record<string, number> {
	const detail: Record<string, number> = {};
	for (const key of EXA_AGENT_COST_KEYS) {
		const value = cost[key];
		if (typeof value === "number") detail[key] = value;
	}
	return detail;
}

function reportAgentCost(
	cost: z.infer<typeof ExaAgentCostSchema>,
	ledger: CostLedger,
): void {
	const { total, ...rest } = cost;
	ledger.reported("exa", "agent", total, agentCostDetail(rest));
}

function reportMalformedTerminalCost(body: unknown, ledger: CostLedger): void {
	const parsed = RawTerminalRunSchema.safeParse(body);
	if (!parsed.success || !parsed.data.costDollars) return;
	const terminal =
		parsed.data.status === "completed" ||
		(parsed.data.status !== undefined &&
			TERMINAL_FAILURE_STATUSES.includes(parsed.data.status));
	if (terminal) reportAgentCost(parsed.data.costDollars, ledger);
}

async function exaAgentFetch(path: string, env: Env, init?: RequestInit) {
	const apiKey = await env.EXA_API_KEY.get();
	return exaFetch(
		`https://api.exa.ai/agent/runs${path}`,
		{ ...init, headers: { ...init?.headers, "x-api-key": apiKey } },
		"Exa agent",
		"Exa agent request timed out",
	);
}

/**
 * Starts one Exa agent run and returns its id. The run keeps working after
 * this call returns; poll it with `getAgentRun`.
 */
export async function startAgentRun(
	req: ExaAgentRunRequest,
	env: Env,
): Promise<{ id: string }> {
	const validated = ExaAgentRunRequestSchema.parse(req);
	const body = await exaAgentFetch("", env, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(validated),
	});
	const parsed = ExaAgentStartResponseSchema.safeParse(body);
	if (!parsed.success) {
		throw new NonRetryableError(
			"Exa agent: start response did not match the expected shape",
		);
	}
	return { id: parsed.data.id };
}

export type ExaAgentRunOutput<T> =
	| { status: "running" }
	| { status: "completed"; output: T };

/** Names the fields that did not match, so a vendor change is legible without a re-run. */
function shapeMismatchDetail(body: unknown, error: z.ZodError): string {
	const issues = error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
	const requestId = extractRequestId(body);
	const where = requestId ? ` (requestId ${requestId})` : "";
	return `Exa agent: response did not match the expected shape${where} — ${issues}`;
}

/**
 * Fetches one agent run's current state, parsing `output.structured` against `structuredSchema`.
 * Returns the run output or throws if the run failed, errored, or was canceled.
 */
export async function getAgentRunOutput<T>(
	id: string,
	env: Env,
	ledger: CostLedger,
	structuredSchema: z.ZodType<T>,
): Promise<ExaAgentRunOutput<T>> {
	const body = await exaAgentFetch(`/${encodeURIComponent(id)}`, env);
	const parsed = AgentRunEnvelopeSchema.safeParse(body);
	if (!parsed.success) {
		reportMalformedTerminalCost(body, ledger);
		throw new NonRetryableError(shapeMismatchDetail(body, parsed.error));
	}
	const run = parsed.data;
	if (TERMINAL_FAILURE_STATUSES.includes(run.status)) {
		if (run.costDollars) reportAgentCost(run.costDollars, ledger);
		throw new NonRetryableError(
			`Exa agent run ${id} ended with status "${run.status}"`,
		);
	}
	const structured = run.output?.structured;
	if (
		run.status !== "completed" ||
		structured === null ||
		structured === undefined ||
		!run.costDollars
	) {
		return { status: "running" };
	}
	reportAgentCost(run.costDollars, ledger);
	const payload = structuredSchema.safeParse(structured);
	if (!payload.success) {
		throw new NonRetryableError(shapeMismatchDetail(body, payload.error));
	}
	return { status: "completed", output: payload.data };
}

export type ExaAgentRun =
	| { status: "running" }
	| { status: "completed"; companies: ExaAgentCompany[] };

/**
 * Fetches one agent run's current state for the companies schema. A thin
 * wrapper over `getAgentRunOutput`, which carries the shared polling and
 * error-mapping contract.
 */
export async function getAgentRun(
	id: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentRun> {
	const run = await getAgentRunOutput(
		id,
		env,
		ledger,
		ExaAgentStructuredOutputSchema,
	);
	if (run.status !== "completed") return run;
	return { status: "completed", companies: run.output.companies };
}

/** Cancels an agent, or reads its settlement when cancel is false, preserving missing billing as null. */
export async function cancelAgentRun(
	id: string,
	env: Env,
	cancel = true,
): Promise<{
	status: string;
	terminal: boolean;
	costDollars: number | null;
}> {
	const body = await exaAgentFetch(
		`/${encodeURIComponent(id)}${cancel ? "/cancel" : ""}`,
		env,
		cancel
			? {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				}
			: {},
	);
	const run = AgentRunEnvelopeSchema.parse(body);
	return {
		status: run.status,
		terminal:
			run.status === "completed" ||
			TERMINAL_FAILURE_STATUSES.includes(run.status),
		costDollars: run.costDollars?.total ?? null,
	};
}
