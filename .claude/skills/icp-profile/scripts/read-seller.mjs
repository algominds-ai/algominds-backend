#!/usr/bin/env bun
// Reads a seller's own site and prints its pages as text.
// One deep Exa search with ten query variations and a live crawl.
// Usage: bun scripts/read-seller.mjs <domain> [maxPages]
import { readFileSync } from "node:fs";
import { sellerAngles } from "@/core/seller-angles";

const DOMAIN = process.argv[2];
const MAX = Number(process.argv[3] ?? 25);
if (!DOMAIN) {
	console.error("usage: read-seller.mjs <domain> [maxPages]");
	process.exit(1);
}
const envPath = `${process.env.REPO ?? process.cwd()}/.env`;
let envText;
try {
	envText = readFileSync(envPath, "utf8");
} catch {
	console.error(`no .env at ${envPath}; set REPO to the repository root`);
	process.exit(1);
}
const env = Object.fromEntries(
	envText
		.split("\n")
		.filter((l) => l.includes("=") && !l.startsWith("#"))
		.map((l) => {
			const i = l.indexOf("=");
			return [
				l.slice(0, i).trim(),
				l
					.slice(i + 1)
					.trim()
					.replace(/^["']|["']$/g, ""),
			];
		}),
);

if (!env.EXA_API_KEY) {
	console.error(`no EXA_API_KEY in ${envPath}`);
	process.exit(1);
}

const ANGLES = sellerAngles(DOMAIN);

const res = await fetch("https://api.exa.ai/search", {
	method: "POST",
	headers: { "x-api-key": env.EXA_API_KEY, "content-type": "application/json" },
	body: JSON.stringify({
		query: `everything about ${DOMAIN}: what it sells, who buys it, and the customers it names`,
		additionalQueries: ANGLES,
		type: "deep",
		numResults: MAX,
		includeDomains: [DOMAIN],
		systemPrompt: "Prefer the company's own pages and avoid duplicate results.",
		contents: {
			text: { maxCharacters: 4000 },
			maxAgeHours: 0,
			livecrawlTimeout: 12000,
		},
	}),
});
const body = await res.json();
if (!res.ok) {
	console.error(`exa ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
	process.exit(1);
}
const pages = body.results ?? [];
console.error(
	`${pages.length} pages, $${(body.costDollars?.total ?? 0).toFixed(4)}`,
);
for (const p of pages) {
	console.log(`--- ${p.url}\n${(p.text ?? "").replace(/\n{2,}/g, "\n")}\n`);
}
