import { z } from "zod";

export type Handler = (init: RequestInit | undefined) => Response;

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A `fetch` routed by request pathname alone, for a single vendor host. Unhandled paths 404. */
export function fakeFindymail(handlers: Record<string, Handler>): typeof fetch {
	return async (input, init) => {
		const pathname = new URL(String(input)).pathname;
		const handler = handlers[pathname];
		return handler ? handler(init) : new Response(null, { status: 404 });
	};
}

/** A `fetch` routed to the Exa table for `api.exa.ai`, and the other table for every other host. */
export function fakeVendors(
	findymail: Record<string, Handler>,
	exa: Record<string, Handler>,
): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		const table = url.hostname === "api.exa.ai" ? exa : findymail;
		const handler = table[url.pathname];
		return handler ? handler(init) : new Response(null, { status: 404 });
	};
}

export function requestedEmail(init: RequestInit | undefined): string {
	const body: { email?: string } = JSON.parse(String(init?.body ?? "{}"));
	return body.email ?? "";
}

const ContentsRequestSchema = z.object({ urls: z.array(z.string()) });

type ContentsOutcome =
	| { text: string }
	| { errorTag: string }
	| { absent: true };

type ContentsStatus =
	| { id: string; status: "success" }
	| { id: string; status: "error"; error: { tag: string } };

type ContentsEntry = {
	status: ContentsStatus | null;
	result: { url: string; text: string } | null;
};

/** One url's contribution to the `/contents` reply: null status and result when it is `absent`, an error status when the crawl failed, else a success status and its text. */
function contentsEntry(url: string, outcome: ContentsOutcome): ContentsEntry {
	if ("absent" in outcome) return { status: null, result: null };
	if ("errorTag" in outcome) {
		return {
			status: { id: url, status: "error", error: { tag: outcome.errorTag } },
			result: null,
		};
	}
	return {
		status: { id: url, status: "success" },
		result: { url, text: outcome.text },
	};
}

function resolveContentsOutcome(
	byUrl: Record<string, ContentsOutcome>,
	url: string,
): ContentsOutcome {
	const outcome = byUrl[url];
	if (!outcome) throw new Error(`unexpected contents request for ${url}`);
	return outcome;
}

/** The Exa `/contents` endpoint, answering only the urls named in `byUrl`; an `absent` entry is requested but left out of the reply entirely, and any url missing from `byUrl` throws. */
export function exaContentsFetch(
	byUrl: Record<string, ContentsOutcome>,
): typeof fetch {
	return async (_input, init) => {
		const { urls } = ContentsRequestSchema.parse(
			JSON.parse(String(init?.body)),
		);
		const entries = urls.map((url) =>
			contentsEntry(url, resolveContentsOutcome(byUrl, url)),
		);
		return jsonResponse({
			requestId: "req-contents",
			results: entries.flatMap((entry) => entry.result ?? []),
			statuses: entries.flatMap((entry) => entry.status ?? []),
			costDollars: { total: 0.003 },
		});
	};
}

export type ExaAgentRunScript = {
	completeAfterPolls?: number;
	structured: unknown;
	costDollars?: { total: number; agentCompute?: number };
};

/** An Exa agent-run `fetch`: a POST starts a run and is recorded, a GET polls it, completing after `completeAfterPolls` polls (default one) with `structured` as its output. */
export function fakeExaAgentRun(script: ExaAgentRunScript): {
	fetch: typeof fetch;
	started: { body: unknown }[];
} {
	const started: { body: unknown }[] = [];
	const pollCounts = new Map<string, number>();
	const completeAfter = script.completeAfterPolls ?? 1;
	let nextId = 0;
	const handler: typeof fetch = async (input, init) => {
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			started.push({ body });
			const id = `run-${nextId}`;
			nextId += 1;
			pollCounts.set(id, 0);
			return jsonResponse({ id, status: "running" });
		}
		const id = String(input).split("/").pop() ?? "";
		const count = (pollCounts.get(id) ?? 0) + 1;
		pollCounts.set(id, count);
		if (count < completeAfter) return jsonResponse({ id, status: "running" });
		return jsonResponse({
			id,
			object: "agent_run",
			status: "completed",
			stopReason: "schema_satisfied",
			output: { text: "done", structured: script.structured },
			costDollars: script.costDollars ?? { total: 0.01, agentCompute: 0.01 },
		});
	};
	return { fetch: handler, started };
}

