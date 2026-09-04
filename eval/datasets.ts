import { readKeyFile } from "@eval/keys-io";
import type { KeyFile } from "@eval/label-core";
import { BRAINTRUST_PROJECT, profilesFor } from "@eval/profiles";
import type { Dataset } from "braintrust";
import { initDataset } from "braintrust";

export type DatasetRow = {
	id: string;
	input: { domain: string };
	expected: string | null;
	metadata: { name: string | null; firstSeenRunId: string; lastSeenAt: string };
};

/**
 * One dataset row per company the key names, `id`ed by domain so a rerun
 * upserts the same row instead of duplicating it. `expected` carries the
 * label a human typed — a scorer input, never a model's output.
 */
export function datasetRowsFor(key: KeyFile): DatasetRow[] {
	return Object.entries(key.companies).map(([domain, entry]) => ({
		id: domain,
		input: { domain },
		expected: entry.label,
		metadata: {
			name: entry.name,
			firstSeenRunId: entry.firstSeenRunId,
			lastSeenAt: entry.lastSeenAt,
		},
	}));
}

export function keyDatasetName(slug: string): string {
	return `key-${slug}`;
}

export function openKeyDataset(slug: string): Dataset {
	return initDataset({
		project: BRAINTRUST_PROJECT,
		dataset: keyDatasetName(slug),
	});
}

export type DatasetSyncResult = { datasetId: string; version: string | null };

/**
 * Pushes `datasetRowsFor(key)` into `dataset`, upserted by domain. Takes the
 * open dataset as an argument rather than opening one itself, so the only
 * logic worth testing — `datasetRowsFor` — is tested without a live
 * Braintrust connection.
 */
export async function syncKeyDataset(
	dataset: Dataset,
	key: KeyFile,
): Promise<DatasetSyncResult> {
	for (const row of datasetRowsFor(key)) dataset.insert(row);
	await dataset.flush();
	const [datasetId, version] = await Promise.all([
		dataset.id,
		dataset.version(),
	]);
	return { datasetId, version: version ?? null };
}

async function main(): Promise<void> {
	const slug = process.argv[2] ?? null;
	for (const profile of profilesFor(slug)) {
		const key = readKeyFile(profile.slug, profile.icpId);
		const result = await syncKeyDataset(openKeyDataset(profile.slug), key);
		console.log(
			`${profile.slug}: ${Object.keys(key.companies).length} rows synced to dataset ${result.datasetId}${result.version ? ` @ ${result.version}` : ""}`,
		);
	}
}

if (import.meta.main) {
	await main();
}
