import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";
import { Hono } from "hono";

const bundled = {
	generateText: typeof generateText,
	createMCPClient: typeof createMCPClient,
};

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, bundled }));

export default app;

export class FindCompaniesWorkflow extends WorkflowEntrypoint<Env> {
	override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep) {
		throw new Error("FindCompaniesWorkflow: not implemented (U8)");
	}
}

export class FindPeopleWorkflow extends WorkflowEntrypoint<Env> {
	override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep) {
		throw new Error("FindPeopleWorkflow: not implemented (U12)");
	}
}

export class EnrichWorkflow extends WorkflowEntrypoint<Env> {
	override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep) {
		throw new Error("EnrichWorkflow: not implemented (U13)");
	}
}
