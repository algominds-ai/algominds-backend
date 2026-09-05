import { NonRetryableError } from "cloudflare:workflows";
import { config } from "@/config";
import type { RetrievedPage } from "@/core/companies/candidates";
import type { CostLedger } from "@/core/cost";
import type { ExaContentsResult } from "@/core/providers/exa/contents";
import { exaContents } from "@/core/providers/exa/contents";

const HOMEPAGE_MAX_CHARACTERS = config.companies.homepageMaxCharacters;

function homepageUrl(domain: string): string {
	return `https://${domain}/`;
}

function textByUrl(contents: ExaContentsResult): Map<string, string> {
	const failed = new Set(
		contents.statuses
			.filter((status) => status.status === "error")
			.map((status) => status.url),
	);
	const found = new Map<string, string>();
	for (const result of contents.results) {
		if (result.text !== null && result.text !== "" && !failed.has(result.url)) {
			found.set(result.url, result.text);
		}
	}
	return found;
}

/** The batch's contents, or null when the vendor answered with a shape this code does not read, since a homepage is optional evidence and never worth a failed round. */
async function contentsOrNothing(
	urls: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<ExaContentsResult | null> {
	try {
		return await exaContents([...urls], env, ledger, {
			maxCharacters: HOMEPAGE_MAX_CHARACTERS,
			livecrawl: "fallback",
		});
	} catch (error) {
		if (error instanceof NonRetryableError) return null;
		throw error;
	}
}

/**
 * Every candidate's own homepage, one Exa `/contents` call for the whole
 * batch with a cached page reused when fresh and a fresh crawl otherwise. A
 * domain whose homepage fails to crawl or crawls empty is simply absent from
 * the result, leaving that row's judgment on its record exactly as it was.
 */
export async function fetchHomepages(
	domains: readonly string[],
	env: Env,
	ledger: CostLedger,
): Promise<RetrievedPage[]> {
	if (domains.length === 0) return [];
	const contents = await contentsOrNothing(
		domains.map(homepageUrl),
		env,
		ledger,
	);
	if (contents === null) return [];
	const byUrl = textByUrl(contents);
	return domains.flatMap((domain) => {
		const url = homepageUrl(domain);
		const text = byUrl.get(url);
		return text === undefined ? [] : [{ domain, url, text }];
	});
}
