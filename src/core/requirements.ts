import type { Condition, Requirement } from "@/core/icp";

export { ConditionSchema, RequirementSchema } from "@/core/icp";
export type { Condition, Requirement };

export type ConditionStatus = "proven" | "contradicted" | "unproven";
export type ConditionRef = {
	id: string;
	groupIndex: number;
	alternativeIndex: number;
	conditionIndex: number;
	kind: Requirement["kind"];
	condition: Condition;
};

const MS_PER_DAY = 86_400_000;

function calendarDate(value: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const date = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	if (date.toISOString().slice(0, 10) !== value) {
		return null;
	}
	return date;
}

function addCalendarMonths(today: Date, months: number): Date {
	const day = today.getUTCDate();
	const result = new Date(today.getTime());
	result.setUTCDate(1);
	result.setUTCMonth(result.getUTCMonth() + months);
	const lastDay = new Date(
		Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
	).getUTCDate();
	result.setUTCDate(Math.min(day, lastDay));
	return result;
}

/** Computes an inclusive calendar boundary for a condition's date window. */
export function windowBoundary(
	window: Condition["window"],
	today: string,
): string | null {
	if (window === null) return null;
	const parsedToday = calendarDate(today);
	if (
		parsedToday === null ||
		!Number.isInteger(window.amount) ||
		window.amount <= 0
	)
		return null;
	const direction = window.direction === "past" ? -1 : 1;
	let boundary: Date;
	if (window.unit === "days") {
		boundary = new Date(
			parsedToday.getTime() + direction * window.amount * MS_PER_DAY,
		);
	} else {
		const months =
			window.unit === "months" ? window.amount : window.amount * 12;
		boundary = addCalendarMonths(parsedToday, direction * months);
	}
	return boundary.toISOString().slice(0, 10);
}

/** Checks only date arithmetic; assigning a date to an event remains a retrieval/judging responsibility. */
export function conditionDateAllowed(
	condition: Condition,
	date: string | null | undefined,
	today: string,
): boolean {
	if (condition.window === null) {
		return date === null || date === undefined || calendarDate(date) !== null;
	}
	if (date === null || date === undefined) return false;
	const parsedDate = calendarDate(date);
	const parsedToday = calendarDate(today);
	const boundary = windowBoundary(condition.window, today);
	if (parsedDate === null || parsedToday === null || boundary === null)
		return false;
	const parsedBoundary = calendarDate(boundary);
	if (parsedBoundary === null) return false;
	return condition.window.direction === "past"
		? parsedDate >= parsedBoundary && parsedDate <= parsedToday
		: parsedDate >= parsedToday && parsedDate <= parsedBoundary;
}

function conditionId(
	group: number,
	alternative: number,
	condition: number,
): string {
	return `r${group + 1}.a${alternative + 1}.c${condition + 1}`;
}

/** Gives each condition an identity within the frozen profile without changing its meaning. */
export function conditionRefs(
	requirements: readonly Requirement[],
): ConditionRef[] {
	return requirements.flatMap((requirement, groupIndex) =>
		requirement.anyOf.flatMap((alternative, alternativeIndex) =>
			alternative.allOf.map((condition, conditionIndex) => ({
				id: conditionId(groupIndex, alternativeIndex, conditionIndex),
				groupIndex,
				alternativeIndex,
				conditionIndex,
				kind: requirement.kind,
				condition,
			})),
		),
	);
}

export function requiredConditionRefs(
	requirements: readonly Requirement[],
): ConditionRef[] {
	return conditionRefs(requirements).filter((ref) => ref.kind === "required");
}

/** Date/source demands inform retrieval; missing evidence for any required condition remains unproven. */
export function evidenceDemandConditions(
	requirements: readonly Requirement[],
): ConditionRef[] {
	return requiredConditionRefs(requirements).filter(
		(ref) => ref.condition.window !== null || ref.condition.sourceRule !== null,
	);
}

/** Required groups are ANDed, alternatives ORed, conditions ANDed. Unknown never proves a condition. */
export function requiredGroupSatisfied(
	requirement: Requirement,
	groupIndex: number,
	statuses: ReadonlyMap<string, ConditionStatus>,
): boolean {
	return (
		requirement.kind === "preferred" ||
		requirement.anyOf.some((alternative, alternativeIndex) =>
			alternative.allOf.every(
				(_condition, conditionIndex) =>
					statuses.get(
						conditionId(groupIndex, alternativeIndex, conditionIndex),
					) === "proven",
			),
		)
	);
}

export function requiredSatisfied(
	requirements: readonly Requirement[],
	statuses: ReadonlyMap<string, ConditionStatus>,
): boolean {
	return requirements.every((requirement, group) =>
		requiredGroupSatisfied(requirement, group, statuses),
	);
}

export function requirementLine(ref: ConditionRef): string {
	const { condition } = ref;
	const window = condition.window
		? ` (${condition.window.amount} ${condition.window.unit}, ${condition.window.direction} ${condition.window.appliesTo})`
		: "";
	const source = condition.sourceRule
		? ` [source: ${condition.sourceRule}]`
		: "";
	return `${ref.id} ${condition.text}${window}${source}`;
}
