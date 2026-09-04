import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KeyFile } from "@eval/label-core";
import { emptyKeyFile, KeyFileSchema } from "@eval/label-core";

const KEYS_DIR = "eval/keys";

export function keyPath(slug: string): string {
	return `${KEYS_DIR}/${slug}.json`;
}

/** The profile's key file, reconciled to `icpId` when the stored file names a different one. Starts empty when no file exists yet. */
export function readKeyFile(slug: string, icpId: string): KeyFile {
	const path = keyPath(slug);
	if (!existsSync(path)) return emptyKeyFile(slug, icpId);
	const key = KeyFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	return key.icpId === icpId ? key : { ...key, icpId };
}

export function writeKeyFile(key: KeyFile): void {
	writeFileSync(keyPath(key.slug), `${JSON.stringify(key, null, "\t")}\n`);
}
