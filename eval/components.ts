import { failedOutput, type Input, InputSchema } from "@eval/schema";
import { z } from "zod";
import { judge } from "@/core/companies/judge";
import { CostLedger } from "@/core/cost";
import { writeSellerProfile } from "@/core/onboard";
import { resolveBuyer } from "@/core/people/buyer";
import { CandidateSchema } from "@/core/people/candidate";
import { prefilterBuyers } from "@/core/people/filter";
import { peopleSearchRequest, searchSubject } from "@/core/people/research";
import { PeopleCompanySchema } from "@/core/people/roster";
import { CompanyRecordSchema, search } from "@/core/providers/exa/search";
import { synthesize } from "@/core/synthesize";

const PageSchema = z.object({ url: z.url(), text: z.string() });
const JudgeSampleSchema = z.object({
	today: z.iso.date(),
	rows: z
		.array(
			z.object({
				name: z.string().nullable(),
				domain: z.string().nullable(),
				linkedinUrl: z.string().nullable(),
				description: z.string().nullable(),
				record: CompanyRecordSchema.nullable(),
				pages: z.array(PageSchema),
			}),
		)
		.min(1),
});
const PrefilterSampleSchema = z.object({
	company: PeopleCompanySchema,
	candidates: z.array(CandidateSchema).min(1),
	researchAll: z.boolean(),
	bands: z.array(z.string()),
});

async function companyComponent(input: Input, env: Env) {
	if (input.suite !== "company") throw new Error("Invalid company component");
	if (input.stage === "synthesis") {
		const sample = z
			.object({
				today: z.iso.date(),
				pastAngles: z.array(z.string()),
				feedback: z.array(z.string()),
			})
			.parse(input.sample);
		const result = await synthesize(
			{
				...sample,
				icp: input.profile,
				requirements: input.profile.icp.requirements,
				angles: 3,
				provenRate: null,
			},
			env,
		);
		return {
			value: { route: result.route, plans: result.plans },
			ledger: result.ledger,
		};
	}
	const sample = JudgeSampleSchema.parse(input.sample);
	const evidenceByRow = new Map(
		sample.rows.map((row, index) => [
			index,
			new Map(
				row.pages.map((page, i) => [
					`page-${i}`,
					{ ...page, quote: "", identityAllowed: true },
				]),
			),
		]),
	);
	const result = await judge(input.profile.icp.requirements, sample.rows, env, {
		today: sample.today,
		profile: input.profile,
		evidenceByRow,
	});
	return { value: result.verdicts, ledger: result.ledger };
}

async function peopleComponent(input: Input, env: Env) {
	if (input.suite !== "people") throw new Error("Invalid people component");
	const ledger = new CostLedger();
	if (input.stage === "prefilter") {
		const sample = PrefilterSampleSchema.parse(input.sample);
		const value = await prefilterBuyers(
			{
				...sample,
				buyer: resolveBuyer({ target: null, profile: input.profile }),
			},
			env,
			ledger,
		);
		return { value, ledger };
	}
	const candidate = CandidateSchema.parse(input.sample);
	const reply = await search(peopleSearchRequest(candidate), env, ledger);
	return {
		value: { decision: searchSubject(candidate, reply), reply },
		ledger,
	};
}

export function validateComponent(input: Input) {
	const stages = {
		onboarding: ["extraction"],
		company: ["synthesis", "judging"],
		people: ["prefilter", "verification"],
	};
	if (!stages[input.suite].includes(input.stage))
		throw new Error(`eval: ${input.stage} is not a ${input.suite} component`);
}

export async function runComponent(raw: unknown, env: Env) {
	const input = InputSchema.parse(raw);
	validateComponent(input);
	const started = Date.now();
	let result: { value: unknown; ledger: CostLedger };
	if (input.suite === "onboarding") {
		const pages = z.array(PageSchema).min(1).parse(input.sample);
		const written = await writeSellerProfile(
			env,
			input.domain,
			pages,
			input.note,
		);
		result = { value: written.profile, ledger: written.ledger };
	} else
		result =
			input.suite === "company"
				? await companyComponent(input, env)
				: await peopleComponent(input, env);
	return {
		...failedOutput(""),
		status: "complete",
		error: null,
		component: z.json().parse(result.value),
		seconds: (Date.now() - started) / 1000,
		costDollars: result.ledger.total(),
	};
}
