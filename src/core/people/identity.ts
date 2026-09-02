import type { CostLedger } from "@/core/cost";
import { claySearch } from "@/core/providers/clay";

export type IdentityInput = {
	domain: string;
	linkedinUrl: string | null;
};

export type IdentityResult =
	| { how: "domain"; identifier: string; name: string | null; raw: string[] }
	| { how: "linkedin"; identifier: string; name: string | null; raw: string[] }
	| { how: "unresolved"; raw: string[] };

/**
 * Resolves a company's Clay identity: the `c-suite` band by domain, then by a
 * stored LinkedIn company URL only after a clean empty. Returns `unresolved`
 * when both miss or no LinkedIn URL is stored.
 */
export async function resolveIdentity(
	input: IdentityInput,
	env: Env,
	ledger: CostLedger,
): Promise<IdentityResult> {
	const byDomain = await claySearch(
		env,
		{ identifier: input.domain, bands: ["c-suite"] },
		ledger,
	);
	if (byDomain.rows.length > 0) {
		return {
			how: "domain",
			identifier: input.domain,
			name: byDomain.rows[0]?.company ?? null,
			raw: byDomain.raw,
		};
	}
	if (!input.linkedinUrl) {
		return { how: "unresolved", raw: byDomain.raw };
	}
	const byLinkedin = await claySearch(
		env,
		{ identifier: input.linkedinUrl, bands: ["c-suite"] },
		ledger,
	);
	const raw = [...byDomain.raw, ...byLinkedin.raw];
	if (byLinkedin.rows.length > 0) {
		return {
			how: "linkedin",
			identifier: input.linkedinUrl,
			name: byLinkedin.rows[0]?.company ?? null,
			raw,
		};
	}
	return { how: "unresolved", raw };
}
