import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
	FindCompaniesDeps,
	FindCompaniesOptions,
} from "../src/core/companies";
import { findCompanies } from "../src/core/companies";
import { CostLedger } from "../src/core/cost";
import { gate } from "../src/core/gate";
import type { Verdict } from "../src/core/judge";
import type { ExaResult, ExaSearchRequest } from "../src/core/providers/exa";
import type { IcpDoc } from "../src/core/synthesize";

const icp: IcpDoc = {
	description:
		"fintech companies at seed stage in San Francisco with a small team",
};

function rawResult(
	summary: Record<string, string> | null,
	overrides: { url?: string; title?: string } = {},
): ExaResult {
	const domain = summary?.domain ?? "example.com";
	return {
		url: overrides.url ?? `https://${domain}/careers`,
		title: overrides.title ?? summary?.name ?? "Example",
		summary,
	};
}

function goodResult(
	domain: string,
	extra: Record<string, string> = {},
): ExaResult {
	return rawResult({ name: `Company ${domain}`, domain, ...extra });
}

function missingDomainResult(id: number): ExaResult {
	return rawResult(
		{ name: `NoDomain${id}` },
		{ url: `https://example.com/missing-${id}` },
	);
}

function testOptions(
	overrides: Partial<FindCompaniesOptions> = {},
): FindCompaniesOptions {
	return { icpId: "icp-1", env: testEnv, ...overrides };
}

function scriptedSearch(rounds: ExaResult[][]) {
	const calls: ExaSearchRequest[] = [];
	const search: FindCompaniesDeps["search"] = async (req, _env, ledger) => {
		const results = rounds[calls.length] ?? [];
		calls.push(req);
		ledger.reported("exa", "search", 0.01);
		return { requestId: `req-${calls.length}`, results };
	};
	return { search, calls };
}

function scriptedSynthesize() {
	const feedbacks: Array<readonly string[]> = [];
	const synthesize: FindCompaniesDeps["synthesize"] = async (
		icpDoc,
		feedback,
	) => {
		feedbacks.push(feedback);
		const ledger = new CostLedger();
		ledger.reported("worker-model", "synthesize", 0.001);
		const suffix = feedback.length > 0 ? ` round-${feedbacks.length}` : "";
		return {
			query: `${icpDoc.description}${suffix}`,
			systemPrompt: "extract company fields",
			searchShape: { type: "neural" },
			ledger,
		};
	};
	return { synthesize, feedbacks };
}

function scriptedJudge(rejectsByCall: number[][]): FindCompaniesDeps["judge"] {
	let call = 0;
	return async (_icp, rows) => {
		const rejects = rejectsByCall[call] ?? [];
		call += 1;
		const ledger = new CostLedger();
		ledger.reported("reasoning-model", "judge", 0.002);
		const verdicts: Verdict[] = rows.map((_row, index) => ({
			index,
			keep: !rejects.includes(index),
			reason: rejects.includes(index) ? "does not fit icp" : "fits icp",
		}));
		return { verdicts, ledger };
	};
}

function recordingRecentDomains(domains: string[] = []) {
	const calls: Array<{ icpId: string; days: number }> = [];
	const recentDomains: FindCompaniesDeps["recentDomains"] = async (
		_env,
		icpId,
		days,
	) => {
		calls.push({ icpId, days });
		return domains;
	};
	return { recentDomains, calls };
}

