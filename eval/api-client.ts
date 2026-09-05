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

async function request(
	client: ApiClient,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const response = await fetch(`${client.baseUrl}${path}`, {
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
): Promise<string | null> {
	const response = await fetch(`${client.baseUrl}/runs/${runId}`, {
		headers: { "x-api-key": client.apiKey },
	});
	if (response.status === 404 && opening) return null;
	const json: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`eval: GET /runs/${runId} failed ${response.status}`);
	}
	return RunStatusSchema.parse(json).status;
}

/** Polls `/runs/:runId` until its status is terminal, or throws past `RUN_TIMEOUT_MS`. */
export async function waitForRunTerminal(
	client: ApiClient,
	runId: string,
): Promise<void> {
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	const openingUntil = Date.now() + OPENING_GRACE_MS;
	while (Date.now() < deadline) {
		const status = await readStatus(client, runId, Date.now() < openingUntil);
		if (status !== null && TERMINAL_STATUSES.has(status)) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(
		`eval: run ${runId} did not finish within ${RUN_TIMEOUT_MS}ms`,
	);
}
