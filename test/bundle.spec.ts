import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type HealthBody = {
	ok: boolean;
	bundled: { generateText: string; createMCPClient: string };
};

async function health(): Promise<Response> {
	return exports.default.fetch(new Request("https://algo.test/health"));
}

describe("worker entrypoint", () => {
	it("answers health on the Workers runtime", async () => {
		expect((await health()).status).toBe(200);
	});

	it("resolves the model SDK and the MCP client at module scope", async () => {
		const body: HealthBody = await (await health()).json();
		expect(body.bundled.generateText).toBe("function");
		expect(body.bundled.createMCPClient).toBe("function");
	});
});

describe("aliased Node-only packages", () => {
	it("throws naming undici on any property access", async () => {
		const stub = (await import("../build/stub-undici")).default;
		expect(() => stub.fetch).toThrow(/undici/);
	});

	it("throws naming cross-spawn on any property access", async () => {
		const stub = (await import("../build/stub-cross-spawn")).default;
		expect(() => stub.spawn).toThrow(/cross-spawn/);
	});
});
