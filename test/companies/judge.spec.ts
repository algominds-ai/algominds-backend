import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import { judge } from "@/core/companies/judge";
import { JudgeModelSchema } from "@/core/companies/judge-evidence";
import { conditionRefs } from "@/core/requirements";
import { fakeGatewayEnv } from "../support/env";
import {
	chatCompletionResponse,
	deferredGateway,
	fakeGateway,
} from "../support/fetch";
import { requirementFixture } from "../support/icp";

const requirements = [
	requirementFixture(
		"the company is a seed stage fintech in San Francisco with a small team",
	),
	requirementFixture(
		"the company posted a founding engineer role in the last thirty days",
		"preferred",
	),
];
const requirementId = conditionRefs(requirements)[0]?.id ?? "r1.a1.c1";

function row(name: string, domain: string): CompanyRow {
	return {
		name,
		domain,
		linkedinUrl: `https://linkedin.com/company/${domain.split(".")[0]}`,
		record: null,
		description: null,
	};
}

const rows: CompanyRow[] = [
	row("Acme", "acme.com"),
	row("Zenith", "zenith.com"),
	row("Sable", "sable.com"),
];

const RequestBodySchema = z.object({
	model: z.string(),
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

function bodyOf(
	call: { body: unknown } | undefined,
): z.infer<typeof RequestBodySchema> {
	if (!call) throw new Error("expected a captured request");
	return RequestBodySchema.parse(call.body);
}

function objectReply(
	value: unknown,
	cost?: number | null,
): { content: string; cost?: number | null } {
	return cost === undefined
		? { content: JSON.stringify(value) }
		: { content: JSON.stringify(value), cost };
}

function verdictsFor(rowSet: readonly CompanyRow[]) {
	return {
		verdicts: rowSet.map((_row, index) => {
			const keep = index !== 1;
			return {
				index,
				statuses: [
					{
						id: requirementId,
						status: keep ? "proven" : "contradicted",
						sourceUrl: null,
						date: null,
					},
				],
				reason: keep ? "fits the profile" : "no qualifying signal",
			};
		}),
	};
}

function kept(verdict: {
	statuses: ReadonlyArray<{ status: string }>;
}): boolean {
	return verdict.statuses.every((entry) => entry.status === "proven");
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("judge: gateway wiring", () => {
	it("sends cf-aig-authorization to a URL under /compat, selecting MODEL_ROUTE_REASONING", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;
		const env = fakeGatewayEnv();

		await judge(requirements, rows, env);

		const call = gateway.calls[0];
		expect(call?.headers.get("cf-aig-authorization")).toBe(
			"Bearer test-aig-token",
		);
		expect(new URL(String(call?.url)).pathname).toContain("/compat");
		expect(bodyOf(call).model).toBe(env.MODEL_ROUTE_REASONING);
	});

	it("reports the gateway's returned cost on the ledger, zero when the body carries none", async () => {
		const withCost = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows), 0.0000091)),
		]);
		globalThis.fetch = withCost.fetch;
		const costed = await judge(requirements, rows, fakeGatewayEnv());
		expect(costed.ledger.total()).toBeCloseTo(0.0000091, 12);

		const withoutCost = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows), null)),
		]);
		globalThis.fetch = withoutCost.fetch;
		const uncosted = await judge(requirements, rows, fakeGatewayEnv());
		expect(uncosted.ledger.total()).toBe(0);
	});
});

describe("judge: verdicts and retries", () => {
	it("returns one verdict per input row, indices matching input order", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, fakeGatewayEnv());

		expect(result.verdicts).toHaveLength(rows.length);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
		});
		expect(kept(result.verdicts[1] ?? { statuses: [] })).toBe(false);
	});

	it("falls back after a schema failure without retrying the provider", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, fakeGatewayEnv());

		expect(gateway.calls).toHaveLength(1);
		expect(result.verdicts).toHaveLength(rows.length);
	});
});

