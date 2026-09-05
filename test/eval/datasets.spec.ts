import { datasetRowsFor, keyDatasetName } from "@eval/datasets";
import { emptyKeyFile } from "@eval/label-core";
import { describe, expect, it } from "vitest";

describe("datasetRowsFor", () => {
	it("makes one row per company, id'ed by domain, expected carrying the label", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		key.companies["a.com"] = {
			label: "accept",
			name: "A Inc",
			firstSeenRunId: "run-1",
			lastSeenAt: "2026-01-01T00:00:00.000Z",
		};
		expect(datasetRowsFor(key)).toEqual([
			{
				id: "a.com",
				input: { domain: "a.com" },
				expected: "accept",
				metadata: {
					name: "A Inc",
					firstSeenRunId: "run-1",
					lastSeenAt: "2026-01-01T00:00:00.000Z",
				},
			},
		]);
	});

	it("carries a null label through for a company nobody has reviewed yet", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		key.companies["b.com"] = {
			label: null,
			name: "B Inc",
			firstSeenRunId: "run-1",
			lastSeenAt: "t",
		};
		expect(datasetRowsFor(key)[0]?.expected).toBeNull();
	});

	it("is empty for a key with no companies", () => {
		expect(datasetRowsFor(emptyKeyFile("dental", "icp-2"))).toEqual([]);
	});
});

describe("keyDatasetName", () => {
	it("prefixes the profile slug so it cannot collide with a dataset from another harness", () => {
		expect(keyDatasetName("mstone")).toBe("key-mstone");
	});
});
