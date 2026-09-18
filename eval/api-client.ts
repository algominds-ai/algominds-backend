import { z } from "zod";

const POLL_MS = 5_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const TERMINAL_STATUSES = new Set([
	"complete",
	"errored",
	"terminated",
	"unknown",
]);

export type ApiClient = { baseUrl: string; apiKey: string };

export async function request(
	client: ApiClient,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const response = await fetch(`${client.baseUrl}${path}`, {
		signal: AbortSignal.timeout(30_000),
		method,
		headers: {
			"x-api-key": client.apiKey,
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const json: unknown = await response.json();
	if (!response.ok) {
		throw new Error(
			`eval: ${method} ${path} failed ${response.status}: ${JSON.stringify(json)}`,
		);
	}
	return json;
}

const StartedRunSchema = z.object({ runId: z.string() });

export async function startCompaniesRun(
	client: ApiClient,
	icpId: string,
	count: number,
): Promise<string> {
	const started = await request(client, "POST", "/companies/find", {
		icpId,
		count,
	});
	return StartedRunSchema.parse(started).runId;
}

export async function startPeopleRun(
	client: ApiClient,
	icpId: string,
	domains: readonly string[],
): Promise<string> {
	const started = await request(client, "POST", "/people/find", {
		icpId,
		domains,
	});
	return StartedRunSchema.parse(started).runId;
}

const RunStatusSchema = z.object({ status: z.string() });

const OPENING_GRACE_MS = 60_000;

/** The run's status, or null while a 404 during the opening grace means the run row is not written yet. */
async function readStatus(
	client: ApiClient,
	runId: string,
	opening: boolean,
	signal: AbortSignal,
): Promise<string | null> {
	const response = await fetch(`${client.baseUrl}/runs/${runId}`, {
		signal,
		headers: { "x-api-key": client.apiKey },
	});
	if (response.status === 404 && opening) return null;
	const json: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`eval: GET /runs/${runId} failed ${response.status}`);
	}
	return RunStatusSchema.parse(json).status;
}

/** Polls `/runs/:runId` until its status is terminal, or throws once `ceilingSeconds` (default `RUN_TIMEOUT_MS`) has passed. */
export async function waitForRunTerminal(
	client: ApiClient,
	runId: string,
	ceilingSeconds: number = RUN_TIMEOUT_MS / 1000,
): Promise<void> {
	const deadline = Date.now() + ceilingSeconds * 1000;
	const openingUntil = Date.now() + OPENING_GRACE_MS;
	const signal = AbortSignal.timeout(ceilingSeconds * 1000);
	while (Date.now() < deadline) {
		const status = await readStatus(
			client,
			runId,
			Date.now() < openingUntil,
			signal,
		);
		if (status !== null && TERMINAL_STATUSES.has(status)) return;
		await new Promise((resolve) =>
			setTimeout(
				resolve,
				Math.min(POLL_MS, Math.max(0, deadline - Date.now())),
			),
		);
	}
	throw new Error(
		`eval: harness ceiling ${ceilingSeconds}s exceeded for run ${runId}`,
	);
}
