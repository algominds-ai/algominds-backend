import {
	type ApiClient,
	request,
	startCompaniesRun,
	startPeopleRun,
	waitForRunTerminal,
} from "@eval/api-client";
import { armDatabaseUrl, seedCase } from "@eval/arm-db";
import { ARM_SEED_PROFILES } from "@eval/arm-seed";
import { readOutput } from "@eval/results";
import {
	failedOutput,
	type Input,
	type Output,
	OutputSchema,
} from "@eval/schema";
import { currentSpan } from "braintrust";
import postgres from "postgres";
import { z } from "zod";

async function start(input: Input, client: ApiClient, icpId: string) {
	if (input.suite === "company")
		return startCompaniesRun(client, icpId, input.count);
	if (input.suite === "people")
		return startPeopleRun(client, icpId, input.domains);
	const started = await request(client, "POST", "/icp/onboard", {
		domain: input.domain,
		...(input.note ? { note: input.note } : {}),
	});
	return z.object({ runId: z.string() }).parse(started).runId;
}

function profileFor(input: Input) {
	if (input.suite !== "onboarding") return input.profile;
	const profile = ARM_SEED_PROFILES.find(
		(entry) => entry.slug === input.slug,
	)?.doc;
	if (!profile)
		throw new Error(`eval: unknown onboarding seller ${input.slug}`);
	return profile;
}

async function componentRequest(
	input: Input,
	context: { url: string; token: string; timeout: number },
) {
	try {
		const response = await fetch(`${context.url}/__eval/component`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${context.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(context.timeout * 1000),
		});
		if (!response.ok)
			throw new Error(
				`eval component failed ${response.status}: ${await response.text()}`,
			);
		return OutputSchema.parse(await response.json());
	} catch (error) {
		return failedOutput(error instanceof Error ? error.message : String(error));
	}
}

export async function runCase(
	input: Input,
	context: { arm: string; url: string; timeout: number; token: string },
): Promise<Output> {
	if (input.stage !== "engine") return componentRequest(input, context);
	const profile = profileFor(input);
	const databaseUrl = armDatabaseUrl(context.arm);
	const trial = await seedCase(databaseUrl, {
		slug: input.slug,
		icpId: "",
		organizationName: `eval-${input.slug}`,
		doc: profile,
	});
	const client = { baseUrl: context.url, apiKey: trial.apiKey };
	const sql = postgres(databaseUrl, { max: 1 });
	let runId: string | null = null;
	try {
		runId = await start(input, client, trial.icpId);
		currentSpan().log({ metadata: { runId } });
		await waitForRunTerminal(client, runId, context.timeout);
		return await readOutput(sql, runId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const partial = runId
			? await readOutput(sql, runId).catch(() => failedOutput(message))
			: failedOutput(message);
		return { ...partial, runId, error: message };
	} finally {
		await sql.end();
	}
}
