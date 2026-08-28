import { Hono } from "hono";
import type { ApiEnv } from "@/http/auth";
import { requireApiKey } from "@/http/auth";
import { domainsScopeId, resolveIcpId, startJob } from "@/http/jobs";
import { getRunCompanies, getRunPeople, getRunStatus } from "@/http/runs";
import {
	companiesFindSchema,
	enrichSchema,
	peopleFindSchema,
} from "@/http/schemas";

/** The bearer-protected job API: three start routes plus one status route. */
export function createApiRoutes(): Hono<ApiEnv> {
	const api = new Hono<ApiEnv>();
	api.use("*", requireApiKey);

	api.post("/companies/find", (c) =>
		startJob(c, companiesFindSchema, {
			capability: "companies",
			workflow: c.env.FIND_COMPANIES,
			toJob: async (body, env) => {
				const icpId = await resolveIcpId(env, body, c.get("organizationId"));
				if (icpId === null) return null;
				return { scopeId: icpId, icpId, params: { icpId, count: body.count } };
			},
		}),
	);

	api.post("/people/find", (c) =>
		startJob(c, peopleFindSchema, {
			capability: "people",
			workflow: c.env.FIND_PEOPLE,
			toJob: async (body, _env, organizationId) => {
				if ("runId" in body) {
					return {
						scopeId: body.runId,
						sourceRunId: body.runId,
						params: {
							runId: body.runId,
							maxCompanies: body.maxCompanies,
							organizationId,
						},
					};
				}
				return {
					scopeId: await domainsScopeId(body.domains, organizationId),
					params: {
						domains: body.domains,
						maxCompanies: body.maxCompanies,
						organizationId,
					},
				};
			},
		}),
	);

	api.post("/enrich", (c) =>
		startJob(c, enrichSchema, {
			capability: "enrich",
			workflow: c.env.ENRICH,
			toJob: async (body) => ({
				scopeId: body.runId,
				sourceRunId: body.runId,
				params: body,
			}),
		}),
	);

	api.get("/runs/:runId", getRunStatus);
	api.get("/runs/:runId/companies", getRunCompanies);
	api.get("/runs/:runId/people", getRunPeople);

	return api;
}
