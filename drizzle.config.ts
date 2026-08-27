import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/core/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		// Direct PlanetScale URL for migrations. Runtime goes through Hyperdrive.
		url: process.env.DATABASE_URL ?? "",
	},
});
