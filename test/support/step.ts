import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";

export type SleepCall = { name: string; duration: string };

export type FakeWorkflowStep = {
	step: WorkflowStep;
	calls: string[];
	sleeps: string[];
	sleepCalls: SleepCall[];
};

/**
 * A `WorkflowStep` that runs each step's callback inline, recording every
 * step name called and every sleep duration requested. `overrides` maps a
 * step name to a canned result, or an `Error` to throw instead of running
 * that step's callback.
 */
export function fakeWorkflowStep(
	overrides: Map<string, unknown> = new Map(),
): FakeWorkflowStep {
	const calls: string[] = [];
	const sleeps: string[] = [];
	const sleepCalls: SleepCall[] = [];
	async function runNamed(
		name: string,
		second: unknown,
		third?: unknown,
	): Promise<unknown> {
		calls.push(name);
		if (overrides.has(name)) {
			const value = overrides.get(name);
			if (value instanceof Error) throw value;
			return value;
		}
		const callback = typeof second === "function" ? second : third;
		if (typeof callback !== "function") {
			throw new Error(`fake step: no callback for ${name}`);
		}
		const ctx: WorkflowStepContext = {
			step: { name, count: 0 },
			attempt: 1,
			config: {},
		};
		return callback(ctx);
	}
	const step: WorkflowStep = {
		do: runNamed,
		sleep: async (name: string, duration: string | number) => {
			sleeps.push(String(duration));
			sleepCalls.push({ name, duration: String(duration) });
		},
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("fake step: waitForEvent not implemented");
		},
	};
	return { step, calls, sleeps, sleepCalls };
}

export type RunLookup = {
	get: (id: string) => Promise<{ status: () => Promise<{ status: string }> }>;
};

/** A Workflow control-plane binding whose one instance answers `status()` however `status` says, or throws when `status` throws. */
export function fakeRunLookup(
	status: () => Promise<{ status: string }>,
): RunLookup {
	return { get: async () => ({ status }) };
}
