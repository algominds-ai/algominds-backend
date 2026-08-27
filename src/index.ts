import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";
import { Hono } from "hono";

// U1 bundle spike: both imports are referenced at module scope so the bundler
// must resolve their full dependency graphs — including undici and cross-spawn,
// which are aliased to throwing stubs in wrangler.jsonc.
const bundled = {
	generateText: typeof generateText,
	createMCPClient: typeof createMCPClient,
};

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, bundled }));

export default app;

// ponytail: bodies land in U8, U12, U13. They exist now because wrangler.jsonc
// declares the bindings, and config that names a class the code does not export
// fails the bundle check.
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
