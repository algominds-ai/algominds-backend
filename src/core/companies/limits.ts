import type { CompanyEntity } from "@/core/providers/exa/search";
import type { SearchPlan } from "@/core/synthesize";

export type NumericLimit = {
	label: string;
	reading: (entity: CompanyEntity) => number | null;
	floor: (plan: SearchPlan) => number | null;
	ceiling: (plan: SearchPlan) => number | null;
};

const WORKFORCE_LIMIT: NumericLimit = {
	label: "headcount",
	reading: (entity) => entity.workforceTotal,
	floor: (plan) => plan.minWorkforce,
	ceiling: (plan) => plan.maxWorkforce,
};

const FOUNDED_YEAR_LIMIT: NumericLimit = {
	label: "founding year",
	reading: (entity) => entity.foundedYear,
	floor: (plan) => plan.minFoundedYear,
	ceiling: (plan) => plan.maxFoundedYear,
};

const ANNUAL_REVENUE_LIMIT: NumericLimit = {
	label: "annual revenue",
	reading: (entity) => entity.revenueAnnual,
	floor: (plan) => plan.minRevenueAnnual,
	ceiling: (plan) => plan.maxRevenueAnnual,
};

const FUNDING_RAISED_LIMIT: NumericLimit = {
	label: "funding raised",
	reading: (entity) => entity.fundingTotal,
	floor: (plan) => plan.minFundingTotal,
	ceiling: (plan) => plan.maxFundingTotal,
};

/** Every figure Exa reports for a company that a profile can bound. */
export const NUMERIC_LIMITS: readonly NumericLimit[] = [
	WORKFORCE_LIMIT,
	FOUNDED_YEAR_LIMIT,
	ANNUAL_REVENUE_LIMIT,
	FUNDING_RAISED_LIMIT,
];

function limitClause(limit: NumericLimit, plan: SearchPlan): string | null {
	const floor = limit.floor(plan);
	const ceiling = limit.ceiling(plan);
	if (floor !== null && ceiling !== null) {
		return `${limit.label} between ${floor} and ${ceiling}`;
	}
	if (ceiling !== null) return `${limit.label} of at most ${ceiling}`;
	if (floor !== null) return `${limit.label} of at least ${floor}`;
	return null;
}

function limitRule(limit: NumericLimit, plan: SearchPlan): string | null {
	const clause = limitClause(limit, plan);
	return clause === null ? null : `Every company must have a ${clause}.`;
}

/** The plan's bounds and countries as sentences, appended to a query so the vendor's search and any agent both see them stated. */
export function planConstraints(plan: SearchPlan): string {
	const rules = NUMERIC_LIMITS.map((limit) => limitRule(limit, plan)).filter(
		(rule): rule is string => rule !== null,
	);
	if (plan.countries.length > 0) {
		rules.push(
			`Every company must be based in ${plan.countries.join(" or ")}.`,
		);
	}
	return rules.join(" ");
}

export type RejectDetail = { reason: string; group?: string };

function readLimit(
	limit: NumericLimit,
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	const reading = limit.reading(entity);
	if (reading === null) return null;
	const ceiling = limit.ceiling(plan);
	if (ceiling !== null && reading > ceiling) {
		const group = `${limit.label} above the limit of ${ceiling}`;
		return {
			reason: `${limit.label} ${reading} above the limit of ${ceiling}`,
			group,
		};
	}
	const floor = limit.floor(plan);
	if (floor !== null && reading < floor) {
		const group = `${limit.label} below the floor of ${floor}`;
		return {
			reason: `${limit.label} ${reading} below the floor of ${floor}`,
			group,
		};
	}
	return null;
}

/** All populated provider bounds are conjunctive; alternatives stay in the ICP for the judge. */
function numericRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	for (const limit of NUMERIC_LIMITS) {
		const detail = readLimit(limit, entity, plan);
		if (detail) return detail;
	}
	return null;
}

function countryRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): string | null {
	const { country } = entity;
	if (plan.countries.length === 0 || country === null) return null;
	const allowed = plan.countries.some(
		(name) => name.toLowerCase() === country.toLowerCase(),
	);
	return allowed ? null : `headquarters in ${country}`;
}

/** Why one company's record fails the plan's country or numeric bounds, or null when it satisfies both. */
export function entityRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	const countryReason = countryRejectReason(entity, plan);
	if (countryReason !== null) return { reason: countryReason };
	return numericRejectReason(entity, plan);
}
