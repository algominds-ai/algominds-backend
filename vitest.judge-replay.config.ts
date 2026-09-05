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
					JUDGE_REPLAY_CASES: process.env.JUDGE_REPLAY_CASES ?? "[]",
					JUDGE_REPLAY_BATCH: process.env.JUDGE_REPLAY_BATCH ?? "8",
					JUDGE_REPLAY_CAP: process.env.JUDGE_REPLAY_CAP ?? "0.5",
					JUDGE_REPLAY_TWO_PASS: process.env.JUDGE_REPLAY_TWO_PASS ?? "0",
					JUDGE_REPLAY_AIG_TOKEN: process.env.CF_AIG_TOKEN ?? "",
					JUDGE_REPLAY_GATEWAY_BASE_URL: process.env.AI_GATEWAY_BASE_URL ?? "",
					JUDGE_REPLAY_MODEL_ROUTE: process.env.MODEL_ROUTE_REASONING ?? "",
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
		include: ["eval/judge-replay.ts"],
		fileParallelism: false,
		reporters: ["verbose"],
		silent: false,
	},
});
