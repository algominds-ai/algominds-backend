import type {
	WorkflowStep,
	WorkflowStepConfig,
	WorkflowStepContext,
} from "cloudflare:workers";

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

export type FakeRetryingWorkflowStep = { step: WorkflowStep; calls: string[] };

/** Runs `attempt` up to `attempts` times, recording one `name` push per try, and rethrows the last failure once every attempt is spent. */
async function retrying(
	name: string,
	attempts: number,
	calls: string[],
	attempt: (count: number) => Promise<unknown>,
): Promise<unknown> {
	let failure: unknown;
	for (let count = 0; count < attempts; count++) {
		calls.push(name);
		try {
			return await attempt(count);
		} catch (error) {
			failure = error;
		}
	}
	throw failure;
}

/**
 * A `WorkflowStep` that retries a step's own callback up to its `retries.limit`
 * before rethrowing, the way Cloudflare's real `step.do` does, so a test can
 * prove what a step's own retry budget does without the real Workflows runtime.
 */
export function fakeRetryingWorkflowStep(): FakeRetryingWorkflowStep {
	const calls: string[] = [];
	async function runNamed(
		name: string,
		second: unknown,
		third?: unknown,
	): Promise<unknown> {
		const config: WorkflowStepConfig =
			typeof second === "function" ? {} : (second ?? {});
		const callback = typeof second === "function" ? second : third;
		if (typeof callback !== "function") {
			throw new Error(`fake step: no callback for ${name}`);
		}
		const attempts = 1 + (config.retries?.limit ?? 0);
		return retrying(name, attempts, calls, (count) =>
			callback({ step: { name, count }, attempt: count + 1, config: {} }),
		);
	}
	const step: WorkflowStep = {
		do: runNamed,
		sleep: async () => undefined,
		sleepUntil: async () => undefined,
		waitForEvent: async () => {
			throw new Error("fake step: waitForEvent not implemented");
		},
	};
	return { step, calls };
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