describe("findCompanies — the three terminal states", () => {
	it("fills to the requested count across two rounds once the gate and judge have trimmed round one", async () => {
		const good = Array.from({ length: 8 }, (_, i) =>
			goodResult(`good${i}.com`),
		);
		const bad = Array.from({ length: 6 }, (_, i) => missingDomainResult(i));
		const more = Array.from({ length: 5 }, (_, i) =>
			goodResult(`more${i}.com`),
		);
		const { search, calls } = scriptedSearch([[...good, ...bad], more]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 10, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([[7], [3, 4]]),
		});

		expect(calls).toHaveLength(2);
		expect(result.status).toBe("complete");
		expect(result.rounds).toBe(2);
		expect(result.found).toBe(10);
		expect(result.companies).toHaveLength(10);
	});

	it("stops at round one, exhausted, without a second search call, when every row is already seen", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("seen.com"), goodResult("seen.com", { name: "Seen Again" })],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains(["seen.com"]);

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toHaveLength(1);
		expect(result.status).toBe("exhausted");
		expect(result.rounds).toBe(1);
		expect(result.companies).toHaveLength(0);
	});

	it("returns short with no throw when three rounds still fall short of the count", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("r1a.com"), goodResult("r1b.com")],
			[goodResult("r2a.com"), goodResult("r2b.com")],
			[goodResult("r3a.com"), goodResult("r3b.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 10, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toHaveLength(3);
		expect(result.status).toBe("short");
		expect(result.rounds).toBe(3);
		expect(result.companies).toHaveLength(6);
	});
});

describe("findCompanies — the gate outranks the count", () => {
	it("never returns a row the gate rejected, even when it would have met the count", async () => {
		const { search } = scriptedSearch([
			[goodResult("keep.com"), missingDomainResult(1)],
			[],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 2, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies).toHaveLength(1);
		expect(result.companies[0]?.domain).toBe("keep.com");
		expect(result.companies.some((c) => c.name?.startsWith("NoDomain"))).toBe(
			false,
		);
		expect(
			result.rejects.some(
				(r) => r.stage === "gate" && r.reason === "missing-required",
			),
		).toBe(true);
	});

	it("rejects a row whose signal echoes the search query, proving the query reaches the gate", async () => {
		const query = icp.description;
		const { search } = scriptedSearch([
			[goodResult("echo.com", { signal: query }), goodResult("clean.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 5, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.companies.some((c) => c.domain === "echo.com")).toBe(false);
		expect(
			result.rejects.some(
				(r) => r.domain === "echo.com" && r.reason === "echoes-query",
			),
		).toBe(true);
		expect(result.companies.some((c) => c.domain === "clean.com")).toBe(true);
	});
});

describe("findCompanies — round-to-round behaviour", () => {
	it("varies the query between rounds while keeping the ICP's scoping terms", async () => {
		const { search, calls } = scriptedSearch([
			[goodResult("v1.com"), missingDomainResult(1)],
			[goodResult("v2.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		await findCompanies(icp, 10, testOptions({ maxRounds: 2 }), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toHaveLength(2);
		const [first, second] = calls;
		expect(first?.query).not.toBe(second?.query);
		for (const call of calls) {
			expect(call.query).toContain("fintech");
			expect(call.query).toContain("seed");
			expect(call.query).toContain("San Francisco");
		}
	});

	it("reports costDollars as the merged total across every round and both model calls", async () => {
		const { search } = scriptedSearch([
			[goodResult("cost1.com")],
			[goodResult("cost2.com")],
		]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 2, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.rounds).toBe(2);
		expect(result.costDollars).toBeCloseTo(2 * (0.001 + 0.01 + 0.002), 9);
	});
});

describe("findCompanies — dependency wiring", () => {
	it("reads seen domains through the injected recentDomains dependency", async () => {
		const { search } = scriptedSearch([[goodResult("acme.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains, calls } = recordingRecentDomains(["known.com"]);

		await findCompanies(icp, 1, testOptions({ icpId: "icp-42" }), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(calls).toEqual([{ icpId: "icp-42", days: 90 }]);
	});

	it("runs as a plain function call, with no Hono context and no WorkflowStep", async () => {
		const { search } = scriptedSearch([[goodResult("plain.com")]]);
		const { synthesize } = scriptedSynthesize();
		const { recentDomains } = recordingRecentDomains();

		const result = await findCompanies(icp, 1, testOptions(), {
			recentDomains,
			synthesize,
			search,
			gate,
			judge: scriptedJudge([]),
		});

		expect(result.status).toBe("complete");
		expect(result.companies).toHaveLength(1);
	});
});
