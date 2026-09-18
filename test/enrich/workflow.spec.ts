import { introspectWorkflowInstance } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import { toBatches } from "@/core/batches";
import { findRun } from "@/core/db/queries";
import type { EnrichOutcome, EnrichResult, EnrichSubject } from "@/core/enrich";
import { seedOrganization, wipeOrganizations } from "../support/db";

type StepMocker = {
	mockStepResult: (s: { name: string }, v: unknown) => Promise<void>;
};

async function primeRunBookkeeping(m: StepMocker): Promise<void> {
	await m.mockStepResult(
		{ name: "load-source-run" },
		{ organizationId: "org-1", icpId: "icp-1" },
	);
	await m.mockStepResult({ name: "open-run" }, { alreadySpent: 0 });
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

describe("toBatches", () => {
	it("splits items into ordered groups of the given size", () => {
		const subjects: EnrichSubject[] = Array.from({ length: 12 }, (_, i) => ({
			id: `subject-${i}`,
		}));

		const batches = toBatches(subjects, 5);

		expect(batches.map((batch) => batch.length)).toEqual([5, 5, 2]);
		expect(batches[0]?.[0]?.id).toBe("subject-0");
		expect(batches[2]?.[1]?.id).toBe("subject-11");
	});
});

describe("EnrichWorkflow: resolving a run into batches", () => {
	it("runs one step per batch and concatenates their outcomes in order", async () => {
		const instanceId = `enrich_workflow_batches_${crypto.randomUUID()}`;
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
				await primeRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, batchZero);
				await m.mockStepResult({ name: "enrich-batch-1" }, batchOne);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_batches", channels: ["linkedin"] },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual({
				outcomes: [...batchZero.outcomes, ...batchOne.outcomes],
				costDollars: 0,
			});
		} finally {
			await instance.dispose();
		}
	});

	it("returns an empty list without throwing when the run resolves to no people", async () => {
		const instanceId = `enrich_workflow_no_people_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			await instance.modify(async (m) => {
				await primeRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, []);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_empty", channels: ["email"] },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual({
				outcomes: [],
				costDollars: 0,
			});
		} finally {
			await instance.dispose();
		}
	});
});

describe("EnrichWorkflow: closes the run with the real spend", () => {
	it("reports a positive figure, not the placeholder zero, for a run that spent", async () => {
		const instanceId = `enrich_workflow_real_cost_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = [{ id: "subject-1" }];
			const batchResult: EnrichResult = {
				outcomes: [
					{
						subjectId: "subject-1",
						email: {
							status: "verified",
							value: "max@tryramp.com",
							source: "linkedin",
						},
					},
				],
				costDollars: 0.02,
			};
			await instance.modify(async (m) => {
				await primeRunBookkeeping(m);
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult({ name: "enrich-batch-0" }, batchResult);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_real_cost", channels: ["email"] },
			});
			await instance.waitForStatus("complete");

			expect(await instance.getOutput()).toEqual(batchResult);
		} finally {
			await instance.dispose();
		}
	});
});

describe("EnrichWorkflow: a step failure after the run opens", () => {
	it("closes the run row as errored instead of leaving it running", async () => {
		const org = await seedOrganization("enrich-close-errored");
		const instanceId = `enrich_workflow_errored_${crypto.randomUUID()}`;
		const instance = await introspectWorkflowInstance(
			testEnv.ENRICH,
			instanceId,
		);
		try {
			const subjects: EnrichSubject[] = [{ id: "subject-1" }];
			await instance.modify(async (m) => {
				await m.mockStepResult({ name: "resolve-subjects" }, subjects);
				await m.mockStepResult(
					{ name: "load-source-run" },
					{ organizationId: org.id, icpId: null },
				);
				await m.mockStepError(
					{ name: "enrich-batch-0" },
					new NonRetryableError("enrichment provider down"),
				);
			});

			await testEnv.ENRICH.create({
				id: instanceId,
				params: { runId: "people_run_x", channels: ["email"] },
			});
			await instance.waitForStatus("errored");

			const row = await findRun(testEnv, instanceId);
			expect(row?.status).toBe("errored");
			expect(row?.finishedAt).toBeInstanceOf(Date);
		} finally {
			await instance.dispose();
			await wipeOrganizations([org.id]);
		}
	});
});
