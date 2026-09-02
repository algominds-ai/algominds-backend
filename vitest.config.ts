import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	resolve: {
		alias: {
			"@": resolve("src"),
		},
	},
	test: {
		fileParallelism: false,
		exclude: [...configDefaults.exclude, "**/.claude/**"],
	},
});
