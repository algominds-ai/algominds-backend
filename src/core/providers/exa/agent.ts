import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import type {
	ExaResult,
	ExaSearchRequest,
	ExaSearchResult,
} from "@/core/providers/exa/search";
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

const LINKEDIN_PROFILE_URL_PATTERN =
	/^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/?#]+\/?$/i;

/** A LinkedIn profile URL an agent reported, or null when it is not one. */
export const agentLinkedinUrl = z
	.string()
	.nullish()
	.transform((value) =>
		value && LINKEDIN_PROFILE_URL_PATTERN.test(value) ? value : null,
	);

const ExaAgentPersonSchema = z.object({
	name: z.string().nullish(),
	linkedinUrl: agentLinkedinUrl,
	title: z.string().nullish(),
	location: z.string().nullish(),
	companyName: z.string().nullish(),
});

/** One person as Exa's agent reports them, matching the `outputSchema` a caller sent to `startAgentRun`. */
export type ExaAgentPerson = z.infer<typeof ExaAgentPersonSchema>;

const ExaAgentPeopleOutputSchema = z.object({
	people: z.array(ExaAgentPersonSchema),
});

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

const ExaAgentErrorSchema = z.object({
	requestId: z.string().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
});

const TERMINAL_FAILURE_STATUSES: string[] = [
	"failed",
	"errored",
	"canceled",
	"cancelled",
];

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

const AGENT_FETCH_TIMEOUT_MS = 60_000;

async function exaAgentFetch(path: string, env: Env, init?: RequestInit) {
	const apiKey = await env.EXA_API_KEY.get();
	let response: Response;
	try {
		response = await fetch(`https://api.exa.ai/agent/runs${path}`, {
			...init,
			headers: { ...init?.headers, "x-api-key": apiKey },
			signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new RetryableProviderError("Exa agent request timed out");
		}
		throw error;
	}
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
 * Fetches one agent run's current state, parsing `output.structured`
 * against `structuredSchema`. A run still working reports partial text with
 * no structured payload, which reads as running rather than as a bad shape.
 * Reports its cost into `ledger` the moment it completes. Throws when the run
 * failed, errored, or was canceled, and when a body does not match the
 * expected shape.
 */
export async function getAgentRunOutput<T>(
	id: string,
	env: Env,
	ledger: CostLedger,
	structuredSchema: z.ZodType<T>,
): Promise<ExaAgentRunOutput<T>> {
	const body = await exaAgentFetch(`/${id}`, env);
	const parsed = AgentRunEnvelopeSchema.safeParse(body);
	if (!parsed.success) {
		throw new NonRetryableError(shapeMismatchDetail(body, parsed.error));
	}
	const run = parsed.data;
	if (TERMINAL_FAILURE_STATUSES.includes(run.status)) {
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
	const payload = structuredSchema.safeParse(structured);
	if (!payload.success) {
		throw new NonRetryableError(shapeMismatchDetail(body, payload.error));
	}
	const { total, ...rest } = run.costDollars;
	ledger.reported("exa", "agent", total, agentCostDetail(rest));
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

export type ExaAgentPeopleRun =
	| { status: "running" }
	| { status: "completed"; people: ExaAgentPerson[] };

/**
 * Fetches one agent run's current state for the people schema. A thin
 * wrapper over `getAgentRunOutput`, which carries the shared polling and
 * error-mapping contract.
 */
export async function getAgentPeopleRun(
	id: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentPeopleRun> {
	const run = await getAgentRunOutput(
		id,
		env,
		ledger,
		ExaAgentPeopleOutputSchema,
	);
	if (run.status !== "completed") return run;
	return { status: "completed", people: run.output.people };
}

const EXA_AGENT_PERSON_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string" },
		linkedinUrl: { type: "string" },
		title: { type: "string" },
		location: { type: "string" },
		companyName: { type: "string" },
	},
	required: ["name", "linkedinUrl"],
};

function agentQuery(query: string, count: number): string {
	return `${query} Return up to ${count} distinct people, each currently employed at the target company.`;
}

/**
 * Turns one Exa search request and the number of people wanted into an Exa
 * agent run request. The count reaches the agent as an upper bound in the
 * query text only. The schema sets no `minItems`, because a company may
 * genuinely employ fewer decision makers than asked for, and a pinned
 * minimum invites the agent to invent LinkedIn URLs to satisfy it.
 */
export function buildPersonAgentRunRequest(
	req: ExaSearchRequest,
	count: number,
	effort: ExaAgentRunRequest["effort"],
): ExaAgentRunRequest {
	return {
		query: agentQuery(req.query, count),
		systemPrompt:
			"Give a real, working LinkedIn profile URL for every person. Never repeat a person.",
		effort,
		dataSources: [{ provider: "fiber" }],
		outputSchema: {
			type: "object",
			properties: {
				people: {
					type: "array",
					items: EXA_AGENT_PERSON_SCHEMA,
				},
			},
			required: ["people"],
		},
	};
}

function toExaResult(
	person: ExaAgentPerson,
	companyName: string,
): ExaResult | null {
	const linkedinUrl = person.linkedinUrl;
	if (!linkedinUrl) return null;
	return {
		id: null,
		url: linkedinUrl,
		title: person.name ?? linkedinUrl,
		summary: null,
		company: null,
		person: {
			fullName: person.name ?? null,
			location: person.location ?? null,
			workHistory: [
				{
					title: person.title ?? null,
					from: null,
					current: true,
					companyId: null,
					companyName,
				},
			],
		},
	};
}

/**
 * Maps a completed agent run onto the same shape `search` returns, dropping
 * any person the agent gave no LinkedIn URL for. `companyName` is the
 * target company the run searched, carried by the caller since the agent's
 * response names no organization id for it.
 */
export function toExaSearchResult(
	requestId: string,
	people: readonly ExaAgentPerson[],
	companyName: string,
): ExaSearchResult {
	const results = people
		.map((person) => toExaResult(person, companyName))
		.filter((result): result is ExaResult => result !== null);
	return { requestId, results };
}
