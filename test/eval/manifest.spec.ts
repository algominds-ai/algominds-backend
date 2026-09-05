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

describe("buildManifest", () => {
	it("hashes the config text and every named scorer prompt", async () => {
		const manifest = await buildManifest({
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
		});
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

	it("carries a different config hash for a config that changed by one byte", async () => {
		const base = { text: "companies:\n  maxRounds: 3\n" };
		const changed = { text: "companies:\n  maxRounds: 4\n" };
		const a = await buildManifest({
			experiment: "e",
			commit: "c",
			arm: "a",
			datasetSnapshotIds: {},
			configText: base.text,
			scorerPrompts: {},
			resolvedModelIds: {},
			runIds: {},
			startedAt: "t",
			finishedAt: "t",
			totalSpendDollars: 0,
			perProfileSpendDollars: {},
		});
		const b = await buildManifest({
			experiment: "e",
			commit: "c",
			arm: "a",
			datasetSnapshotIds: {},
			configText: changed.text,
			scorerPrompts: {},
			resolvedModelIds: {},
			runIds: {},
			startedAt: "t",
			finishedAt: "t",
			totalSpendDollars: 0,
			perProfileSpendDollars: {},
		});
		expect(a.configHash).not.toBe(b.configHash);
	});
});