/** A completed Exa agent run polling the person the enrich waterfall expects, overridable per field. */
export function completedAgentRun(overrides: { output?: unknown } = {}) {
	return {
		id: "agent-run-1",
		status: "completed",
		output: {
			structured: {
				fullName: "Kirk Marple",
				title: "Founder and Chief Executive Officer",
				email: "kirk@graphlit.com",
				linkedinUrl: "https://www.linkedin.com/in/kirkmarple",
				source: "https://www.linkedin.com/posts/kirkmarple_hiring",
			},
		},
		costDollars: { total: 0.025, agentCompute: 0.02, search: 0.005 },
		...overrides,
	};
}

const CLAY_HEADERS = { "content-type": "application/json" };

export function clayResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: CLAY_HEADERS,
	});
}

export type ClayRosterRow = {
	name: string;
	url: string;
	title: string;
	company: string;
};

/** Stubs `globalThis.fetch` as Clay's filters-mode search followed by its roster read, answering with `rows`. */
export function stubClayFetch(rows: ClayRosterRow[]): void {
	let call = 0;
	globalThis.fetch = async (input) => {
		call += 1;
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			return clayResponse({ search_id: `search-${call}` });
		}
		return clayResponse({
			data: rows.map((row) => ({
				name: row.name,
				url: row.url,
				latest_experience_title: row.title,
				latest_experience_company: row.company,
				latest_experience_start_date: null,
				location: null,
			})),
			has_more: false,
			period_quota: { used: rows.length },
		});
	};
}

/** Stubs `globalThis.fetch` as a Clay search that starts, then rejects every run with a 400. */
export function stubClayRejectFetch(): { runCalls: number } {
	const calls = { runCalls: 0 };
	globalThis.fetch = async (input) => {
		const path = new URL(String(input)).pathname;
		if (path === "/public/v0/search/filters-mode") {
			return clayResponse({ search_id: "search-rejected" });
		}
		calls.runCalls += 1;
		return new Response(
			JSON.stringify({ error: "invalid company_identifier" }),
			{ status: 400, headers: CLAY_HEADERS },
		);
	};
	return calls;
}

export type CapturedRequest = { url: string; headers: Headers; body: unknown };

export type ScriptedReply = {
	content: string;
	finishReason?: "stop" | "length";
	cost?: number | null;
	model?: string;
};

/** The AI Gateway's OpenAI-compatible chat-completion reply, carrying the scripted content and cost. A `cost` of `null` omits `usage.cost` entirely, for the reply shape a real gateway response sometimes carries. */
export function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = reply.model ?? "deepseek/deepseek-v4-flash-0731";
	const cost = reply.cost === undefined ? 0.000003 : reply.cost;
	const payload = {
		id: "chatcmpl-test",
		model,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: reply.content },
				finish_reason: reply.finishReason ?? "stop",
			},
		],
		usage: {
			prompt_tokens: 30,
			completion_tokens: 12,
			...(cost === null ? {} : { cost }),
		},
	};
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cf-aig-model": model,
			"cf-aig-provider": "openrouter",
			"cf-aig-cache-status": "MISS",
		},
	});
}

/** A `fetch` that answers the AI Gateway with each scripted response in turn, recording every request made. */
export function fakeGateway(responses: readonly Response[]): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
} {
	const calls: CapturedRequest[] = [];
	let index = 0;
	const handler: typeof fetch = async (input, init) => {
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body,
		});
		const response = responses[index];
		index += 1;
		if (!response)
			throw new Error(`fakeGateway: no scripted response for call ${index}`);
		return response;
	};
	return { fetch: handler, calls };
}

/** An AI Gateway `fetch` that records every request but never resolves on its own, so a test can flush pending calls before choosing the order each one completes in. */
export function deferredGateway(): {
	fetch: typeof fetch;
	calls: CapturedRequest[];
	resolvers: Array<(response: Response) => void>;
} {
	const calls: CapturedRequest[] = [];
	const resolvers: Array<(response: Response) => void> = [];
	const handler: typeof fetch = (input, init) => {
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body,
		});
		return new Promise<Response>((resolve) => {
			resolvers.push(resolve);
		});
	};
	return { fetch: handler, calls, resolvers };
}
