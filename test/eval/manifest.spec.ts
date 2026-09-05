import type { ManifestInput } from "@eval/manifest";
import { buildManifest, sha256Hex, WINNER_RULE } from "@eval/manifest";
import { describe, expect, it } from "vitest";

describe("sha256Hex", () => {
	it("hashes the same text to the same digest", async () => {
		expect(await sha256Hex("config")).toBe(await sha256Hex("config"));
	});

	it("hashes different text to different digests", async () => {
		expect(await sha256Hex("config-a")).not.toBe(await sha256Hex("config-b"));
	});
});

function manifestInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
	return {
		experiment: "abc123-baseline",
		commit: "abc123",
		arm: "baseline",
		datasetSnapshotIds: { mstone: "snap-1" },
		configText: "companies:\n  maxRounds: 3\n",
		scorerPrompts: { fitReading: "read the fit and explain why" },
		resolvedModelIds: { reasoning: "gpt-5" },
		runIds: { mstone: ["run-1", "run-2"] },
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:10:00.000Z",
		totalSpendDollars: 1.5,
		perProfileSpendDollars: { mstone: 1.5 },
		scoredRows: [
			{
				slug: "mstone",
				trialIndex: 0,
				companies: [{ domain: "a.com", label: "accept" }],
				people: [
					{
						linkedinUrl: "https://linkedin.com/in/a",
						company: "a.com",
						label: "accept",
					},
				],
			},
		],
		keyFileVersions: {
			mstone: { companyKeyHash: "hash-1", peopleKeyHash: "hash-2" },
		},
		...overrides,
	};
}

describe("buildManifest", () => {
	it("hashes the config text and every named scorer prompt", async () => {
		const manifest = await buildManifest(manifestInput());
		expect(manifest.configHash).toBe(
			await sha256Hex("companies:\n  maxRounds: 3\n"),
		);
		expect(manifest.scorerPromptHashes.fitReading).toBe(
			await sha256Hex("read the fit and explain why"),
		);
		expect(manifest.winnerRule).toBe(WINNER_RULE);
		expect(manifest.runIds.mstone).toEqual(["run-1", "run-2"]);
		expect(manifest.datasetSnapshotIds.mstone).toBe("snap-1");
	});

	it("carries the scored rows and key file versions through unchanged", async () => {
		const manifest = await buildManifest(manifestInput());
		expect(manifest.scoredRows[0]?.companies[0]?.label).toBe("accept");
		expect(manifest.scoredRows[0]?.people[0]?.company).toBe("a.com");
		expect(manifest.keyFileVersions.mstone?.companyKeyHash).toBe("hash-1");
		expect(manifest.keyFileVersions.mstone?.peopleKeyHash).toBe("hash-2");
	});

	it("carries a different config hash for a config that changed by one byte", async () => {
		const a = await buildManifest(
			manifestInput({ configText: "companies:\n  maxRounds: 3\n" }),
		);
		const b = await buildManifest(
			manifestInput({ configText: "companies:\n  maxRounds: 4\n" }),
		);
		expect(a.configHash).not.toBe(b.configHash);
	});
});
