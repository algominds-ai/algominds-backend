import { Hono } from "hono";
import type { ApiEnv } from "@/http/auth";
import { requireApiKey } from "@/http/auth";
import { domainsScopeId, resolveIcpId, startJob } from "@/http/jobs";
import {
	getRunCompanies,
	getRunPeople,
	getRunRounds,
	getRunStatus,
} from "@/http/runs";
import {
	companiesFindSchema,
	enrichSchema,
	onboardIcpSchema,
	peopleFindSchema,
} from "@/http/schemas";

/** The bearer-protected job API: four routes that start a capability, and the routes that read a run back. */
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
				const scopeId = body.excludeDomains
					? await domainsScopeId(body.excludeDomains, icpId)
					: icpId;
				return {
					scopeId,
					icpId,
					params: {
						icpId,
						count: body.count,
						...(body.excludeDomains
							? { excludeDomains: body.excludeDomains }
							: {}),
					},
				};
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

	api.post("/icp/onboard", (c) =>
		startJob(c, onboardIcpSchema, {
			capability: "onboarding",
			workflow: c.env.ONBOARD_ICP,
			toJob: async (body, _env, organizationId) => ({
				scopeId: await domainsScopeId([body.domain], organizationId),
				params: {
					domain: body.domain,
					note: body.note ?? null,
					organizationId,
				},
			}),
		}),
	);

	api.get("/runs/:runId", getRunStatus);
	api.get("/runs/:runId/companies", getRunCompanies);
	api.get("/runs/:runId/people", getRunPeople);
	api.get("/runs/:runId/rounds", getRunRounds);

	return api;
}
