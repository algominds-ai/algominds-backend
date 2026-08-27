import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Tests run on the real Workers runtime, not Node. Runtime compatibility is the
// main risk this project carries, so a Node-runtime pass proves nothing.
export default defineWorkersConfig({
	test: {
		globals: true,
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
