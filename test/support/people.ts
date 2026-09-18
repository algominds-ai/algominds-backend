import { z } from "zod";
import { CandidateSchema } from "@/core/people/candidate";
import type { ResearchPerson } from "@/core/people/research";
import type { ClayRow } from "@/core/providers/clay";
import { chatCompletionResponse, jsonResponse } from "./fetch";

const ModelInputSchema = z.object({
	candidates: z.array(CandidateSchema),
});
const ModelRequestSchema = z.object({
	messages: z.array(z.object({ role: z.string(), content: z.string() })),
});
const AgentInputSchema = z.object({
	input: z.object({ data: z.array(CandidateSchema) }),
});
export type PeopleVendorOptions = {
	omittedIds?: number[];
	filterRejectedIds?: number[];
	pending?: boolean;
	unknownBill?: boolean;
	correctedTitle?: string;
	emptyClay?: boolean;
	pollFailures?: number;
	searchUnresolvedIds?: number[];
	searchRejectedIds?: number[];
	agentUnresolvedIds?: number[];
};

function modelReply(raw: unknown, options: PeopleVendorOptions) {
	const request = ModelRequestSchema.parse(raw);
	const input = ModelInputSchema.parse(
		JSON.parse(
			request.messages.find((message) => message.role === "user")?.content ??
				"{}",
		),
	);
	return {
		decisions: input.candidates.map((row) => ({
			id: row.id,
			reason: "Plausible buyer",
			keep: !options.filterRejectedIds?.includes(row.id),
			band: row.title ?? "unclassified",
		})),
	};
}

function agentReply({
	url,
	body,
	runs,
	options,
}: {
	url: string;
	body: unknown;
	runs: Map<string, ResearchPerson[]>;
	options: PeopleVendorOptions;
}): Response {
	if (url.endsWith("/agent/runs")) {
		const candidates = AgentInputSchema.parse(body).input.data;
		const id = `agent-${runs.size}`;
		runs.set(
			id,
			candidates
				.filter((row) => !options.omittedIds?.includes(row.id))
				.map((row) => ({
					id: row.id,
					decision: options.agentUnresolvedIds?.includes(row.id)
						? "unresolved"
						: "verified",
					identityStatus: "supported",
					currentEmployerStatus: "supported",
					currentRoleStatus: "supported",
					buyerFit: "direct",
					name: row.name,
					title: options.correctedTitle ?? row.title,
					linkedinUrl: row.url,
					reason:
						"Profile and current employer evidence establish identity, operating role and buyer responsibilities",
					roleEvidence: {
						url: "https://example.com/team",
						quote: `${row.name} is our ${options.correctedTitle ?? row.title}.`,
					},
				})),
		);
		return jsonResponse({ id, status: "running" });
	}
	return agentStatus(url, runs, options);
}

function searchReply(raw: unknown, options: PeopleVendorOptions): Response {
	const request = z
		.object({ query: z.string(), outputSchema: z.unknown().optional() })
		.parse(raw);
	if (!request.outputSchema)
		return jsonResponse({
			requestId: "search",
			results: [],
			costDollars: { total: 0.005 },
		});
	const input = z
		.object({ candidate: CandidateSchema })
		.parse(JSON.parse(request.query.split("Context: ")[1] ?? "{}"));
	const row = input.candidate;
	const unresolved = options.searchUnresolvedIds?.includes(row.id);
	const rejected = options.searchRejectedIds?.includes(row.id);
	const quote = `${row.name} is our ${options.correctedTitle ?? row.title}.`;
	const person: ResearchPerson = {
		id: row.id,
		decision: "verified",
		identityStatus: "supported",
		currentEmployerStatus: "supported",
		currentRoleStatus: "supported",
		buyerFit: "direct",
		name: row.name,
		title: options.correctedTitle ?? row.title,
		linkedinUrl: row.url,
		reason: "Current role matches the supplied buyer responsibilities",
		roleEvidence: { url: "https://example.com/team", quote },
	};
	if (unresolved) {
		person.decision = "unresolved";
		person.currentEmployerStatus = "unresolved";
		person.reason = "Current employment is unclear";
	}
	if (rejected) {
		person.decision = "rejected";
		person.buyerFit = "unrelated";
		person.reason = "Responsibilities are unrelated to the supplied offer";
	}
	const { id: _id, roleEvidence, ...fields } = person;
	return jsonResponse({
		requestId: "search",
		results: [
			{ url: "https://example.com/team", title: "Team", highlights: [quote] },
		],
		output: {
			content: { ...fields, roleEvidenceQuote: roleEvidence?.quote ?? null },
		},
		costDollars: { total: 0.012 },
	});
}

function agentStatus(
	url: string,
	runs: Map<string, ResearchPerson[]>,
	options: PeopleVendorOptions,
): Response {
	const id = url.split("/agent/runs/")[1]?.split("/")[0] ?? "";
	if (url.endsWith("/cancel"))
		return jsonResponse({
			id,
			status: "canceled",
			...(options.unknownBill ? {} : { costDollars: { total: 0.03 } }),
		});
	return jsonResponse({
		id,
		status: options.pending ? "running" : "completed",
		output: { structured: { people: runs.get(id) ?? [] } },
		...(options.pending ? {} : { costDollars: { total: 0.1 } }),
	});
}

function clayRows(
	rows: readonly ClayRow[],
	options: PeopleVendorOptions,
): Response {
	return jsonResponse({
		data: options.emptyClay
			? []
			: rows.map((row) => ({
					...row,
					latest_experience_title: row.title,
					latest_experience_company: row.company,
				})),
		has_more: false,
	});
}

function peopleReply(
	url: string,
	body: unknown,
	{
		rows,
		options,
		runs,
	}: {
		rows: readonly ClayRow[];
		options: PeopleVendorOptions;
		runs: Map<string, ResearchPerson[]>;
	},
): Response {
	if (url.includes("/chat/completions"))
		return chatCompletionResponse({
			content: JSON.stringify(modelReply(body, options)),
			cost: 0.001,
		});
	if (url.endsWith("/search/filters-mode"))
		return jsonResponse({ search_id: "clay-one" });
	if (url.endsWith("/search/filters-mode/clay-one/run"))
		return clayRows(rows, options);
	if (url.includes("/agent/runs"))
		return agentReply({ url, body, runs, options });
	if (url.endsWith("/search")) return searchReply(body, options);
	throw new Error(`Unexpected people vendor request: ${url}`);
}

/** Deterministic vendor replies for exercising the actual people functions in the Workers runtime. */
export function fakePeopleVendors(
	rows: readonly ClayRow[],
	options: PeopleVendorOptions = {},
) {
	const calls: string[] = [];
	const runs = new Map<string, ResearchPerson[]>();
	let pollFailures = options.pollFailures ?? 0;
	const vendorFetch: typeof fetch = async (input, init) => {
		const url = String(input);
		calls.push(url);
		if (
			pollFailures > 0 &&
			url.includes("/agent/runs/") &&
			!url.endsWith("/cancel")
		) {
			pollFailures--;
			return jsonResponse({ message: "Status temporarily unavailable" }, 503);
		}
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		return peopleReply(url, body, { rows, options, runs });
	};
	return { fetch: vendorFetch, calls };
}
