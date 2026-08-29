import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Hono } from "hono";
import {
	companiesFindSchema,
	enrichSchema,
	pageQuerySchema,
	peopleFindSchema,
} from "@/http/schemas";

export const OPENAPI_DOCUMENT_PATH = "/openapi.json";
export const SWAGGER_UI_PATH = "/docs";

const API_KEY_SCHEME = "ApiKeyAuth";
const BEARER_SCHEME = "BearerAuth";
const SECURITY = [{ [API_KEY_SCHEME]: [] }, { [BEARER_SCHEME]: [] }];
const UNKNOWN_RUN = "The run is unknown, or belongs to another organization.";

const runIdParams = z.object({
	runId: z
		.string()
		.min(1)
		.openapi({
			param: { name: "runId", in: "path" },
			example: "companies_11111111-1111-4111-8111-111111111111_2026-08-27",
		}),
});

const startedResponse = z
	.object({
		runId: z.string(),
		icpId: z.uuid().optional(),
		status: z.literal("started"),
	})
	.openapi("StartedRun");

const existingResponse = z
	.object({
		runId: z.string(),
		icpId: z.uuid().optional(),
		status: z.literal("existing"),
	})
	.openapi("ExistingRun");

const issuesResponse = z
	.object({ issues: z.array(z.unknown()) })
	.openapi("ValidationIssues");

const errorResponse = z.object({ error: z.string() }).openapi("ErrorMessage");

const unauthorizedResponse = z
	.object({ error: z.literal("unauthorized") })
	.openapi("Unauthorized");

const runStatusResponse = z
	.object({
		runId: z.string(),
		capability: z.string(),
		status: z.string().openapi({
			description:
				"Whether the run is still going: running, complete or errored. Poll this.",
		}),
		outcome: z.string().nullable().openapi({
			description:
				"How it went, once it has finished: complete, short, empty, exhausted or capped. Null while it is still running.",
		}),
		costDollars: z.number(),
		startedAt: z.string(),
		finishedAt: z.string().nullable(),
		summary: z.unknown().optional().openapi({
			description:
				"The counts the capability reported: how many were asked for, how many were found, and one line per round.",
		}),
	})
	.openapi("RunStatus");

/**
 * A stored row, described but not enumerated. The columns live in
 * `src/core/db/schema.ts` and are inferred from there; repeating them here
 * would produce a second list that goes stale the next time one changes.
 */
function storedRow(name: string, description: string) {
	return z.unknown().openapi(name, { description });
}

const companyRow = storedRow(
	"Company",
	"One company row as stored, with its id, domain, name and the vendor record it was found from.",
);

const personRow = storedRow(
	"Person",
	"One person row as stored, with its id, the company it belongs to, and its LinkedIn URL, name and title where known.",
);

function pageResponse<Row extends z.ZodTypeAny>(row: Row) {
	return z.object({
		rows: z.array(row),
		nextCursor: z.string().nullable(),
		limit: z.number().int(),
	});
}

const companiesPageResponse = pageResponse(companyRow).openapi("CompaniesPage");
const peoplePageResponse = pageResponse(personRow).openapi("PeoplePage");

function jsonResponse<Schema extends z.ZodTypeAny>(
	schema: Schema,
	description: string,
) {
	return { description, content: { "application/json": { schema } } };
}

/**
 * A request body with worked examples. A schema built from a union renders as
 * one shape in a documentation viewer, which hides that the route accepts more
 * than one, so each way of calling it is named and shown.
 */
function jsonBodyWithExamples<Schema extends z.ZodTypeAny>(
	schema: Schema,
	examples: Record<string, { summary: string; value: unknown }>,
) {
	return { content: { "application/json": { schema, examples } } };
}

const unauthorizedEntry = jsonResponse(
	unauthorizedResponse,
	"No valid API key was presented.",
);

/** The shared envelope for the three start routes: new, existing, bad body, unknown reference, unauthorized. */
function startRouteResponses(unknownReferenceDescription: string) {
	return {
		202: jsonResponse(startedResponse, "A new run started."),
		200: jsonResponse(
			existingResponse,
			"A run for this scope already exists today.",
		),
		400: jsonResponse(
			issuesResponse,
			"The request body failed schema validation.",
		),
		404: jsonResponse(errorResponse, unknownReferenceDescription),
		401: unauthorizedEntry,
	};
}

/** The shared envelope for the two run-page routes: a page, a bad query, an unknown run, unauthorized. */
function pageRouteResponses<Page extends z.ZodTypeAny>(
	page: Page,
	pageDescription: string,
	badQueryDescription: string,
) {
	return {
		200: jsonResponse(page, pageDescription),
		400: jsonResponse(issuesResponse, badQueryDescription),
		404: jsonResponse(errorResponse, UNKNOWN_RUN),
		401: unauthorizedEntry,
	};
}

