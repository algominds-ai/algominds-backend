import type { FindCompaniesReject } from "@/core/companies/candidates";
import type { CompanyRow } from "@/core/companies/gate";
import type {
	EvidenceByRow,
	RequirementEvidence,
} from "@/core/companies/judge-evidence";
import { normalizeDomain } from "@/core/db/schema";

/** Reject an explicit homepage mismatch in Exa's LinkedIn company record. */
export function companyHomepageMatches(
	text: string,
	domain: string | null,
): boolean {
	const homepages = [...text.matchAll(/^- Homepage:([^\r\n]*)\r?$/gm)];
	if (homepages.length === 0) return true;
	if (domain === null) return false;
	try {
		const expected = normalizeDomain(domain);
		return homepages.every(
			([, value]) =>
				Boolean(value?.trim()) &&
				normalizeDomain(value?.trim() ?? "") === expected,
		);
	} catch {
		return false;
	}
}

/** Prefer the profile's declared company URL; never turn a showcase into a company page. */
export function companyLinkedInFromPage(
	url: string,
	text: string,
): string | null {
	const canonical = verifiedLinkedInCompanyUrl(url);
	if (!canonical) return null;
	const sections = text.split(/^## Company Details[\t ]*\r?$/im);
	if (sections.length > 2) return null;
	const details = sections[1]?.split(/^#{1,2} /m)[0] ?? text;
	const declarations = [...details.matchAll(/^- LinkedIn:([^\r\n]*)\r?$/gim)];
	if (declarations.length === 0) return canonical;
	const urls = new Set(
		declarations.map(([, value]) => {
			const declared = (value?.trim() ?? "").replace(
				/^(?=(?:[a-z]{2,3}\.)?linkedin\.com\/)/i,
				"https://",
			);
			return verifiedLinkedInCompanyUrl(declared);
		}),
	);
	return urls.size === 1 ? ([...urls][0] ?? null) : null;
}

/** Resolve identity from provider records before evaluating ICP fit. */
function providerLinkedIn(
	row: CompanyRow,
	evidence: ReadonlyMap<string, RequirementEvidence> | undefined,
): string | null {
	const pages = [...(evidence?.values() ?? [])].filter(
		(page) =>
			page.identityAllowed !== false &&
			page.text?.trim() &&
			companyLinkedInFromPage(page.url, page.text) &&
			companyHomepageMatches(page.text, row.domain),
	);
	const native = new Set(
		pages
			.filter((page) => page.identityAllowed === true)
			.map((page) => companyLinkedInFromPage(page.url, page.text ?? "")),
	);
	if (native.size > 0)
		return native.size === 1 ? ([...native][0] ?? null) : null;
	const provided = verifiedLinkedInCompanyUrl(row.linkedinUrl);
	const supplied = provided
		? pages.find((page) => verifiedLinkedInCompanyUrl(page.url) === provided)
		: undefined;
	if (supplied)
		return companyLinkedInFromPage(supplied.url, supplied.text ?? "");
	const fallback = new Set(
		pages
			.filter((page) => /^- Homepage:/m.test(page.text ?? ""))
			.map((page) => companyLinkedInFromPage(page.url, page.text ?? "")),
	);
	return fallback.size === 1 ? ([...fallback][0] ?? null) : null;
}

/** Copy resolved rows and reindex their evidence; unresolved identities never reach the fit judge. */
export function identifyCompanyRows(
	rows: readonly CompanyRow[],
	evidenceByRow: EvidenceByRow,
): {
	rows: CompanyRow[];
	evidenceByRow: EvidenceByRow;
	rejects: FindCompaniesReject[];
} {
	const identified: CompanyRow[] = [];
	const evidence = new Map<number, ReadonlyMap<string, RequirementEvidence>>();
	const rejects: FindCompaniesReject[] = [];
	rows.forEach((row, index) => {
		const pages = evidenceByRow.get(index);
		const linkedinUrl = providerLinkedIn(row, pages);
		if (!linkedinUrl) {
			rejects.push({
				domain: row.domain,
				reason:
					"company website and LinkedIn identity were not verified by the provider",
				stage: "gate",
			});
			return;
		}
		if (pages) evidence.set(identified.length, pages);
		identified.push({ ...row, linkedinUrl });
	});
	return { rows: identified, evidenceByRow: evidence, rejects };
}

/** Return an absolute company LinkedIn URL, or null when the value is not one. */
export function verifiedLinkedInCompanyUrl(
	value: string | null,
): string | null {
	if (value === null) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return null;
		if (!/^(?:[a-z]{2,3}\.)?linkedin\.com$/i.test(url.hostname)) return null;
		if (!/^\/company\/[^\s/?#]+\/?$/i.test(url.pathname)) return null;
		const slug = url.pathname.slice("/company/".length).replace(/\/$/, "");
		return `https://www.linkedin.com/company/${slug}`;
	} catch {
		return null;
	}
}
