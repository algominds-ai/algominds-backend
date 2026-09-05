import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/algo";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				hyperdrives: {
					HYPERDRIVE_CACHED: LOCAL_DATABASE_URL,
					HYPERDRIVE_DIRECT: LOCAL_DATABASE_URL,
				},
				bindings: {
					ONBOARD_LIVE_DOMAIN: process.env.ONBOARD_LIVE_DOMAIN ?? "",
					ONBOARD_LIVE_NOTE: process.env.ONBOARD_LIVE_NOTE ?? "",
					ONBOARD_LIVE_FIXTURE: process.env.ONBOARD_LIVE_FIXTURE ?? "{}",
					ONBOARD_LIVE_EXA_KEY: process.env.EXA_API_KEY ?? "",
					ONBOARD_LIVE_AIG_TOKEN: process.env.CF_AIG_TOKEN ?? "",
					ONBOARD_LIVE_GATEWAY_BASE_URL: process.env.AI_GATEWAY_BASE_URL ?? "",
					ONBOARD_LIVE_MODEL_ROUTE: process.env.MODEL_ROUTE_REASONING ?? "",
				},
			},
		}),
	],
	resolve: {
		alias: {
			"@": resolve("src"),
			"@eval": resolve("eval"),
		},
	},
	test: {
		include: ["eval/onboard-live.ts"],
		fileParallelism: false,
		reporters: ["verbose"],
		silent: false,
	},
});
