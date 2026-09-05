import type { ScoredCompanyRow, ScoredPersonRow } from "@eval/scorers";

export const WINNER_RULE =
	"An arm wins a profile when gates_pass holds for the full chain; among " +
	"arms that clear the gates, higher engine_score wins. Declared before " +
	"any arm runs; never chosen after seeing the numbers.";

export type ScoredTrialRow = {
	slug: string;
	trialIndex: number;
	companies: readonly ScoredCompanyRow[];
	people: readonly ScoredPersonRow[];
};

export type KeyFileVersion = {
	companyKeyHash: string;
	peopleKeyHash: string;
};

export async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export type ManifestInput = {
	experiment: string;
	commit: string;
	arm: string;
	datasetSnapshotIds: Readonly<Record<string, string | null>>;
	configText: string;
	scorerPrompts: Readonly<Record<string, string>>;
	resolvedModelIds: Readonly<Record<string, string>>;
	runIds: Readonly<Record<string, readonly string[]>>;
	startedAt: string;
	finishedAt: string;
	totalSpendDollars: number;
	perProfileSpendDollars: Readonly<Record<string, number>>;
	scoredRows: readonly ScoredTrialRow[];
	keyFileVersions: Readonly<Record<string, KeyFileVersion>>;
};

export type Manifest = {
	experiment: string;
	commit: string;
	arm: string;
	datasetSnapshotIds: Readonly<Record<string, string | null>>;
	configHash: string;
	scorerPromptHashes: Record<string, string>;
	resolvedModelIds: Record<string, string>;
	runIds: Record<string, readonly string[]>;
	startedAt: string;
	finishedAt: string;
	totalSpendDollars: number;
	perProfileSpendDollars: Record<string, number>;
	scoredRows: readonly ScoredTrialRow[];
	keyFileVersions: Record<string, KeyFileVersion>;
	winnerRule: string;
};

async function hashEntries(
	entries: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
	const hashed: Record<string, string> = {};
	for (const [name, text] of Object.entries(entries)) {
		hashed[name] = await sha256Hex(text);
	}
	return hashed;
}

/**
 * The complete, predeclared record of one experiment: what code ran it, what
 * data and config it ran against, what it cost, the fixed rule that decides
 * a winner, and every row and key file hash a trial scored against — so an
 * arm cannot be re-judged by a metric picked after the numbers were in, and
 * a trial can be rescored offline from this alone.
 */
export async function buildManifest(input: ManifestInput): Promise<Manifest> {
	return {
		experiment: input.experiment,
		commit: input.commit,
		arm: input.arm,
		datasetSnapshotIds: { ...input.datasetSnapshotIds },
		configHash: await sha256Hex(input.configText),
		scorerPromptHashes: await hashEntries(input.scorerPrompts),
		resolvedModelIds: { ...input.resolvedModelIds },
		runIds: { ...input.runIds },
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		totalSpendDollars: input.totalSpendDollars,
		perProfileSpendDollars: { ...input.perProfileSpendDollars },
		scoredRows: input.scoredRows.map((row) => ({ ...row })),
		keyFileVersions: { ...input.keyFileVersions },
		winnerRule: WINNER_RULE,
	};
}
