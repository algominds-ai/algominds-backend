import { createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";
import { Hono } from "hono";
import { createAuth } from "@/auth";
import { mountOpenApi } from "@/http/openapi";
import { createApiRoutes } from "@/routes";

export { EnrichWorkflow } from "@/workflows/enrich";
export { FindCompaniesWorkflow } from "@/workflows/find-companies";
export { FindPeopleWorkflow } from "@/workflows/find-people";
export { OnboardIcpWorkflow } from "@/workflows/onboard-icp";

const bundled = {
	generateText: typeof generateText,
	createMCPClient: typeof createMCPClient,
};

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, bundled }));

app.all("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

mountOpenApi(app);
app.route("/", createApiRoutes());

export default app;
