import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

const TEST_DATABASE_URL =
	"postgresql://postgres:postgres@localhost:5432/algo_test";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				hyperdrives: {
					HYPERDRIVE_CACHED: TEST_DATABASE_URL,
					HYPERDRIVE_DIRECT: TEST_DATABASE_URL,
				},
			},
		}),
	],
	resolve: {
		alias: {
			"@": resolve("src"),
		},
	},
	test: {
		globalSetup: "./test/global-setup.ts",
		fileParallelism: false,
		exclude: [...configDefaults.exclude, "**/.claude/**"],
		onUnhandledError(error) {
			const stack = error.stack ?? "";
			if (
				error.message === "Stream was cancelled." &&
				stack.includes("postgres/cf/polyfills.js")
			) {
				return false;
			}
			return undefined;
		},
	},
});
