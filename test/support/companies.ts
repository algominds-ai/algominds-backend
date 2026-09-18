import type { CompanyCapture } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type { EvidenceByRow } from "@/core/companies/judge-evidence";

/** Provider profile captures for round tests that stub retrieval, keeping identity resolution real. */
export function companyIdentityEvidence(
	rows: readonly CompanyRow[],
): EvidenceByRow {
	return new Map(
		rows.map((row, index) => {
			const url =
				row.linkedinUrl ?? `https://linkedin.com/company/${row.domain}`;
			return [
				index,
				new Map([
					[
						url,
						{
							url,
							quote: "",
							text: `# ${row.name}\n- Homepage: ${row.domain}\n- LinkedIn: ${url}`,
						},
					],
				]),
			];
		}),
	);
}

/** Minimal captured Acme record shared by identity association tests. */
export function companyCapture(): CompanyCapture {
	return {
		entity: {
			name: "Acme",
			description: null,
			industry: null,
			foundedYear: null,
			workforceTotal: null,
			city: null,
			country: null,
			revenueAnnual: null,
			fundingTotal: null,
		},
		result: {
			id: "https://exa.ai/library/organization/acme",
			url: "https://acme.test",
			title: "Acme",
			qualification: null,
		},
		evidence: [
			"https://www.linkedin.com/company/acme-sister",
			"https://www.linkedin.com/company/vendor",
		].map((sourceUrl) => ({
			conditionId: "r1.a1.c1",
			sourceUrl,
			quote: "",
			eventDate: null,
			publishedDate: null,
		})),
		raw: "{}",
		source: "exa-search",
	};
}
