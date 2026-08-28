import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
	EnrichOutcome,
	EnrichResult,
	EnrichSubject,
} from "../src/core/enrich";

type StepMocker = {
	mockStepResult: (s: { name: string }, v: unknown) => Promise<void>;
};

async function mockRunBookkeeping(m: StepMocker): Promise<void> {
	await m.mockStepResult(
		{ name: "load-source-run" },
		{ organizationId: "org-1", icpId: "icp-1" },
	);
	await m.mockStepResult({ name: "daily-ceiling" }, { spent: 0 });
	await m.mockStepResult({ name: "open-run" }, { id: "x" });
	await m.mockStepResult({ name: "close-run" }, { id: "x" });
}

function foundLinkedinOutcome(subjectId: string, i: number): EnrichOutcome {
	return {
		subjectId,
		linkedin: {
			status: "found",
			value: `https://linkedin.com/in/${i}`,
			source: "subject",
		},
	};
}

describe("EnrichWorkflow: resolving a run", () => {
	it("resolves a run into subjects and runs one step per batch", async () => {
		const instanceId = "enrich_workflow_batches_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = Array.from({ length: 6 }, (_, i) => ({
				id: `subject-${i}`,
			}));
			const batchZero: EnrichResult = {
				outcomes: Array.from({ length: 5 }, (_, i) =>
					foundLinkedinOutcome(`subject-${i}`, i),
				),
				costDollars: 0,
			};
			const batchOne: EnrichResult = {
				outcomes: [foundLinkedinOutcome("subject-5", 5)],
				costDollars: 0,
			};
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, batchZero);
				await m.mockStepResult({ name: "enrich-batch-1" }, batchOne);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_batches", channels: ["linkedin"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({
				outcomes: [...batchZero.outcomes, ...batchOne.outcomes],
				costDollars: 0,
			});
		} finally {
			await instance.dispose();
		}
	});

	it("a run resolving to three people enriches three", async () => {
		const instanceId = "enrich_workflow_three_people_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = [
				{ id: "person-a" },
				{ id: "person-b" },
				{ id: "person-c" },
			];
			const outcomes: EnrichOutcome[] = subjects.map((subject) => ({
				subjectId: subject.id,
				linkedin: { status: "unknown", value: null, source: null },
			}));
			const batchResult: EnrichResult = { outcomes, costDollars: 0 };
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, batchResult);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_three", channels: ["linkedin"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual(batchResult);
		} finally {
			await instance.dispose();
		}
	});

	it("a run resolving to no people returns an empty list without throwing", async () => {
		const instanceId = "enrich_workflow_no_people_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, []);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_empty", channels: ["email"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual({ outcomes: [], costDollars: 0 });
		} finally {
			await instance.dispose();
		}
	});
});

describe("EnrichWorkflow: closes the run with the real spend", () => {
	it("reports a positive figure, not the placeholder zero, for a run that spent", async () => {
		const instanceId = "enrich_workflow_real_cost_test";
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = [{ id: "subject-1" }];
			const outcome: EnrichOutcome = {
				subjectId: "subject-1",
				email: {
					status: "verified",
					value: "max@tryramp.com",
					source: "linkedin",
				},
			};
			const batchResult: EnrichResult = {
				outcomes: [outcome],
				costDollars: 0.02,
			};
			await instance.modify(async (m) => {
				await mockRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, batchResult);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_real_cost", channels: ["email"] },
			});
			await instance.waitForStatus("complete");

			const output = await instance.getOutput();
			expect(output).toEqual(batchResult);
		} finally {
			await instance.dispose();
		}
	});
});
