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
		status: z.string(),
		output: z.unknown().optional(),
		error: z.string().optional(),
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

/** One JSON response entry for a `createRoute` responses map. */
function jsonResponse<Schema extends z.ZodTypeAny>(
	schema: Schema,
	description: string,
) {
	return { description, content: { "application/json": { schema } } };
}

const unauthorizedEntry = jsonResponse(
	unauthorizedResponse,
	"No valid API key was presented.",
);

const findCompaniesRoute = createRoute({
	method: "post",
	path: "/companies/find",
	tags: ["companies"],
	security: SECURITY,
	request: {
		body: { content: { "application/json": { schema: companiesFindSchema } } },
	},
	responses: {
		202: jsonResponse(startedResponse, "A new run started."),
		200: jsonResponse(
			existingResponse,
			"A run for this scope already exists today.",
		),
		400: jsonResponse(
			issuesResponse,
			"The request body failed schema validation.",
		),
		404: jsonResponse(errorResponse, "The referenced ICP is unknown."),
		401: unauthorizedEntry,
	},
});

const findPeopleRoute = createRoute({
	method: "post",
	path: "/people/find",
	tags: ["people"],
	security: SECURITY,
	request: {
		body: { content: { "application/json": { schema: peopleFindSchema } } },
	},
	responses: {
		202: jsonResponse(startedResponse, "A new run started."),
		200: jsonResponse(
			existingResponse,
			"A run for this scope already exists today.",
		),
		400: jsonResponse(
			issuesResponse,
			"The request body failed schema validation.",
		),
		404: jsonResponse(errorResponse, "The referenced source run is unknown."),
		401: unauthorizedEntry,
	},
});

const enrichRoute = createRoute({
	method: "post",
	path: "/enrich",
	tags: ["enrich"],
	security: SECURITY,
	request: {
		body: { content: { "application/json": { schema: enrichSchema } } },
	},
	responses: {
		202: jsonResponse(startedResponse, "A new run started."),
		200: jsonResponse(
			existingResponse,
			"A run for this scope already exists today.",
		),
		400: jsonResponse(
			issuesResponse,
			"The request body failed schema validation.",
		),
		404: jsonResponse(errorResponse, "The referenced source run is unknown."),
		401: unauthorizedEntry,
	},
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
			"The Workflow instance status, verbatim.",
		),
		404: jsonResponse(
			errorResponse,
			"The run is unknown, or belongs to another organization.",
		),
		401: unauthorizedEntry,
	},
});

const runCompaniesRoute = createRoute({
	method: "get",
	path: "/runs/{runId}/companies",
	tags: ["runs"],
	security: SECURITY,
	request: { params: runIdParams, query: pageQuerySchema },
	responses: {
		200: jsonResponse(
			companiesPageResponse,
			"One page of the companies a run found.",
		),
		400: jsonResponse(
			issuesResponse,
			"The page query failed schema validation.",
		),
		404: jsonResponse(
			errorResponse,
			"The run is unknown, or belongs to another organization.",
		),
		401: unauthorizedEntry,
	},
});

const runPeopleRoute = createRoute({
	method: "get",
	path: "/runs/{runId}/people",
	tags: ["runs"],
	security: SECURITY,
	request: { params: runIdParams, query: pageQuerySchema },
	responses: {
		200: jsonResponse(
			peoplePageResponse,
			"One page of the people a run's companies hold.",
		),
		400: jsonResponse(
			issuesResponse,
			"The page query failed schema validation, or the run holds no people of its own.",
		),
		404: jsonResponse(
			errorResponse,
			"The run is unknown, or belongs to another organization.",
		),
		401: unauthorizedEntry,
	},
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
