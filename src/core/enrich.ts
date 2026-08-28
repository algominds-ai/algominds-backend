import { NonRetryableError } from "cloudflare:workflows";
import type { SQL } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { config } from "@/config";
import { CostLedger } from "@/core/cost";
import type { DbEnv } from "@/core/db/client";
import { db } from "@/core/db/client";
import type {
	DbFactory,
	EvidenceAppendConnection,
	EvidenceReadConnection,
	RunLookupConnection,
	SelectWhereConnection,
} from "@/core/db/queries";
import {
	appendEvidence,
	cutoffDate,
	findRun,
	latestEvidence,
} from "@/core/db/queries";
import { companyScopeForRun } from "@/core/db/run-scope";
import type { Company, Evidence, NewEvidence, Person } from "@/core/db/schema";
import { company, person } from "@/core/db/schema";
import type {
	FindymailInput,
	FindymailResult,
} from "@/core/providers/findymail/index";
import { EMAIL } from "@/core/providers/index";
import type { Provider } from "@/core/providers/types";
import { waterfall } from "@/core/providers/waterfall";

const EMAIL_TTL_DAYS = config.enrich.emailTtlDays;
const LINKEDIN_TTL_DAYS = config.enrich.linkedinTtlDays;
const SUBJECT_TYPE = "person";

export type EnrichChannel = "email" | "linkedin";

export type EnrichSubject = {
	id: string;
	name?: string;
	domain?: string;
	linkedinUrl?: string;
};

export type EmailStatus = "verified" | "unknown";
export type LinkedinStatus = "found" | "unknown";

export type EmailOutcome = {
	status: EmailStatus;
	value: string | null;
	source: string | null;
};

export type LinkedinOutcome = {
	status: LinkedinStatus;
	value: string | null;
	source: string | null;
};

export type EnrichOutcome = {
	subjectId: string;
	email?: EmailOutcome;
	linkedin?: LinkedinOutcome;
};

export type EnrichResult = {
	outcomes: EnrichOutcome[];
	costDollars: number;
};

export type LinkedinInput = { name?: string; domain?: string };
export type LinkedinResult = { url: string };

export type EnrichDeps = {
	env: Env;
	now?: () => Date;
	emailProviders?: Provider<FindymailInput, FindymailResult>[];
	linkedinProviders?: Provider<LinkedinInput, LinkedinResult>[];
	readEvidence?: DbFactory<EvidenceReadConnection>;
	writeEvidence?: DbFactory<EvidenceAppendConnection>;
};

/** True only for an email verdict that can actually be sent to. */
export function isSendable(status: EmailStatus): boolean {
	return status === "verified";
}

export type PersonCompanyRow = { person: Person; company: Company };

export interface RunPeopleConnection {
	select(): {
		from(table: typeof person): {
			innerJoin(
				table: typeof company,
				condition: SQL | undefined,
			): {
				where(condition: SQL | undefined): Promise<PersonCompanyRow[]>;
			};
		};
	};
}

export type RunCompanyExistsConnection = SelectWhereConnection<
	typeof company,
	{ id: typeof company.id },
	{ id: string }
>;

export type SubjectsDeps = {
	findRun?: DbFactory<RunLookupConnection>;
	companyExists?: DbFactory<RunCompanyExistsConnection>;
	runPeople?: DbFactory<RunPeopleConnection>;
};

function toEnrichSubject(row: PersonCompanyRow): EnrichSubject {
	return {
		id: row.person.id,
		domain: row.company.domain,
		...(row.person.name !== null ? { name: row.person.name } : {}),
		...(row.person.linkedinUrl !== null
			? { linkedinUrl: row.person.linkedinUrl }
			: {}),
	};
}

async function companiesExistFor(
	env: DbEnv,
	condition: SQL | undefined,
	buildDb: DbFactory<RunCompanyExistsConnection> = db,
): Promise<boolean> {
	const connection = buildDb(env, "direct");
	const rows = await connection
		.select({ id: company.id })
		.from(company)
		.where(condition);
	return rows.length > 0;
}

async function runPeopleFor(
	env: DbEnv,
	condition: SQL | undefined,
	buildDb: DbFactory<RunPeopleConnection> = db,
): Promise<PersonCompanyRow[]> {
	const connection = buildDb(env, "direct");
	return connection
		.select()
		.from(person)
		.innerJoin(company, eq(person.companyId, company.id))
		.where(condition);
}

/**
 * Resolves run `runId` into enrich subjects, reading its company set by the
 * run's own capability: a companies run by its `run_id`, a people run by its
 * ICP, since a person carries no run id of its own. Throws
 * `NonRetryableError` when the run is unknown, its capability has no company
 * scope, or it matches no company at all.
 */
export async function subjectsForRun(
	env: DbEnv,
	runId: string,
	deps: SubjectsDeps = {},
): Promise<EnrichSubject[]> {
	const run = await findRun(env, runId, deps.findRun);
	if (!run) throw new NonRetryableError(`subjectsForRun: unknown run ${runId}`);
	const condition = companyScopeForRun(run);
	const hasCompanies = await companiesExistFor(
		env,
		condition,
		deps.companyExists,
	);
	if (!hasCompanies) {
		throw new NonRetryableError(`subjectsForRun: no company for run ${runId}`);
	}
	const rows = await runPeopleFor(env, condition, deps.runPeople);
	return rows.map(toEnrichSubject);
}

function withinTtl(row: Evidence, ttlDays: number, now: Date): boolean {
	return row.seenAt.getTime() >= cutoffDate(ttlDays, now).getTime();
}

function toEmailStatus(status: string | null): EmailStatus {
	return status === "verified" ? "verified" : "unknown";
}

function toLinkedinStatus(status: string | null): LinkedinStatus {
	return status === "found" ? "found" : "unknown";
}

