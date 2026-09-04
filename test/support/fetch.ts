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

export type CapturedFetch = { url: string; headers: Headers; body: unknown };

/** An Exa `/search` success reply carrying one result per page, costed at a flat total. */
export function exaSearchResultsResponse(
	pages: readonly { url: string; text: string }[],
): Response {
	return jsonResponse({
		requestId: "req-search",
		costDollars: { total: 0.01 },
		results: pages.map((page) => ({
			url: page.url,
			title: page.url,
			text: page.text,
		})),
	});
}

/** A `fetch` that answers Exa calls and model-gateway calls from two separate scripted queues, recording both. */
export function fakeExaAndModel(
	exa: readonly Response[],
	model: readonly Response[],
): {
	fetch: typeof fetch;
	exaCalls: CapturedFetch[];
	modelCalls: CapturedFetch[];
} {
	const exaCalls: CapturedFetch[] = [];
	const modelCalls: CapturedFetch[] = [];
	let exaIndex = 0;
	let modelIndex = 0;
	const handler: typeof fetch = async (input, init) => {
		const url = String(input);
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const captured: CapturedFetch = {
			url,
			headers: new Headers(init?.headers),
			body,
		};
		if (url.includes("api.exa.ai")) {
			const response = exa[exaIndex];
			exaIndex += 1;
			exaCalls.push(captured);
			if (!response)
				throw new Error("fakeExaAndModel: no scripted exa response left");
			return response;
		}
		const response = model[modelIndex];
		modelIndex += 1;
		modelCalls.push(captured);
		if (!response)
			throw new Error("fakeExaAndModel: no scripted model response left");
		return response;
	};
	return { fetch: handler, exaCalls, modelCalls };
}

export function requestedEmail(init: RequestInit | undefined): string {
	const body: { email?: string } = JSON.parse(String(init?.body ?? "{}"));
	return body.email ?? "";
}

const ContentsRequestSchema = z.object({ urls: z.array(z.string()) });

type ContentsOutcome = { text: string } | { errorTag: string };

/** The Exa `/contents` endpoint, answering only the urls named in `byUrl`; any other url throws. */
export function exaContentsFetch(
	byUrl: Record<string, ContentsOutcome>,
): typeof fetch {
	return async (_input, init) => {
		const { urls } = ContentsRequestSchema.parse(
			JSON.parse(String(init?.body)),
		);
		const results: { url: string; text: string }[] = [];
		const statuses: (
			| { id: string; status: "success" }
			| { id: string; status: "error"; error: { tag: string } }
		)[] = [];
		for (const url of urls) {
			const outcome = byUrl[url];
			if (!outcome) throw new Error(`unexpected contents request for ${url}`);
			if ("errorTag" in outcome) {
				statuses.push({
					id: url,
					status: "error",
					error: { tag: outcome.errorTag },
				});
				continue;
			}
			statuses.push({ id: url, status: "success" });
			results.push({ url, text: outcome.text });
		}
		return jsonResponse({
			requestId: "req-contents",
			results,
			statuses,
			costDollars: { total: 0.003 },
		});
	};
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
	cost?: number;
	model?: string;
};

/** The AI Gateway's OpenAI-compatible chat-completion reply, carrying the scripted content and cost. */
export function chatCompletionResponse(reply: ScriptedReply): Response {
	const model = reply.model ?? "deepseek/deepseek-v4-flash-0731";
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
			cost: reply.cost ?? 0.000003,
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
