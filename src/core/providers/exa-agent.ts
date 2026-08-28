import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import { RetryableProviderError } from "@/core/providers/waterfall";

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
	total: z.number(),
	agentCompute: z.number().nullish(),
	search: z.number().nullish(),
	emails: z.number().nullish(),
	phoneNumbers: z.number().nullish(),
});

const ExaAgentCompanySchema = z.object({
	name: z.string().nullish(),
	website: z.string().nullish(),
	description: z.string().nullish(),
	foundedYear: z.number().nullish(),
	workforceTotal: z.number().nullish(),
	city: z.string().nullish(),
	country: z.string().nullish(),
	revenueAnnual: z.number().nullish(),
	fundingTotal: z.number().nullish(),
});

/** One company as Exa's agent reports it, matching the `outputSchema` a caller sent to `startAgentRun`. */
export type ExaAgentCompany = z.infer<typeof ExaAgentCompanySchema>;

const ExaAgentStructuredOutputSchema = z.object({
	companies: z.array(ExaAgentCompanySchema),
});

const ExaAgentRunResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
	output: z
		.object({
			text: z.string().optional(),
			structured: ExaAgentStructuredOutputSchema,
		})
		.optional(),
	costDollars: ExaAgentCostSchema.optional(),
});

const ExaAgentErrorSchema = z.object({
	requestId: z.string().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
});

const TERMINAL_FAILURE_STATUSES: string[] = ["failed", "errored", "canceled"];

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

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return {};
	}
}

function extractRequestId(body: unknown): string | undefined {
	const parsed = ExaAgentErrorSchema.safeParse(body);
	return parsed.success ? parsed.data.requestId : undefined;
}

function throwForStatus(status: number, body: unknown): never {
	const parsed = ExaAgentErrorSchema.safeParse(body);
	const requestId = extractRequestId(body);
	const reason = parsed.success
		? (parsed.data.message ?? parsed.data.error ?? `status ${status}`)
		: `status ${status}`;
	const detail = requestId
		? `Exa agent request failed: ${reason} (requestId ${requestId})`
		: `Exa agent request failed: ${reason}`;
	if (status === 429 || status >= 500) throw new RetryableProviderError(detail);
	throw new NonRetryableError(detail);
}

async function exaAgentFetch(path: string, env: Env, init?: RequestInit) {
	const apiKey = await env.EXA_API_KEY.get();
	const response = await fetch(`https://api.exa.ai/agent/runs${path}`, {
		...init,
		headers: { ...init?.headers, "x-api-key": apiKey },
	});
	const body = await readJson(response);
	if (!response.ok) throwForStatus(response.status, body);
	return body;
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

export type ExaAgentRun =
	| { status: "running" }
	| { status: "completed"; companies: ExaAgentCompany[] };

/**
 * Fetches one agent run's current state. Reports its cost into `ledger` the
 * moment it completes. Throws when the run failed, errored, or was
 * canceled, and when a completed run's body does not match the expected
 * shape.
 */
export async function getAgentRun(
	id: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentRun> {
	const body = await exaAgentFetch(`/${id}`, env);
	const parsed = ExaAgentRunResponseSchema.safeParse(body);
	if (!parsed.success) {
		const requestId = extractRequestId(body);
		const detail = requestId
			? `Exa agent: response did not match the expected shape (requestId ${requestId})`
			: "Exa agent: response did not match the expected shape";
		throw new NonRetryableError(detail);
	}
	const run = parsed.data;
	if (TERMINAL_FAILURE_STATUSES.includes(run.status)) {
		throw new NonRetryableError(
			`Exa agent run ${id} ended with status "${run.status}"`,
		);
	}
	if (run.status !== "completed" || !run.output || !run.costDollars) {
		return { status: "running" };
	}
	const { total, ...rest } = run.costDollars;
	ledger.reported("exa", "agent", total, agentCostDetail(rest));
	return { status: "completed", companies: run.output.structured.companies };
}
