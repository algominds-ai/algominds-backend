import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import type { CostLedger } from "@/core/cost";
import { normalizeDomain } from "@/core/db/schema";
import {
	EXA_FETCH_TIMEOUT_MS,
	readJson,
	throwForStatus,
} from "@/core/providers/exa/http";
import type { Requirement } from "@/core/requirements";

const {
	provingResults: PROVING_RESULTS,
	provingConcurrency: PROVING_CONCURRENCY,
	contentsMaxCharacters: CONTENTS_MAX_CHARACTERS,
} = config.companies;

const ProvingResultSchema = z.object({
	url: z.string(),
	title: z.string().nullish(),
	publishedDate: z.string().nullish(),
	text: z.string().nullish(),
	highlights: z.array(z.string()).nullish(),
});

const ProvingResponseSchema = z.object({
	requestId: z.string(),
	costDollars: z.object({ total: z.number() }),
	results: z.array(ProvingResultSchema),
});

/** One page cited for one company, with the sentence the vendor drew from it and the page text that sentence came from. */
export type ProvingHit = {
	url: string;
	quote: string;
	publishedDate: string | null;
	text: string;
};

type ProvingRequest = {
	query: string;
	numResults: number;
	type: "fast";
	includeDomains?: string[];
	contents: {
		text: { maxCharacters: number };
		highlights: { query: string };
	};
};

async function postProvingSearch(
	request: ProvingRequest,
	env: Env,
	ledger: CostLedger,
): Promise<ProvingHit | null> {
	const apiKey = await env.EXA_API_KEY.get();
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "x-api-key": apiKey, "content-type": "application/json" },
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(EXA_FETCH_TIMEOUT_MS),
	});
	const body = await readJson(response);
	if (!response.ok) throwForStatus("Exa proving", response.status, body);
	const parsed = ProvingResponseSchema.safeParse(body);
	if (!parsed.success) return null;
	ledger.reported("exa", "prove", parsed.data.costDollars.total);
	for (const result of parsed.data.results) {
		const quote = result.highlights?.[0];
		if (!quote) continue;
		return {
			url: result.url,
			quote,
			publishedDate: result.publishedDate ?? null,
			text: result.text ?? "",
		};
	}
	return null;
}

function provingRequest(
	query: string,
	requirementText: string,
	domain: string | null,
): ProvingRequest {
	return {
		query,
		numResults: PROVING_RESULTS,
		type: "fast",
		...(domain ? { includeDomains: [domain] } : {}),
		contents: {
			text: { maxCharacters: CONTENTS_MAX_CHARACTERS },
			highlights: { query: requirementText },
		},
	};
}

/**
 * One company's cheapest lookup for the page proving one requirement: a
 * search restricted to the company's own domain, then, only when that finds
 * nothing, one open search naming the company. Resolves null when neither
 * returns a page carrying a sentence about the requirement.
 */
export async function proveRequirement(
	row: CompanyRow,
	requirement: Requirement,
	env: Env,
	ledger: CostLedger,
): Promise<ProvingHit | null> {
	const name = row.name ?? row.domain ?? "";
	const domain = row.domain === null ? null : normalizeDomain(row.domain);
	if (domain === null) return null;
	const scoped = await postProvingSearch(
		provingRequest(`${name}: ${requirement.text}`, requirement.text, domain),
		env,
		ledger,
	);
	if (scoped) return scoped;
	return postProvingSearch(
		provingRequest(
			`${name} (${domain}): ${requirement.text}`,
			requirement.text,
			null,
		),
		env,
		ledger,
	);
}

export type ProvenRow = { index: number; hit: ProvingHit | null };

/**
 * Runs the proving lookup for every candidate, `provingConcurrency` at a time
 * so a round stays inside Exa's ten-requests-a-second limit. A row whose
 * lookup finds nothing comes back with a null hit and stays unproven.
 */
export async function proveRows(
	rows: readonly CompanyRow[],
	requirement: Requirement,
	env: Env,
	ledger: CostLedger,
): Promise<ProvenRow[]> {
	const proven: ProvenRow[] = [];
	for (let at = 0; at < rows.length; at += PROVING_CONCURRENCY) {
		const slice = rows.slice(at, at + PROVING_CONCURRENCY);
		const hits = await Promise.all(
			slice.map(async (row, offset) => ({
				index: at + offset,
				hit: await proveRequirement(row, requirement, env, ledger),
			})),
		);
		proven.push(...hits);
	}
	return proven;
}

/** One proved row with its page attached as the evidence the judge reads, so proof reaches the judge in the same shape an agent round produces. */
export function withEvidence(
	row: CompanyRow,
	hit: ProvingHit,
	requirement: Requirement,
): CompanyRow {
	return {
		...row,
		evidenceUrl: hit.url,
		evidenceQuote: hit.quote,
		evidenceDate: hit.publishedDate,
		signal: requirement.text,
	};
}
