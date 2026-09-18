import { readFileSync } from "node:fs";
import { CaseSchema, SuiteSchema } from "@eval/schema";
import { initDataset } from "braintrust";
import { z } from "zod";

export async function syncSuite(suite: z.infer<typeof SuiteSchema>) {
	const rows = z
		.array(CaseSchema)
		.min(1)
		.parse(JSON.parse(readFileSync(`eval/${suite}/cases.json`, "utf8")));
	if (rows.some((row) => row.input.suite !== suite))
		throw new Error("eval: mixed suite cases");
	if (new Set(rows.map((row) => row.id)).size !== rows.length)
		throw new Error("eval: duplicate case ids");
	const dataset = initDataset({
		project: "algo-backend",
		dataset: `${suite}-discovery`,
	});
	for (const row of rows)
		dataset.insert({
			...row,
			metadata: {
				suite,
				slug: row.input.slug,
				referencePolicy: "dated independent lower bound",
			},
		});
	await dataset.flush();
	console.log(
		JSON.stringify({
			suite,
			datasetId: await dataset.id,
			version: await dataset.version(),
			cases: rows.length,
		}),
	);
}

if (import.meta.main) {
	const suites = process.argv[2]
		? [SuiteSchema.parse(process.argv[2])]
		: SuiteSchema.options;
	for (const suite of suites) await syncSuite(suite);
}
