import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "../src/core/cost";
import {
	findymailCredits,
	findymailLinkedinProvider,
	findymailNameProvider,
	findymailSearchLinkedin,
	findymailStatus,
	findymailVerify,
} from "../src/core/providers/findymail";
import { RetryableProviderError } from "../src/core/providers/waterfall";

type Handler = (init: RequestInit | undefined) => Response;

function fakeFindymail(handlers: Record<string, Handler>): typeof fetch {
	return async (input, init) => {
		const pathname = new URL(String(input)).pathname;
		const handler = handlers[pathname];
		if (!handler) return new Response(null, { status: 404 });
		return handler(init);
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function requestedEmail(init: RequestInit | undefined): string {
	const body: { email?: string } = JSON.parse(String(init?.body ?? "{}"));
	return body.email ?? "";
}

describe("the three-state verdict", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("is verified when the finder returns an address, the verifier agrees, and it is not a role address", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "max@tryramp.com", name: "Max Freeman" } }),
			"/api/verify": (init) =>
				json({
					email: requestedEmail(init),
					verified: true,
					provider: "findymail",
				}),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			testEnv,
		);

		expect(result?.status).toBe("verified");
		expect(result?.email).toBe("max@tryramp.com");
	});

	it("is invalid when the verifier rejects a found address", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "ghost@acme.com" } }),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: false }),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/ghost" },
			testEnv,
		);

		expect(result?.status).toBe("invalid");
	});

	it("is unknown, never verified, when a found address gets no verifier answer", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": () => new Response(null, { status: 500 }),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			testEnv,
		);

		expect(result?.status).toBe("unknown");
		expect(result?.status).not.toBe("verified");
	});

	it.each([
		"info@acme.com",
		"sales@acme.com",
		"hello@acme.com",
		"contact@acme.com",
		"support@acme.com",
		"admin@acme.com",
		"team@acme.com",
		"hi@acme.com",
	])("rejects the role address %s even when the verifier says true", (email) => {
		expect(findymailStatus(email, true)).not.toBe("verified");
	});
});

describe("the two finders", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps both finders' results independent when they disagree on a person's address", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({
					contact: {
						email: "patrick.collison@arcinstitute.org",
						name: "Patrick Collison",
					},
				}),
			"/api/search/name": () =>
				json({
					contact: { email: "patrick@stri.pe", name: "Patrick Collison" },
				}),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: true }),
		});
		const input = {
			linkedinUrl: "linkedin.com/in/patrickcollison",
			name: "Patrick Collison",
			domain: "stripe.com",
		};

		const byLinkedin = await findymailLinkedinProvider.run(input, testEnv);
		const byName = await findymailNameProvider.run(input, testEnv);

		expect(byLinkedin?.email).toBe("patrick.collison@arcinstitute.org");
		expect(byLinkedin?.finder).toBe("linkedin");
		expect(byName?.email).toBe("patrick@stri.pe");
		expect(byName?.finder).toBe("name");
	});

	it("returns null on a non-200 search response so the waterfall continues", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () => new Response(null, { status: 404 }),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/nobody" },
			testEnv,
		);

		expect(result).toBeNull();
	});

	it("raises a retryable error on a 429 from the search endpoint", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () => new Response(null, { status: 429 }),
		});

		await expect(
			findymailLinkedinProvider.run(
				{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
				testEnv,
			),
		).rejects.toThrow(RetryableProviderError);
	});

	it("misses without a network call when the name finder lacks a domain", async () => {
		globalThis.fetch = fakeFindymail({});

		const result = await findymailNameProvider.run(
			{ name: "Max Freeman" },
			testEnv,
		);

		expect(result).toBeNull();
	});
});

describe("findymail cost metering", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("meters one credits unit and zero verifier_credits units for a search", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "max@tryramp.com" } }),
		});
		const ledger = new CostLedger();
		const meterSpy = vi.spyOn(ledger, "metered");

		await findymailSearchLinkedin(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			testEnv,
			ledger,
		);

		expect(meterSpy).toHaveBeenCalledTimes(1);
		expect(meterSpy).toHaveBeenCalledWith(
			"findymail",
			expect.any(String),
			1,
			"credits",
		);
	});

	it("meters verifier_credits, not credits, for a verify call", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: true }),
		});
		const ledger = new CostLedger();
		const meterSpy = vi.spyOn(ledger, "metered");

		await findymailVerify("max@tryramp.com", testEnv, ledger);

		expect(meterSpy).toHaveBeenCalledTimes(1);
		expect(meterSpy).toHaveBeenCalledWith(
			"findymail",
			expect.any(String),
			1,
			"verifier_credits",
		);
	});

	it("finding and then verifying one address totals two priced credits", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				json({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": (init) =>
				json({ email: requestedEmail(init), verified: true }),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			testEnv,
		);

		expect(result?.ledger.total()).toBeCloseTo(0.02, 10);
	});
});

describe("findymailCredits", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("reads the two separate balances", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/credits": () =>
				json({
					credits: 327654,
					verifier_credits: 374780,
					pricing: {},
					email: "user@example.com",
					id: 1,
				}),
		});

		const balance = await findymailCredits(testEnv);

		expect(balance).toEqual({ credits: 327654, verifierCredits: 374780 });
	});

	it("raises a retryable error on a 429", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/credits": () => new Response(null, { status: 429 }),
		});

		await expect(findymailCredits(testEnv)).rejects.toThrow(
			RetryableProviderError,
		);
	});
});
