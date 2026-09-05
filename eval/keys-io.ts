import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { KeyFile } from "@eval/label-core";
import { emptyKeyFile, KeyFileSchema } from "@eval/label-core";
import type { PeopleKeyFile } from "@eval/people-key";
import { emptyPeopleKeyFile, PeopleKeyFileSchema } from "@eval/people-key";

const KEYS_DIR = "eval/keys";
const PEOPLE_KEYS_DIR = "eval/keys/people";

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

export function peopleKeyPath(slug: string): string {
	return `${PEOPLE_KEYS_DIR}/${slug}.json`;
}

/** The profile's person key file, reconciled to `icpId` when the stored file names a different one. Starts empty when no file exists yet. */
export function readPeopleKeyFile(slug: string, icpId: string): PeopleKeyFile {
	const path = peopleKeyPath(slug);
	if (!existsSync(path)) return emptyPeopleKeyFile(slug, icpId);
	const key = PeopleKeyFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	return key.icpId === icpId ? key : { ...key, icpId };
}

export function writePeopleKeyFile(key: PeopleKeyFile): void {
	mkdirSync(PEOPLE_KEYS_DIR, { recursive: true });
	writeFileSync(
		peopleKeyPath(key.slug),
		`${JSON.stringify(key, null, "\t")}\n`,
	);
}