function emailOutcomeFromEvidence(row: Evidence): EmailOutcome {
	return {
		status: toEmailStatus(row.status),
		value: row.value,
		source: row.source,
	};
}

function linkedinOutcomeFromEvidence(row: Evidence): LinkedinOutcome {
	return {
		status: toLinkedinStatus(row.status),
		value: row.value,
		source: row.source,
	};
}

function emailEvidenceRow(
	subject: EnrichSubject,
	result: FindymailResult,
): NewEvidence {
	return {
		subjectType: SUBJECT_TYPE,
		subjectId: subject.id,
		kind: "email",
		value: result.email,
		source: result.source ?? result.finder,
		status: result.status,
		confidence: result.status === "verified" ? 1 : 0,
	};
}

function linkedinEvidenceRow(
	subject: EnrichSubject,
	url: string,
	source: string,
): NewEvidence {
	return {
		subjectType: SUBJECT_TYPE,
		subjectId: subject.id,
		kind: "linkedin",
		value: url,
		source,
		status: "found",
		confidence: 1,
	};
}

function findymailInput(subject: EnrichSubject): FindymailInput {
	return {
		...(subject.linkedinUrl !== undefined
			? { linkedinUrl: subject.linkedinUrl }
			: {}),
		...(subject.name !== undefined ? { name: subject.name } : {}),
		...(subject.domain !== undefined ? { domain: subject.domain } : {}),
	};
}

async function runEmailWaterfall(
	subject: EnrichSubject,
	deps: EnrichDeps,
	ledger: CostLedger,
): Promise<EmailOutcome> {
	const providers = deps.emailProviders ?? EMAIL;
	const attempts: FindymailResult[] = [];
	const accept = (result: FindymailResult): boolean => {
		attempts.push(result);
		return result.status === "verified";
	};
	const hit = await waterfall(providers, findymailInput(subject), deps.env, {
		accept,
		ledger,
	});
	if (attempts.length > 0) {
		await appendEvidence(
			deps.env,
			attempts.map((result) => emailEvidenceRow(subject, result)),
			deps.writeEvidence,
		);
	}
	const found = hit?.output ?? attempts.at(-1);
	if (!found) return { status: "unknown", value: null, source: null };
	return {
		status: toEmailStatus(found.status),
		value: found.email,
		source: found.source ?? found.finder,
	};
}

async function resolveEmail(
	subject: EnrichSubject,
	deps: EnrichDeps,
	ledger: CostLedger,
): Promise<EmailOutcome> {
	const now = deps.now?.() ?? new Date();
	const cached = await latestEvidence(
		deps.env,
		subject.id,
		"email",
		deps.readEvidence,
	);
	if (cached && withinTtl(cached, EMAIL_TTL_DAYS, now)) {
		return emailOutcomeFromEvidence(cached);
	}
	return runEmailWaterfall(subject, deps, ledger);
}

async function recordLinkedinUrl(
	subject: EnrichSubject,
	url: string,
	source: string,
	deps: EnrichDeps,
): Promise<LinkedinOutcome> {
	await appendEvidence(
		deps.env,
		[linkedinEvidenceRow(subject, url, source)],
		deps.writeEvidence,
	);
	return { status: "found", value: url, source };
}

async function runLinkedinWaterfall(
	subject: EnrichSubject,
	deps: EnrichDeps,
	ledger: CostLedger,
): Promise<LinkedinOutcome> {
	const providers = deps.linkedinProviders ?? [];
	const input: LinkedinInput = {
		...(subject.name !== undefined ? { name: subject.name } : {}),
		...(subject.domain !== undefined ? { domain: subject.domain } : {}),
	};
	const hit = await waterfall(providers, input, deps.env, { ledger });
	if (!hit) return { status: "unknown", value: null, source: null };
	return recordLinkedinUrl(subject, hit.output.url, hit.source, deps);
}

async function resolveLinkedin(
	subject: EnrichSubject,
	deps: EnrichDeps,
	ledger: CostLedger,
): Promise<LinkedinOutcome> {
	const now = deps.now?.() ?? new Date();
	const cached = await latestEvidence(
		deps.env,
		subject.id,
		"linkedin",
		deps.readEvidence,
	);
	if (cached && withinTtl(cached, LINKEDIN_TTL_DAYS, now)) {
		return linkedinOutcomeFromEvidence(cached);
	}
	if (subject.linkedinUrl !== undefined) {
		return recordLinkedinUrl(subject, subject.linkedinUrl, "subject", deps);
	}
	return runLinkedinWaterfall(subject, deps, ledger);
}

async function enrichSubject(
	subject: EnrichSubject,
	channels: EnrichChannel[],
	deps: EnrichDeps,
	ledger: CostLedger,
): Promise<EnrichOutcome> {
	const outcome: EnrichOutcome = { subjectId: subject.id };
	if (channels.includes("email")) {
		outcome.email = await resolveEmail(subject, deps, ledger);
	}
	if (channels.includes("linkedin")) {
		outcome.linkedin = await resolveLinkedin(subject, deps, ledger);
	}
	return outcome;
}

/**
 * Resolves one status per requested channel for each subject, reading the
 * evidence cache first and falling back to that channel's waterfall. Every
 * vendor call the batch makes, hit or miss, lands on the returned ledger
 * total, since a waterfall provider still spends on a miss.
 */
export async function enrich(
	subjects: EnrichSubject[],
	channels: EnrichChannel[],
	deps: EnrichDeps,
): Promise<EnrichResult> {
	const ledger = new CostLedger();
	const outcomes = await Promise.all(
		subjects.map((subject) => enrichSubject(subject, channels, deps, ledger)),
	);
	return { outcomes, costDollars: ledger.total() };
}
