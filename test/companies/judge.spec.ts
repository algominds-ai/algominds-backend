import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { config } from "@/config";
import type { CompanyRow } from "@/core/companies/gate";
import { judge } from "@/core/companies/judge";
import type { Requirement } from "@/core/requirements";
import { fakeGatewayEnv } from "../support/env";
import {
	chatCompletionResponse,
	deferredGateway,
	fakeGateway,
} from "../support/fetch";

const requirements: Requirement[] = [
	{
		id: "r1",
		text: "the company is a seed stage fintech in San Francisco with a small team",
		kind: "hard",
		proof: "record",
		windowDays: null,
	},
	{
		id: "r2",
		text: "the company posted a founding engineer role in the last thirty days",
		kind: "soft",
		proof: "page",
		windowDays: 30,
	},
];

function row(name: string, domain: string): CompanyRow {
	return {
		name,
		domain,
		linkedinUrl: null,
		evidenceUrl: `https://${domain}/careers`,
		evidenceQuote: null,
		evidencePublisher: null,
		evidenceKind: null,
		industry: null,
		description: null,
		signal: "hiring a founding engineer",
		evidenceDate: "2026-08-20",
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
				statuses: [{ id: "r1", status: keep ? "proven" : "contradicted" }],
				soft: [],
				reason: keep ? "fits the profile" : "no qualifying signal",
				sameOrganizationAs: null,
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

	it("sends cf-aig-cache-ttl and never cf-aig-skip-cache, even on a retry", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, fakeGatewayEnv());

		expect(gateway.calls).toHaveLength(2);
		for (const call of gateway.calls) {
			expect(call.headers.get("cf-aig-cache-ttl")).toBeTruthy();
			expect(call.headers.has("cf-aig-skip-cache")).toBe(false);
		}
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

	it("carries each row's own reason through to the caller, kept or refused", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, fakeGatewayEnv());

		expect(result.verdicts[0]?.reason).toBe("fits the profile");
		expect(result.verdicts[1]?.reason).toBe("no qualifying signal");
	});

	it("retries once after a schema failure and returns the retry's result", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "not json at all" }),
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, fakeGatewayEnv());

		expect(gateway.calls).toHaveLength(2);
		expect(result.verdicts).toHaveLength(rows.length);
	});

	it("falls back to every hard requirement unproven after two consecutive failures, without throwing", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse({ content: "", finishReason: "length" }),
			chatCompletionResponse({ content: "", finishReason: "length" }),
		]);
		globalThis.fetch = gateway.fetch;

		const result = await judge(requirements, rows, fakeGatewayEnv());

		expect(result.verdicts).toHaveLength(rows.length);
		expect(result.verdicts.every(kept)).toBe(false);
		for (const verdict of result.verdicts) {
			expect(verdict.statuses).toEqual([{ id: "r1", status: "unproven" }]);
		}
	});
});

describe("the judge is told which requirements need a status", () => {
	function userMessage(call: { body: unknown } | undefined): string {
		return bodyOf(call)
			.messages.map((message) => message.content)
			.join("\n");
	}

	it("asks for a status on every hard requirement by id, and lists soft ones apart", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		await judge(requirements, rows, fakeGatewayEnv());

		const sent = userMessage(gateway.calls[0]);
		expect(sent).toContain("r1 the company is a seed stage fintech");
		expect(sent).toContain("r2 the company posted a founding engineer role");
		expect(sent).toContain("give no status for these");
	});

	it("says nothing about preferences when the profile asks for none", async () => {
		const gateway = fakeGateway([
			chatCompletionResponse(objectReply(verdictsFor(rows))),
		]);
		globalThis.fetch = gateway.fetch;

		const hardOnly = requirements.filter((req) => req.kind === "hard");
		await judge(hardOnly, rows, fakeGatewayEnv());

		expect(userMessage(gateway.calls[0])).not.toContain("Preferences.");
	});
});

describe("the kind of page a row came from is a label, not something the judge weighs", () => {
	it("sends only the fields a verdict can rest on, and bounds the description length", async () => {
		const long = "x".repeat(config.companies.descriptionChars + 200);
		const labelled: CompanyRow[] = [
			{
				...row("Acme", "acme.com"),
				description: long,
				evidenceKind: "vendor-case-study",
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
		expect(sent).not.toContain("vendor-case-study");
		expect(sent).not.toContain("linkedinUrl");
	});
});

function rowCountIn(call: { body: unknown } | undefined): number {
	const sent = bodyOf(call)
		.messages.map((message) => message.content)
		.join("\n");
	return (sent.match(/^\d+: /gm) ?? []).length;
}

describe("judge: slicing a large batch into concurrent, ordered calls", () => {
	it("sends 40 rows as five concurrent calls of 8, and returns every index in row order however the calls resolve", async () => {
		const bigRows: CompanyRow[] = Array.from({ length: 40 }, (_, i) =>
			row(`Company ${i}`, `co${i}.com`),
		);
		const gateway = deferredGateway();
		globalThis.fetch = gateway.fetch;

		const pending = judge(requirements, bigRows, fakeGatewayEnv());

		for (let i = 0; i < 200; i++) await Promise.resolve();
		expect(gateway.calls).toHaveLength(5);
		const sizes = gateway.calls.map((call) => rowCountIn(call));
		expect(sizes).toEqual([8, 8, 8, 8, 8]);

		for (const callIndex of [4, 2, 0, 3, 1]) {
			const size = sizes[callIndex] ?? 0;
			const verdicts = Array.from({ length: size }, (_, i) => ({
				index: i,
				statuses: [{ id: "r1", status: "proven" }],
				soft: [],
				reason: "fits the profile",
				sameOrganizationAs: null,
			}));
			gateway.resolvers[callIndex]?.(
				chatCompletionResponse(objectReply({ verdicts })),
			);
		}

		const result = await pending;

		expect(result.verdicts).toHaveLength(40);
		result.verdicts.forEach((verdict, index) => {
			expect(verdict.index).toBe(index);
			expect(kept(verdict)).toBe(true);
		});
	});
});
