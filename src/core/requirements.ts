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
export function requiredSatisfied(
	requirements: readonly Requirement[],
	statuses: ReadonlyMap<string, ConditionStatus>,
): boolean {
	return requirements.every(
		(requirement, group) =>
			requirement.kind === "preferred" ||
			requirement.anyOf.some((alternative, a) =>
				alternative.allOf.every(
					(_condition, c) =>
						statuses.get(conditionId(group, a, c)) === "proven",
				),
			),
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
