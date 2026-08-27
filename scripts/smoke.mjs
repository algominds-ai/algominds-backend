#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
	readFileSync(".env", "utf8")
		.split("\n")
		.filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => {
			const i = l.indexOf("=");
			const raw = l.slice(i + 1);
			const commented = raw.search(/\s#/);
			return [
				l.slice(0, i),
				(commented === -1 ? raw : raw.slice(0, commented)).trim(),
			];
		}),
);

let spent = 0;

async function exaSearch(body) {
	const res = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"x-api-key": env.EXA_API_KEY,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json = await res.json();
	if (!res.ok)
		throw new Error(`exa ${res.status}: ${JSON.stringify(json).slice(0, 160)}`);
	spent += json?.costDollars?.total ?? 0;
	return json;
}

function parseSummary(raw) {
	try {
		return JSON.parse(raw ?? "");
	} catch {
		return {};
	}
}

function normalizeTitle(raw) {
	if (!raw) return null;
	const cut = [raw.indexOf("@"), raw.indexOf("("), raw.indexOf("|")].filter(
		(i) => i > 0,
	);
	return (cut.length ? raw.slice(0, Math.min(...cut)) : raw).trim();
}

async function findCompanies() {
	const out = await exaSearch({
		query: "seed stage fintech startup in San Francisco",
		category: "company",
		numResults: 3,
		contents: {
			summary: {
				schema: {
					type: "object",
					required: ["companyName"],
					properties: {
						companyName: { type: "string" },
						domain: { type: "string" },
						hqCity: { type: "string" },
					},
				},
			},
		},
	});
	return (out.results ?? []).map((r) => {
		const s = parseSummary(r.summary);
		return {
			name: s.companyName ?? null,
			domain: s.domain ?? new URL(r.url).hostname.replace(/^www\./, ""),
			url: r.url,
		};
	});
}

async function findDecisionMakers(company) {
	const out = await exaSearch({
		query: `VP of Sales, Head of Growth or founder at ${company.name}`,
		category: "linkedin profile",
		type: "keyword",
		numResults: 3,
		contents: {
			summary: {
				schema: {
					type: "object",
					required: ["fullName"],
					properties: {
						fullName: { type: "string" },
						currentTitle: { type: "string" },
						currentCompany: { type: "string" },
					},
				},
			},
		},
	});
	return (out.results ?? [])
		.map((r) => {
			const s = parseSummary(r.summary);
			return {
				fullName: s.fullName ?? null,
				title: normalizeTitle(s.currentTitle),
				rawTitle: s.currentTitle ?? null,
				employer: s.currentCompany ?? null,
				linkedinUrl: r.url,
			};
		})
		.filter((p) => p.fullName);
}

const companies = await findCompanies();
console.log("\n── companies found ──");
for (const c of companies)
	console.log(`  ${String(c.name).padEnd(26)} ${c.domain}`);

console.log("\n── decision makers at those same companies ──");
let peopleTotal = 0;
let matched = 0;
for (const company of companies) {
	const people = await findDecisionMakers(company);
	peopleTotal += people.length;
	console.log(`\n  ${company.name} (${company.domain})`);
	if (people.length === 0) console.log("     none found");
	for (const p of people) {
		const agrees = (p.employer ?? "")
			.toLowerCase()
			.includes(String(company.name).toLowerCase().split(" ")[0]);
		if (agrees) matched++;
		console.log(
			`     ${String(p.fullName).padEnd(22)} ${String(p.title ?? "?").padEnd(28)} employer=${p.employer ?? "?"} ${agrees ? "MATCH" : "mismatch"}`,
		);
		if (p.rawTitle && p.rawTitle !== p.title)
			console.log(`        raw headline: ${p.rawTitle}`);
	}
}

console.log("\n════ chain result ════");
console.log(`  companies found          ${companies.length}`);
console.log(`  people found             ${peopleTotal}`);
console.log(`  employer agrees w/ target ${matched}/${peopleTotal}`);
console.log(`  exa spend                $${spent.toFixed(4)}`);
