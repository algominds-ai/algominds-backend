import { runComponent } from "@eval/components";
import app from "@/index";

export {
	EnrichWorkflow,
	FindCompaniesWorkflow,
	FindPeopleWorkflow,
	OnboardIcpWorkflow,
} from "@/index";

export default {
	async fetch(
		request: Request,
		env: Env & { EVAL_TOKEN: string },
		context: ExecutionContext,
	) {
		const path = new URL(request.url).pathname;
		if (path !== "/__eval/component" && path !== "/__eval/health")
			return app.fetch(request, env, context);
		if (
			!env.EVAL_TOKEN ||
			request.headers.get("authorization") !== `Bearer ${env.EVAL_TOKEN}`
		)
			return new Response("Unauthorized", { status: 401 });
		if (path === "/__eval/health") return new Response("OK");
		if (request.method !== "POST")
			return new Response("Method not allowed", { status: 405 });
		try {
			return Response.json(await runComponent(await request.json(), env));
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 500 },
			);
		}
	},
};
