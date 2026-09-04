import { armDatabaseName, armDatabaseUrl } from "@eval/arm-db";
import { describe, expect, it } from "vitest";

describe("armDatabaseName", () => {
	it("prefixes the arm name so it cannot collide with algo or algo_test", () => {
		expect(armDatabaseName("baseline")).toBe("eval_baseline");
	});
});

describe("armDatabaseUrl", () => {
	it("builds a local connection string for the arm's own database", () => {
		expect(armDatabaseUrl("baseline")).toBe(
			"postgresql://postgres:postgres@localhost:5432/eval_baseline",
		);
	});
});
