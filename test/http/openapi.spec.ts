import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { instanceExists } from "@/http/jobs";
import { fakeRunLookup } from "../support/step";

const BASE = "https://algo.test";

async function publicCall(path: string): Promise<Response> {
	return exports.default.fetch(new Request(`${BASE}${path}`));
}

describe("OpenAPI document and Swagger UI", () => {
	it("answers both with no API key, the document naming all eight paths", async () => {
		const doc = await publicCall("/openapi.json");
		const docBody: { paths?: { [path: string]: unknown } } = await doc.json();
		const docs = await publicCall("/docs");

		expect(doc.status).toBe(200);
		expect(Object.keys(docBody.paths ?? {}).sort()).toEqual(
			[
				"/companies/find",
				"/enrich",
				"/icp/onboard",
				"/people/find",
				"/runs/{runId}",
				"/runs/{runId}/companies",
				"/runs/{runId}/people",
				"/runs/{runId}/rounds",
			].sort(),
		);
		expect(docs.status).toBe(200);
	});
});

describe("a run whose state cannot be read is treated as still going", () => {
	it("blocks a second start when the status cannot be read, but frees a terminated or errored one so a caller can retry the same day", async () => {
		const unreadable = fakeRunLookup(async () => {
			throw new Error("the control plane is unreachable");
		});
		const terminated = fakeRunLookup(async () => ({ status: "terminated" }));
		const errored = fakeRunLookup(async () => ({ status: "errored" }));
		const running = fakeRunLookup(async () => ({ status: "running" }));

		expect(await instanceExists(unreadable, "run-1")).toBe(true);
		expect(await instanceExists(terminated, "run-1")).toBe(false);
		expect(await instanceExists(errored, "run-1")).toBe(false);
		expect(await instanceExists(running, "run-1")).toBe(true);
	});
});
