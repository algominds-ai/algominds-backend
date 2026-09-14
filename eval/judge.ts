import type { Expected, Input, Output, Suite } from "@eval/schema";
import { invoke } from "braintrust";
import { z } from "zod";
import { publicDomain } from "@/core/db/schema";

const ScoreSchema = z.object({
	score: z.number().min(0).max(1).nullable(),
	metadata: z.json().optional(),
});

function decodedJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function publicUrl(value: string): string[] {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && publicDomain(url.hostname) !== null
			? [url.href]
			: [];
	} catch {
		return [];
	}
}

export function sourceUrls(value: unknown): string[] {
	if (typeof value === "string") {
		if (value.startsWith("{") || value.startsWith("["))
			return sourceUrls(decodedJson(value));

		return publicUrl(value);
	}
	if (Array.isArray(value)) return value.flatMap(sourceUrls);
	if (value !== null && typeof value === "object")
		return Object.values(value).flatMap(sourceUrls);
	return [];
}

const ContentsSchema = z.object({
	results: z.array(z.object({ url: z.string(), text: z.string().nullish() })),
	costDollars: z.object({ total: z.number().nonnegative() }),
});

export async function verifySources(output: Output): Promise<Output> {
	const urls = [
		...new Set([
			...sourceUrls(output.entities),
			...sourceUrls(output.evidence),
			...sourceUrls(output.profile?.seller.sourceUrls),
		]),
	].slice(0, 30);
	if (!urls.length) return { ...output, verificationCostDollars: 0 };
	const key = process.env.EXA_API_KEY;
	if (!key)
		throw new Error("eval: EXA_API_KEY required for independent source reads");
	const response = await fetch("https://api.exa.ai/contents", {
		method: "POST",
		headers: { "x-api-key": key, "content-type": "application/json" },
		body: JSON.stringify({
			urls,
			text: { maxCharacters: 10000 },
			maxAgeHours: 0,
		}),
		signal: AbortSignal.timeout(60000),
	});
	if (!response.ok)
		throw new Error(
			`eval: source read failed ${response.status}; spend may be unresolved`,
		);
	const result = ContentsSchema.parse(await response.json());
	return {
		...output,
		verificationCostDollars: result.costDollars.total,
		evidence: [
			...output.evidence,
			...result.results
				.filter((row) => row.text)
				.map((row) => ({
					subject: row.url,
					kind: "independent-source-text",
					source: row.url,
					value: row.text ?? "",
					seenAt: new Date().toISOString(),
				})),
		],
	};
}

export function qualityScorer(suite: Suite, version: string) {
	return async ({
		input,
		output,
		expected,
	}: {
		input: Input;
		output: Output;
		expected?: Expected;
	}) => {
		if (output.error || output.status !== "complete")
			return { name: "evidence_supported_quality", score: 0 };
		const result = ScoreSchema.parse(
			await invoke({
				projectName: "algo-backend",
				slug: `${suite}-quality`,
				version,
				input: { input, output, expected },
			}),
		);
		return {
			name: "evidence_supported_quality",
			score: result.score,
			metadata: { judgment: result.metadata ?? null },
		};
	};
}
