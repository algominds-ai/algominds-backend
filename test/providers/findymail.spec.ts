import { afterEach, describe, expect, it, vi } from "vitest";
import { CostLedger } from "../../src/core/cost";
import {
	findymailCredits,
	findymailLinkedinProvider,
	findymailNameProvider,
	findymailSearchLinkedin,
	findymailStatus,
	findymailVerify,
} from "../../src/core/providers/findymail/index";
import { RetryableProviderError } from "../../src/core/providers/waterfall";
import { fakeSecretEnv } from "../support/env";
import { fakeFindymail, jsonResponse, requestedEmail } from "../support/fetch";

function findymailEnv(): Env {
	return fakeSecretEnv({ FINDYMAIL_API_KEY: "test-findymail-key" });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("the outgoing request", () => {
	it("sends the resolved secret as a bearer token, not the binding object", async () => {
		const seenHeaders: Headers[] = [];
		globalThis.fetch = async (input, init) => {
			seenHeaders.push(new Headers(init?.headers));
			return fakeFindymail({
				"/api/search/linkedin": () =>
					jsonResponse({ contact: { email: "max@tryramp.com" } }),
			})(input, init);
		};

		await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			findymailEnv(),
		);

		expect(seenHeaders[0]?.get("authorization")).toBe(
			"Bearer test-findymail-key",
		);
	});
});

describe("the three-state verdict", () => {
	it("is verified when the finder returns an address, the verifier agrees, and it is not a role address", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				jsonResponse({
					contact: { email: "max@tryramp.com", name: "Max Freeman" },
				}),
			"/api/verify": (init) =>
				jsonResponse({
					email: requestedEmail(init),
					verified: true,
					provider: "findymail",
				}),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			findymailEnv(),
		);

		expect(result?.status).toBe("verified");
		expect(result?.email).toBe("max@tryramp.com");
	});

	it("is invalid when the verifier rejects a found address", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				jsonResponse({ contact: { email: "ghost@acme.com" } }),
			"/api/verify": (init) =>
				jsonResponse({ email: requestedEmail(init), verified: false }),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/ghost" },
			findymailEnv(),
		);

		expect(result?.status).toBe("invalid");
	});

	it("is unknown, never verified, when a found address gets no verifier answer", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				jsonResponse({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": () => new Response(null, { status: 500 }),
		});

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			findymailEnv(),
		);

		expect(result?.status).toBe("unknown");
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
	it("keeps both finders' results independent when they disagree on a person's address", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				jsonResponse({
					contact: {
						email: "patrick.collison@arcinstitute.org",
						name: "Patrick Collison",
					},
				}),
			"/api/search/name": () =>
				jsonResponse({
					contact: { email: "patrick@stri.pe", name: "Patrick Collison" },
				}),
			"/api/verify": (init) =>
				jsonResponse({ email: requestedEmail(init), verified: true }),
		});
		const input = {
			linkedinUrl: "linkedin.com/in/patrickcollison",
			name: "Patrick Collison",
			domain: "stripe.com",
		};

		const byLinkedin = await findymailLinkedinProvider.run(
			input,
			findymailEnv(),
		);
		const byName = await findymailNameProvider.run(input, findymailEnv());

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
			findymailEnv(),
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
				findymailEnv(),
			),
		).rejects.toThrow(RetryableProviderError);
	});

	it("misses without a network call when the name finder lacks a domain", async () => {
		globalThis.fetch = fakeFindymail({});

		const result = await findymailNameProvider.run(
			{ name: "Max Freeman" },
			findymailEnv(),
		);

		expect(result).toBeNull();
	});
});

describe("findymail cost metering", () => {
	it("meters one credits unit for a search and one verifier_credits unit for a verify, whether or not it verifies", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				jsonResponse({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": (init) =>
				jsonResponse({ email: requestedEmail(init), verified: true }),
		});
		const ledger = new CostLedger();
		const meterSpy = vi.spyOn(ledger, "metered");

		await findymailSearchLinkedin(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			findymailEnv(),
			ledger,
		);
		await findymailVerify("max@tryramp.com", findymailEnv(), ledger);

		expect(meterSpy).toHaveBeenCalledWith(
			"findymail",
			expect.any(String),
			1,
			"credits",
		);
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
				jsonResponse({ contact: { email: "max@tryramp.com" } }),
			"/api/verify": (init) =>
				jsonResponse({ email: requestedEmail(init), verified: true }),
		});
		const ledger = new CostLedger();

		await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/maxwellfreeman" },
			findymailEnv(),
			ledger,
		);

		expect(ledger.total()).toBeCloseTo(0.02, 10);
	});

	it("still meters what it spent on a miss, into the caller's ledger", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/search/linkedin": () =>
				jsonResponse({ contact: { email: "ghost@acme.com" } }),
			"/api/verify": (init) =>
				jsonResponse({ email: requestedEmail(init), verified: false }),
		});
		const ledger = new CostLedger();

		const result = await findymailLinkedinProvider.run(
			{ linkedinUrl: "linkedin.com/in/ghost" },
			findymailEnv(),
			ledger,
		);

		expect(result?.status).toBe("invalid");
		expect(ledger.total()).toBeGreaterThan(0);
	});
});

describe("findymailCredits", () => {
	it("reads the two separate balances", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/credits": () =>
				jsonResponse({
					credits: 327654,
					verifier_credits: 374780,
					pricing: {},
					email: "user@example.com",
					id: 1,
				}),
		});

		const balance = await findymailCredits(findymailEnv());

		expect(balance).toEqual({ credits: 327654, verifierCredits: 374780 });
	});

	it("raises a retryable error on a 429", async () => {
		globalThis.fetch = fakeFindymail({
			"/api/credits": () => new Response(null, { status: 429 }),
		});

		await expect(findymailCredits(findymailEnv())).rejects.toThrow(
			RetryableProviderError,
		);
	});
});