describe("the judge is told which requirements need a status", () => {
	function userMessage(call: { body: unknown } | undefined): string {
		return bodyOf(call)
			.messages.map((message) => message.content)
			.join("\n");
	}

	it("asks only for eligibility requirements, omitting optional preferences", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, fakeGatewayEnv());

		const sent = userMessage(gateway.calls[0]);
		expect(sent).toContain(
			`${requirementId} the company is a seed stage fintech`,
		);
		expect(sent).not.toContain("preferred: r2.a1.c1");
		expect(sent).not.toContain("the company posted a founding engineer role");
	});

	it("states the acquisition and competitor interpretation rules", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, fakeGatewayEnv());

		const sent = userMessage(gateway.calls[0]);
		expect(sent).toContain(
			"Acquisition alone does not prove a business stopped operating",
		);
		expect(sent).toContain("what it sells");
		expect(sent).toContain("an exact category label is unnecessary");
		expect(sent).toContain(
			"Do not add requirements for independence, exclusivity, or a core business unless specified",
		);
		expect(sent).toContain(
			"numeric and date claims still need direct evidence",
		);
	});
});

describe("the kind of page a row came from is a label, not something the judge weighs", () => {
	it("sends only the fields a verdict can rest on, and bounds the description length", async () => {
		const long = "x".repeat(config.companies.descriptionChars + 200);
		const labelled: CompanyRow[] = [
			{
				...row("Acme", "acme.com"),
				description: long,
			},
		];
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(labelled))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, labelled, fakeGatewayEnv());

		const sent = bodyOf(gateway.calls[0])
			.messages.map((m) => m.content)
			.join("\n");
		expect(sent).toContain("acme.com");
		expect(sent).not.toContain(long);
		expect(sent).toContain("x".repeat(config.companies.descriptionChars));
		expect(sent).not.toContain("evidenceKind");
		expect(sent).not.toContain("industry");
		expect(sent).not.toContain("linkedinUrl");
		expect(sent).not.toContain("sameOrganizationAs");
		expect(sent).not.toContain("identityAllowed");
		expect(sent).not.toContain("Return linkedinUrl");
		expect(JudgeModelSchema.shape.verdicts.element.keyof().options).toEqual([
			"index",
			"statuses",
			"reason",
		]);
	});
});

function rowCountIn(call: { body: unknown } | undefined): number {
	const sent = bodyOf(call)
		.messages.map((message) => message.content)
		.join("\n");
	return (sent.match(/^\d+: /gm) ?? []).length;
}

describe("judge: slicing a large batch into concurrent, ordered calls", () => {
	it("sends 40 rows as ten concurrent calls of 4, and returns every index in row order however the calls resolve", async () => {
		const bigRows: CompanyRow[] = Array.from({ length: 40 }, (_, i) =>
			row(`Company ${i}`, `co${i}.com`),
		);
		const gateway = deferredGateway();
		globalThis.fetch = gateway.fetch;

		const pending = judge(requirements, bigRows, fakeGatewayEnv());

		for (let i = 0; i < 200; i++) await Promise.resolve();
		expect(gateway.calls).toHaveLength(10);
		const sizes = gateway.calls.map((call) => rowCountIn(call));
		expect(sizes).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);

		for (const callIndex of [9, 4, 7, 2, 0, 6, 3, 8, 1, 5]) {
			const size = sizes[callIndex] ?? 0;
			const verdicts = Array.from({ length: size }, (_, i) => ({
				index: i,
				statuses: [
					{
						id: requirementId,
						status: "proven",
						sourceUrl: null,
						date: null,
					},
				],
				reason: "fits the profile",
			}));
			gateway.resolvers[callIndex]?.(
				chatCompletionResponse(objectReply({ verdicts })),
			);
		}

		const result = await pending;

		expect(result.verdicts).toHaveLength(40);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
		});
	});
});
