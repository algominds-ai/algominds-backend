import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run on the real Workers runtime, not Node. Runtime compatibility is the
// main risk this project carries, so a Node-runtime pass proves nothing.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
