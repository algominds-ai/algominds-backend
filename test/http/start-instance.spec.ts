import { describe, expect, it } from "vitest";
import { startInstance } from "@/http/jobs";

function workflowWith(
	status: () => string,
	createBatch: (batch: { id?: string; params?: unknown }[]) => Promise<unknown>,
) {
	return {
		async get() {
			return { status: async () => ({ status: status() }) };
		},
		createBatch,
	};
}

describe("startInstance never reports a start without an instance behind it", () => {
	it("reports a retained failed id as not started when the batch call skips it", async () => {
		let batches = 0;
		const workflow = workflowWith(
			() => "errored",
			async () => {
				batches += 1;
				return [];
			},
		);
		expect(await startInstance(workflow, "run-1", {})).toBe(false);
		expect(batches).toBe(1);
	});

	it("reports started once the batch call leaves a live instance", async () => {
		let live = false;
		const workflow = workflowWith(
			() => (live ? "running" : "errored"),
			async () => {
				live = true;
				return [];
			},
		);
		expect(await startInstance(workflow, "run-1", {})).toBe(true);
	});

	it("submits nothing when a live instance already holds the id", async () => {
		let batches = 0;
		const workflow = workflowWith(
			() => "running",
			async () => {
				batches += 1;
				return [];
			},
		);
		expect(await startInstance(workflow, "run-1", {})).toBe(false);
		expect(batches).toBe(0);
	});
});
