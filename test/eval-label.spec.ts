import {
	emptyKeyFile,
	formatCompanyDetail,
	isValidLabel,
	KeyFileSchema,
	mergeStoredCompanies,
	sortedKeyFile,
	unlabelledDomains,
} from "@eval/label-core";
import { describe, expect, it } from "vitest";

describe("isValidLabel", () => {
	it("accepts the three label shapes a human may type", () => {
		expect(isValidLabel("accept")).toBe(true);
		expect(isValidLabel("reject:not-a-company")).toBe(true);
		expect(isValidLabel("same-as:example.com")).toBe(true);
	});

	it("refuses free text, an empty category, and a domain-less same-as", () => {
		expect(isValidLabel("maybe")).toBe(false);
		expect(isValidLabel("reject:")).toBe(false);
		expect(isValidLabel("same-as:")).toBe(false);
		expect(isValidLabel("same-as:notadomain")).toBe(false);
	});
});

describe("mergeStoredCompanies", () => {
	it("adds an unlabelled entry for a domain the key has never seen", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		const merged = mergeStoredCompanies(key, [
			{
				domain: "a.com",
				name: "A Inc",
				runId: "run-1",
				foundAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		expect(merged.companies["a.com"]).toEqual({
			label: null,
			name: "A Inc",
			firstSeenRunId: "run-1",
			lastSeenAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("never touches an existing entry, labelled or not", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		key.companies["a.com"] = {
			label: "accept",
			name: "Old Name",
			firstSeenRunId: "run-0",
			lastSeenAt: "2025-01-01T00:00:00.000Z",
		};
		const merged = mergeStoredCompanies(key, [
			{
				domain: "a.com",
				name: "New Name",
				runId: "run-2",
				foundAt: "2026-02-02T00:00:00.000Z",
			},
		]);
		expect(merged.companies["a.com"]).toEqual(key.companies["a.com"]);
	});
});

describe("unlabelledDomains", () => {
	it("names only the domains still labelled null, sorted", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		key.companies.b = {
			label: null,
			name: "B",
			firstSeenRunId: "r",
			lastSeenAt: "t",
		};
		key.companies.a = {
			label: null,
			name: "A",
			firstSeenRunId: "r",
			lastSeenAt: "t",
		};
		key.companies.c = {
			label: "accept",
			name: "C",
			firstSeenRunId: "r",
			lastSeenAt: "t",
		};
		expect(unlabelledDomains(key)).toEqual(["a", "b"]);
	});
});

describe("sortedKeyFile", () => {
	it("orders companies by domain", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		key.companies.zeta = {
			label: null,
			name: "Z",
			firstSeenRunId: "r",
			lastSeenAt: "t",
		};
		key.companies.alpha = {
			label: null,
			name: "A",
			firstSeenRunId: "r",
			lastSeenAt: "t",
		};
		expect(Object.keys(sortedKeyFile(key).companies)).toEqual([
			"alpha",
			"zeta",
		]);
	});
});

describe("formatCompanyDetail", () => {
	it("shows (none) for a field the record never carried", () => {
		const block = formatCompanyDetail({
			domain: "a.com",
			name: "A Inc",
			industry: null,
			description: null,
			fitReason: null,
			citedPage: null,
		});
		expect(block).toContain("a.com — A Inc");
		expect(block).toContain("industry:    (none)");
	});
});

describe("KeyFileSchema", () => {
	it("parses a well-formed key file and rejects an invalid label", () => {
		const key = emptyKeyFile("mstone", "icp-1");
		expect(KeyFileSchema.safeParse(key).success).toBe(true);
		expect(
			KeyFileSchema.safeParse({
				...key,
				companies: {
					a: {
						label: "maybe",
						name: null,
						firstSeenRunId: "r",
						lastSeenAt: "t",
					},
				},
			}).success,
		).toBe(false);
	});
});
