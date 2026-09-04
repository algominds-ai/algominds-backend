import { describe, expect, it } from "vitest";
import { db } from "@/core/db/client";
import { cutoffDate } from "@/core/db/queries";
import { normalizeDomain } from "@/core/db/schema";
import { fakeDbEnv } from "../support/env";

describe("normalizeDomain", () => {
	const cases: Array<[string, string]> = [
		["https://WWW.Acme.com/careers", "acme.com"],
		["https://acme.com:8443/path?query=1", "acme.com"],
		["shop.acme.co.uk", "acme.co.uk"],
		["jobs.barclays", "jobs.barclays"],
		["localhost", "localhost"],
		["127.0.0.1", "127.0.0.1"],
	];

	for (const [input, expected] of cases) {
		it(`collapses ${input} to the registrable domain ${expected}`, () => {
			expect(normalizeDomain(input)).toBe(expected);
		});
	}
});

describe("cutoffDate", () => {
	it("splits a window so a day just outside it falls before a day just inside it", () => {
		const now = new Date("2026-08-27T00:00:00.000Z");
		const cutoff = cutoffDate(90, now);
		const dayMs = 24 * 60 * 60 * 1000;
		const outside = new Date(now.getTime() - 91 * dayMs);
		const inside = new Date(now.getTime() - 89 * dayMs);

		expect(outside.getTime() < cutoff.getTime()).toBe(true);
		expect(inside.getTime() >= cutoff.getTime()).toBe(true);
	});
});

describe("db", () => {
	it("wires cached and direct modes to their own declared Hyperdrive binding", () => {
		const env = fakeDbEnv(
			"postgres://user:pass@cached-host:5432/algo_cached",
			"postgres://user:pass@direct-host:5432/algo_direct",
		);

		expect(db(env, "cached").$client.options.host).toEqual(["cached-host"]);
		expect(db(env, "direct").$client.options.host).toEqual(["direct-host"]);
	});
});
