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
					SELECT_REPLAY_RAW: process.env.SELECT_REPLAY_RAW ?? "",
					SELECT_REPLAY_MODE: process.env.SELECT_REPLAY_MODE ?? "dry",
					SELECT_REPLAY_AIG_TOKEN: process.env.CF_AIG_TOKEN ?? "",
					SELECT_REPLAY_GATEWAY_BASE_URL: process.env.AI_GATEWAY_BASE_URL ?? "",
					SELECT_REPLAY_MODEL_ROUTE: process.env.MODEL_ROUTE_REASONING ?? "",
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
		include: ["eval/select-replay.ts"],
		fileParallelism: false,
		reporters: ["verbose"],
		silent: false,
	},
});
