import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("U1 bundle spike", () => {
	it("serves /health on the Workers runtime", async () => {
		const res = await exports.default.fetch(new Request("https://x/health"));
		expect(res.status).toBe(200);
	});

	it("resolves ai and @ai-sdk/mcp at module scope", async () => {
		const res = await exports.default.fetch(new Request("https://x/health"));
		const body = (await res.json()) as {
			bundled: { generateText: string; createMCPClient: string };
		};
		expect(body.bundled.generateText).toBe("function");
		expect(body.bundled.createMCPClient).toBe("function");
	});

	it("undici stub throws by name on any access", async () => {
		const stub = (await import("../build/stub-undici")).default as Record<
			string,
			unknown
		>;
		expect(() => stub.fetch).toThrow(/undici/);
	});

	it("cross-spawn stub throws by name on any access", async () => {
		const stub = (await import("../build/stub-cross-spawn")).default as Record<
			string,
			unknown
		>;
		expect(() => stub.spawn).toThrow(/cross-spawn/);
	});
});
