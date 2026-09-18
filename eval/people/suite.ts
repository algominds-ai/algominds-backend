import type { Input, Output } from "@eval/schema";

export const RUBRIC =
	"For every delivered person, independently assess exact identity, current employer as of output.asOf, current title/remit, and buyer fit under input.profile. Distinguish a real budget/remit owner from a title keyword match. Reject former employees, ambiguous identities, wrong employers, and unsupported authority. Evidence must support the exact person and current role; engine verification decisions and scores are not proof. Missing currentness evidence is insufficient. Respect recorded reference limitations and dates. A public reference list is a lower bound, never a complete roster; do not invent recall or penalize legitimate unlisted buyers.";

export function checks(input: Input, output: Output) {
	if (input.suite !== "people") throw new Error("Expected people input");
	const covered = new Set(output.entities.map((person) => person.company));
	return [
		{
			name: "requested_companies_only",
			score: Number(
				output.entities.every(
					(person) =>
						person.company !== null && input.domains.includes(person.company),
				),
			),
		},
		{
			name: "company_coverage",
			score:
				input.domains.filter((domain) => covered.has(domain)).length /
				input.domains.length,
		},
	];
}
