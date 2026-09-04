import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ARM_SEED_PROFILES } from "@eval/arm-seed";

function flagValue(argv: readonly string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

function profileArg(argv: readonly string[]): string {
	const slug = flagValue(argv, "--profile");
	if (!slug) throw new Error("eval:onboard: pass --profile <slug>");
	return slug;
}

function seedProfile(slug: string): (typeof ARM_SEED_PROFILES)[number] {
	const profile = ARM_SEED_PROFILES.find((entry) => entry.slug === slug);
	if (!profile) throw new Error(`eval:onboard: unknown profile ${slug}`);
	return profile;
}

function noteFor(slug: string): string {
	return readFileSync(`eval/arm-seed/${slug}.note.txt`, "utf8").trim();
}

/** Runs the live onboarding call in its own workerd instance, inheriting stdio so its PASS/FAIL lines print directly; returns its exit code. */
function runLive(domain: string, note: string, fixture: unknown): number {
	const result = spawnSync(
		"bunx",
		["vitest", "run", "--config", "vitest.onboard-live.config.ts"],
		{
			stdio: "inherit",
			env: {
				...process.env,
				SFW_SHIM_DISABLE: "1",
				ONBOARD_LIVE_DOMAIN: domain,
				ONBOARD_LIVE_NOTE: note,
				ONBOARD_LIVE_FIXTURE: JSON.stringify(fixture),
			},
		},
	);
	return result.status ?? 1;
}

const slug = profileArg(process.argv.slice(2));
const profile = seedProfile(slug);
const domain = profile.doc.seller?.domain;
if (!domain) throw new Error(`eval:onboard: ${slug} has no seller domain`);
process.exit(runLive(domain, noteFor(slug), profile.doc));
