import { readFileSync } from "node:fs";
import type { ApiClient } from "@eval/api-client";
import { startPeopleRun, waitForRunTerminal } from "@eval/api-client";
import { bootstrapArmSchema, seedArmProfiles } from "@eval/arm-db";
import { startDevServer } from "@eval/dev-server";

function flagValue(argv: readonly string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

/** Runs one find-people request for `--profile` on the domains listed one per line in `--domains <file>`, inside `eval_<arm>` on `--port`, and prints the run id. */
async function main(argv: readonly string[]): Promise<void> {
	const arm = flagValue(argv, "--arm");
	const slug = flagValue(argv, "--profile");
	const domainsFile = flagValue(argv, "--domains");
	const port = Number.parseInt(flagValue(argv, "--port") ?? "8787", 10);
	if (!arm || !slug || !domainsFile) {
		throw new Error("eval:people:live needs --arm, --profile and --domains");
	}
	const domains = readFileSync(domainsFile, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	bootstrapArmSchema(arm);
	const seeded = await seedArmProfiles(arm, 1);
	const trial = seeded.find((row) => row.slug === slug);
	if (!trial) throw new Error(`eval:people:live unknown profile ${slug}`);
	const server = await startDevServer(arm, port);
	try {
		const client: ApiClient = { baseUrl: server.url, apiKey: trial.apiKey };
		const runId = await startPeopleRun(client, trial.icpId, domains);
		console.log(`${slug}: started ${runId} on ${domains.length} domains`);
		await waitForRunTerminal(client, runId);
		console.log(`${slug}: finished ${runId}`);
	} finally {
		server.stop();
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
