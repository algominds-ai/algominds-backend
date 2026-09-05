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

/** The revenue-or-funding sentence when the plan bounds both, so a company only needs to satisfy one side. Null when the plan bounds at most one of them. */
function moneyBandRule(plan: SearchPlan): string | null {
	const revenue = limitClause(ANNUAL_REVENUE_LIMIT, plan);
	const funding = limitClause(FUNDING_RAISED_LIMIT, plan);
	if (revenue === null || funding === null) return null;
	return `Every company must have a ${revenue} or ${funding}.`;
}

/** The plan's bounds and countries as sentences, appended to a query so the vendor's search and any agent both see them stated. */
export function planConstraints(plan: SearchPlan): string {
	const moneyBand = moneyBandRule(plan);
	const limits =
		moneyBand === null ? NUMERIC_LIMITS : [WORKFORCE_LIMIT, FOUNDED_YEAR_LIMIT];
	const rules = limits
		.map((limit) => limitRule(limit, plan))
		.filter((rule): rule is string => rule !== null);
	if (moneyBand !== null) rules.push(moneyBand);
	if (plan.countries.length > 0) {
		rules.push(
			`Every company must be based in ${plan.countries.join(" or ")}.`,
		);
	}
	return rules.join(" ");
}

export type RejectDetail = { reason: string; group?: string };

const STATED_HEADCOUNT = [
	/(\d{1,3}(?:,\d{3})+|\d+)\s*\+?\s*(?:[a-z-]+\s+)?(?:employees|team members|staff|colleagues|professionals|workers|technicians)\b/i,
	/\bemploys\s+(?:over|more than|about|nearly|around|some)?\s*(\d{1,3}(?:,\d{3})+|\d+)\b/i,
];

/** The headcount a company's own description states, or null when it states none. */
export function statedHeadcount(entity: CompanyEntity): number | null {
	if (entity.description === null) return null;
	for (const pattern of STATED_HEADCOUNT) {
		const match = entity.description.match(pattern);
		if (match?.[1]) return Number(match[1].replace(/,/g, ""));
	}
	return null;
}

const STATED_HEADCOUNT_LIMIT: NumericLimit = {
	label: "headcount stated in the description",
	reading: statedHeadcount,
	floor: (plan) => plan.minWorkforce,
	ceiling: (plan) => plan.maxWorkforce,
};

type LimitReading = { present: boolean; detail: RejectDetail | null };

function readLimit(
	limit: NumericLimit,
	entity: CompanyEntity,
	plan: SearchPlan,
): LimitReading {
	const reading = limit.reading(entity);
	if (reading === null) return { present: false, detail: null };
	const ceiling = limit.ceiling(plan);
	if (ceiling !== null && reading > ceiling) {
		const group = `${limit.label} above the limit of ${ceiling}`;
		return {
			present: true,
			detail: {
				reason: `${limit.label} ${reading} above the limit of ${ceiling}`,
				group,
			},
		};
	}
	const floor = limit.floor(plan);
	if (floor !== null && reading < floor) {
		const group = `${limit.label} below the floor of ${floor}`;
		return {
			present: true,
			detail: {
				reason: `${limit.label} ${reading} below the floor of ${floor}`,
				group,
			},
		};
	}
	return { present: true, detail: null };
}

function boundedOnPlan(limit: NumericLimit, plan: SearchPlan): boolean {
	return limit.floor(plan) !== null || limit.ceiling(plan) !== null;
}

/** Rejects on revenue and funding together only when every reading present for a bounded side of the pair fails its bound. A side the plan does not bound is ignored, exactly like an absent reading. */
function financialBandRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	const readings = [ANNUAL_REVENUE_LIMIT, FUNDING_RAISED_LIMIT]
		.filter((limit) => boundedOnPlan(limit, plan))
		.map((limit) => readLimit(limit, entity, plan))
		.filter((reading) => reading.present);
	if (readings.length === 0) return null;
	if (readings.some((reading) => reading.detail === null)) return null;
	return readings[0]?.detail ?? null;
}

function numericRejectReason(
	entity: CompanyEntity,
	plan: SearchPlan,
): RejectDetail | null {
	const workforce = readLimit(WORKFORCE_LIMIT, entity, plan);
	if (workforce.detail !== null) return workforce.detail;
	const foundedYear = readLimit(FOUNDED_YEAR_LIMIT, entity, plan);
	if (foundedYear.detail !== null) return foundedYear.detail;
	const financial = financialBandRejectReason(entity, plan);
	if (financial !== null) return financial;
	return readLimit(STATED_HEADCOUNT_LIMIT, entity, plan).detail;
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
