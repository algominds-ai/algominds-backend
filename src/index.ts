import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";
import { Hono } from "hono";
import { createApiRoutes } from "@/routes";

export { EnrichWorkflow } from "@/workflows/enrich";
export { FindCompaniesWorkflow } from "@/workflows/find-companies";

const bundled = {
	generateText: typeof generateText,
	createMCPClient: typeof createMCPClient,
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, bundled }));

app.route("/", createApiRoutes());

export default app;

export class FindPeopleWorkflow extends WorkflowEntrypoint<Env> {
	override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep) {
		throw new Error("FindPeopleWorkflow: not implemented");
	}
}
