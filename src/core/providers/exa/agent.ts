import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { CostLedger } from "@/core/cost";
import {
	CompanyRecordSchema,
	nullableString,
} from "@/core/providers/exa/search";
import { EXA_FETCH_TIMEOUT_MS } from "@/core/providers/exa/timeout";
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
	signal: nullableString,
	evidenceUrl: nullableString,
	evidenceDate: nullableString,
	evidenceQuote: nullableString,
	evidencePublisher: nullableString,
	evidenceKind: nullableString,
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

async function exaAgentFetch(path: string, env: Env, init?: RequestInit) {
	const apiKey = await env.EXA_API_KEY.get();
	let response: Response;
	try {
		response = await fetch(`https://api.exa.ai/agent/runs${path}`, {
			...init,
			headers: { ...init?.headers, "x-api-key": apiKey },
			signal: AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS),
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

const EVIDENCE_KINDS = [
	"first_party",
	"press",
	"aggregator",
	"linkedin",
] as const;

/** The measured verification schema: a closed verdict, its evidence, and the kind of page it came from. */
export const ExaAgentVerdictSchema = z.object({
	verdict: z.enum(["CONFIRMED", "CONTRADICTED", "UNKNOWN"]),
	evidence_url: z.string().nullable(),
	evidence_quote: z.string().nullable(),
	evidence_kind: z.enum(EVIDENCE_KINDS).nullable(),
	confidence: z.number().min(0).max(1).nullable(),
});

export type ExaAgentVerdict = z.infer<typeof ExaAgentVerdictSchema>;

export type VerdictRunInput = {
	name: string;
	title: string;
	company: string;
	domain: string;
};

function verdictQuery(input: VerdictRunInput): string {
	return [
		`Does ${input.name} currently hold the title "${input.title}" at`,
		`${input.company} (${input.domain})?`,
		"Prefer evidence from the company's own site or independent press coverage",
		"over data aggregators or LinkedIn itself.",
		"Copy the sentence that proves your answer word for word into",
		"`evidence_quote`, exactly as it appears on the page.",
		"Put the kind of page the evidence came from into `evidence_kind`:",
		"`first_party` for the company's own site, `press` for independent news",
		"coverage, `aggregator` for a data aggregator derived from LinkedIn, or",
		"`linkedin` for a LinkedIn page itself.",
	].join(" ");
}

const { $schema: _verdictSchema, ...verdictSchema } = z.toJSONSchema(
	ExaAgentVerdictSchema,
	{ io: "input" },
);
const VERDICT_OUTPUT_SCHEMA = z.json().parse(verdictSchema);

/**
 * Builds one Exa agent run request asking whether `name` currently holds
 * `title` at `company`, at the measured effort `minimal`.
 */
export function buildVerdictRunRequest(
	input: VerdictRunInput,
): ExaAgentRunRequest {
	return {
		query: verdictQuery(input),
		effort: "minimal",
		outputSchema: VERDICT_OUTPUT_SCHEMA,
	};
}

/**
 * Fetches one agent run's current state for the verification verdict
 * schema. A thin wrapper over `getAgentRunOutput`, beside `getAgentRun`.
 */
export async function getAgentVerdictRun(
	id: string,
	env: Env,
	ledger: CostLedger,
): Promise<ExaAgentRunOutput<ExaAgentVerdict>> {
	return getAgentRunOutput(id, env, ledger, ExaAgentVerdictSchema);
}
