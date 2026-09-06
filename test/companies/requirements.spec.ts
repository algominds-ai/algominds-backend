import { describe, expect, it } from "vitest";
import { conditionRefs, requiredSatisfied } from "@/core/requirements";

const condition = (text: string) => ({
	text,
	window: null,
	sourceRule: null,
});

describe("grouped company requirements", () => {
	it("requires every condition within one alternative without mixing alternatives", () => {
		const requirements = [
			{
				kind: "required" as const,
				anyOf: [
					{ allOf: [condition("hire"), condition("expansion")] },
					{ allOf: [condition("replacement")] },
				],
			},
		];
		expect(
			requiredSatisfied(
				requirements,
				new Map([
					["r1.a1.c1", "proven"],
					["r1.a1.c2", "unproven"],
				]),
			),
		).toBe(false);
		expect(
			requiredSatisfied(
				requirements,
				new Map([
					["r1.a1.c1", "proven"],
					["r1.a1.c2", "proven"],
				]),
			),
		).toBe(true);
		expect(
			requiredSatisfied(
				requirements,
				new Map([
					["r1.a1.c1", "contradicted"],
					["r1.a2.c1", "proven"],
				]),
			),
		).toBe(true);
	});
	it("ANDs required groups and ORs each group's alternatives", () => {
		const requirements = [
			{
				kind: "required" as const,
				anyOf: [
					{ allOf: [condition("bank")] },
					{ allOf: [condition("payments")] },
				],
			},
			{
				kind: "required" as const,
				anyOf: [{ allOf: [condition("UK")] }],
			},
		];
		const refs = conditionRefs(requirements);

		expect(
			requiredSatisfied(
				requirements,
				new Map([
					[refs[1]?.id ?? "", "proven"],
					[refs[2]?.id ?? "", "proven"],
				]),
			),
		).toBe(true);
		expect(
			requiredSatisfied(requirements, new Map([[refs[0]?.id ?? "", "proven"]])),
		).toBe(false);
	});

	it("does not let a preferred condition block a required match", () => {
		const requirements = [
			{
				kind: "required" as const,
				anyOf: [{ allOf: [condition("bank")] }],
			},
			{
				kind: "preferred" as const,
				anyOf: [{ allOf: [condition("recent hiring")] }],
			},
		];
		const refs = conditionRefs(requirements);

		expect(
			requiredSatisfied(requirements, new Map([[refs[0]?.id ?? "", "proven"]])),
		).toBe(true);
	});
});
