import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";
import { env as testEnv } from "cloudflare:workers";
import { resolveBuyer } from "@/core/people/buyer";
import type { CompanyLoopContext } from "@/workflows/find-people-company";

export function orderedStep(
	overrides: Map<string, unknown>,
	events: string[],
): WorkflowStep {
	async function runNamed(
		name: string,
		second: unknown,
		third: unknown,
	): Promise<unknown> {
		events.push(`start:${name}`);
		await Promise.resolve();
		try {
			if (overrides.has(name)) {
				const value = overrides.get(name);
				if (value instanceof Error) throw value;
				return value;
			}
			const callback = typeof second === "function" ? second : third;
			if (typeof callback !== "function")
				throw new Error(`no callback for ${name}`);
			const ctx: WorkflowStepContext = {
				step: { name, count: 0 },
				attempt: 1,
				config: {},
			};
			return await callback(ctx);
		} finally {
			events.push(`end:${name}`);
		}
	}
	return {
		do: runNamed,
		sleep: async () => undefined,
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("ordered step: waitForEvent not implemented");
		},
	};
}

export function eventIndex(events: string[], label: string): number {
	const index = events.indexOf(label);
	if (index === -1) throw new Error(`event never recorded: ${label}`);
	return index;
}

export function orderedContext(
	runId: string,
	organizationId: string,
	overrides: Map<string, unknown>,
	events: string[],
): CompanyLoopContext {
	return {
		env: testEnv,
		step: orderedStep(overrides, events),
		runId,
		organizationId,
		buyer: resolveBuyer({ target: null, profile: null }),
		profile: null,
	};
}

export function rosterModeOverrides(
	domain: string,
	index: number,
): [string, unknown][] {
	return [
		[`people-${domain}-open`, `rc-${index}`],
		[
			`people-${domain}-identity`,
			{
				how: "domain",
				identifier: domain,
				name: `Company ${index}`,
				clayRecords: 0,
				costEntries: [],
			},
		],
		[`people-${domain}-create-company`, `company-${index}`],
		[
			`people-${domain}-roster`,
			{ candidates: [], clayRecords: 0, costEntries: [] },
		],
		[`people-${domain}-save`, { count: 0 }],
	];
}

export function unresolvedModeOverrides(
	domain: string,
	index: number,
): [string, unknown][] {
	return [
		[`people-${domain}-open`, `rc-${index}`],
		[
			`people-${domain}-identity`,
			{ how: "unresolved", clayRecords: 0, costEntries: [] },
		],
		[`people-${domain}-unresolved`, {}],
	];
}
