import { describe, expect, it } from "vitest";
import {
	companyHomepageMatches,
	companyLinkedInFromPage,
	identifyCompanyRows,
	verifiedLinkedInCompanyUrl,
} from "@/core/companies/identity";
import declaredLinkedIn from "../fixtures/exa-declared-linkedin-identity.json";

describe("provider homepage and canonical company URL", () => {
	it.each([
		["linkedin.com/company/acme", "https://www.linkedin.com/company/acme"],
		[
			"HTTPS://UK.LINKEDIN.COM/company/acme",
			"https://www.linkedin.com/company/acme",
		],
		["//linkedin.com/company/acme", null],
		["someone@linkedin.com/company/acme", null],
		["https://someone@linkedin.com/company/acme", null],
		["", null],
		["linkedin.com/company/acme\n- LinkedIn: linkedin.com/company/other", null],
		[
			"linkedin.com/company/acme\n## Company Details\n- LinkedIn: linkedin.com/company/acme\n## Company Details\n- LinkedIn: linkedin.com/company/other",
			null,
		],
	])("validates declared company URL %s", (declared, expected) => {
		expect(
			companyLinkedInFromPage(
				"https://linkedin.com/company/old",
				`- LinkedIn: ${declared}`,
			),
		).toBe(expected);
	});

	it.each([
		{ text: "- Homepage: https://", expected: false },
		{ text: "- Homepage: [invalid]", expected: false },
		{ text: "- Homepage: other.test\r\n", expected: false },
		{ text: "- Homepage: acme.test\r\n", expected: true },
		{ text: "- Homepage: acme.test\n- Homepage: other.test", expected: false },
		{ text: "No structured homepage", expected: true },
	])("handles explicit homepage $text", ({ text, expected }) => {
		expect(companyHomepageMatches(text, "acme.test")).toBe(expected);
	});

	it("canonicalizes locale, host, query and trailing slash variants", () => {
		expect(
			verifiedLinkedInCompanyUrl(
				"https://uk.linkedin.com/company/acme/?utm_source=exa#about",
			),
		).toBe("https://www.linkedin.com/company/acme");
	});
});

const legacyUrl = "https://www.linkedin.com/company/acme-legacy";
const canonicalUrl = "https://www.linkedin.com/company/acme";

describe("declared company identity", () => {
	it("ignores personal LinkedIn links outside the provider's Company Details", () => {
		const saved = declaredLinkedIn.find(
			({ row }) => row.domain === "i-techsupport.com",
		);
		if (!saved) throw new Error("missing i-Tech profile fixture");
		const text = `${saved.page.text.replace(
			"## About",
			"## About\n\n- LinkedIn: linkedin.com/in/contact-person",
		)}\n\n## Contacts\n- LinkedIn: linkedin.com/in/another-person`;
		const identified = identifyCompanyRows(
			[saved.row],
			new Map([
				[
					0,
					new Map([
						[
							saved.page.url,
							{ ...saved.page, text, quote: "", identityAllowed: true },
						],
					]),
				],
			]),
		);
		expect(identified.rows[0]?.linkedinUrl).toBe(saved.expectedLinkedinUrl);
		expect(identified.rejects).toEqual([]);
	});

	it("honors a supplied profile's declared alias without requiring a new homepage field", () => {
		const row = {
			name: "Acme",
			domain: "acme.test",
			linkedinUrl: legacyUrl,
			description: null,
			record: null,
		};
		const page = {
			url: legacyUrl,
			text: `- LinkedIn: ${canonicalUrl}`,
			quote: "",
		};
		const identified = identifyCompanyRows(
			[row],
			new Map([[0, new Map([[legacyUrl, page]])]]),
		);
		expect(identified.rows[0]?.linkedinUrl).toBe(canonicalUrl);
		expect(identified.rejects).toEqual([]);
	});

	it.each(
		declaredLinkedIn,
	)("honors the declared LinkedIn route for $row.name", ({
		row,
		page,
		expectedLinkedinUrl,
	}) => {
		const identified = identifyCompanyRows(
			[row],
			new Map([
				[
					0,
					new Map([[page.url, { ...page, quote: "", identityAllowed: true }]]),
				],
			]),
		);
		expect(identified.rows[0]?.linkedinUrl ?? null).toBe(expectedLinkedinUrl);
		expect(identified.rejects).toHaveLength(expectedLinkedinUrl ? 0 : 1);
	});
});