const findCompaniesRoute = createRoute({
	method: "post",
	path: "/companies/find",
	tags: ["companies"],
	security: SECURITY,
	request: {
		body: jsonBodyWithExamples(companiesFindSchema, {
			"describe the companies in words": {
				summary:
					"Send a profile as free text. The engine stores it and reuses it.",
				value: {
					prompt:
						"B2B software companies in the United States with 20 to 200 employees that run their own outbound sales team.",
					count: 10,
				},
			},
			"reuse a profile you already have": {
				summary:
					"Send the id of a stored profile. Companies it already found are not paid for again.",
				value: {
					icpId: "8f1c2b4e-3a5d-4c6f-9b0a-1d2e3f4a5b6c",
					count: 10,
				},
			},
			"exclude companies you already know": {
				summary:
					"Name domains the search must not return, alongside either form.",
				value: {
					prompt: "Specialty coffee roasters that sell wholesale to cafes.",
					count: 5,
					excludeDomains: ["known-competitor.com"],
				},
			},
		}),
	},
	responses: startRouteResponses("The referenced ICP is unknown."),
});

const findPeopleRoute = createRoute({
	method: "post",
	path: "/people/find",
	tags: ["people"],
	security: SECURITY,
	request: {
		body: jsonBodyWithExamples(peopleFindSchema, {
			"every company a run found": {
				summary: "Search the companies of a finished companies run.",
				value: { runId: "companies_8f1c2b4e_2026-08-29", maxCompanies: 25 },
			},
			"a list of domains you name": {
				summary:
					"Search companies you already hold, which must belong to one profile.",
				value: { domains: ["acme.com", "widget.io"] },
			},
		}),
	},
	responses: startRouteResponses("The referenced source run is unknown."),
});

const enrichRoute = createRoute({
	method: "post",
	path: "/enrich",
	tags: ["enrich"],
	security: SECURITY,
	request: {
		body: jsonBodyWithExamples(enrichSchema, {
			"find work emails": {
				summary: "Enrich the people a run holds, one channel at a time.",
				value: { runId: "people_8f1c2b4e_2026-08-29", channels: ["email"] },
			},
		}),
	},
	responses: startRouteResponses("The referenced source run is unknown."),
});

const runStatusRoute = createRoute({
	method: "get",
	path: "/runs/{runId}",
	tags: ["runs"],
	security: SECURITY,
	request: { params: runIdParams },
	responses: {
		200: jsonResponse(
			runStatusResponse,
			"The run, and the counts its capability reported.",
		),
		404: jsonResponse(errorResponse, UNKNOWN_RUN),
		401: unauthorizedEntry,
	},
});

const runCompaniesRoute = createRoute({
	method: "get",
	path: "/runs/{runId}/companies",
	tags: ["runs"],
	security: SECURITY,
	request: { params: runIdParams, query: pageQuerySchema },
	responses: pageRouteResponses(
		companiesPageResponse,
		"One page of the companies a run found.",
		"The page query failed schema validation.",
	),
});

const runPeopleRoute = createRoute({
	method: "get",
	path: "/runs/{runId}/people",
	tags: ["runs"],
	security: SECURITY,
	request: { params: runIdParams, query: pageQuerySchema },
	responses: pageRouteResponses(
		peoplePageResponse,
		"One page of the people a run's companies hold.",
		"The page query failed schema validation, or the run holds no people of its own.",
	),
});

const ROUTES = [
	findCompaniesRoute,
	findPeopleRoute,
	enrichRoute,
	runStatusRoute,
	runCompaniesRoute,
	runPeopleRoute,
];

/**
 * Builds the OpenAPI document by registering every route on a throwaway
 * registry. This registry is never mounted as a live router, so it can
 * neither serve nor shadow a real request.
 */
function buildOpenApiDocument() {
	const registry = new OpenAPIHono();
	registry.openAPIRegistry.registerComponent(
		"securitySchemes",
		API_KEY_SCHEME,
		{
			type: "apiKey",
			in: "header",
			name: "x-api-key",
		},
	);
	registry.openAPIRegistry.registerComponent("securitySchemes", BEARER_SCHEME, {
		type: "http",
		scheme: "bearer",
	});
	for (const route of ROUTES) registry.openAPIRegistry.registerPath(route);
	return registry.getOpenAPIDocument({
		openapi: "3.0.0",
		info: { title: "Algominds GTM Engine API", version: "1.0.0" },
		servers: [{ url: "/" }],
	});
}

const openApiDocument = buildOpenApiDocument();

/**
 * Serves the OpenAPI document and its Swagger UI. Both answer with no API
 * key, since they describe the API rather than acting as part of it.
 */
export function mountOpenApi(app: Hono<{ Bindings: Env }>): void {
	app.get(OPENAPI_DOCUMENT_PATH, (c) => c.json(openApiDocument));
	app.get(SWAGGER_UI_PATH, swaggerUI({ url: OPENAPI_DOCUMENT_PATH }));
}
