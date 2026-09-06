import { type IcpDoc, IcpDocSchema } from "@eval/icp-doc";

export type WrittenOnboardProfile = IcpDoc;
export type OnboardCheck = { name: string; passed: boolean };

/** Structural checks only; regexes cannot judge ICP meaning. */
export function scoreOnboardProfile(
	written: WrittenOnboardProfile,
	fixture?: IcpDoc,
): OnboardCheck[] {
	const parsed = IcpDocSchema.safeParse(written);
	const sourceUrls = written.seller.sourceUrls;
	return [
		{
			name: "profile matches canonical onboarding schema",
			passed: parsed.success,
		},
		{
			name: "seller source URLs are unique",
			passed: new Set(sourceUrls).size === sourceUrls.length,
		},
		{
			name: "seller domain is preserved",
			passed:
				fixture === undefined ||
				written.seller.domain === fixture.seller.domain,
		},
		{
			name: "targeting instructions are preserved",
			passed:
				fixture === undefined || written.instructions === fixture.instructions,
		},
	];
}

export function formatCheckLine(check: OnboardCheck): string {
	return `${check.passed ? "PASS" : "FAIL"}  ${check.name}`;
}

export function summaryLine(checks: readonly OnboardCheck[]): string {
	const passed = checks.filter((check) => check.passed).length;
	return `${passed} of ${checks.length}`;
}
