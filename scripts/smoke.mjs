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
const note = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

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
	spent += json?.costDollars?.total ?? 0;
	return json;
}

function parseSummary(raw) {
	try {
		return JSON.parse(raw ?? "");
	} catch {
		return null;
	}
}

async function findCompanies() {
	console.log("\n── find companies ──");
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
						hqCity: { type: "string" },
						stage: { type: "string" },
					},
				},
			},
		},
	});
	const rows = (out.results ?? []).map((r) => ({
		url: r.url,
		...parseSummary(r.summary),
	}));
	for (const r of rows)
		note(String(r.companyName).slice(0, 22), `${r.stage ?? "?"} · ${r.url}`);
	note("cost", `$${out?.costDollars?.total ?? 0}`);
	return rows;
}

async function findPeople(company) {
	console.log(`\n── find people at ${company} ──`);
	const out = await exaSearch({
		query: `VP of Sales or Head of Sales at ${company}`,
		category: "linkedin profile",
		type: "keyword",
		numResults: 2,
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
	const rows = (out.results ?? []).map((r) => ({
		url: r.url,
		...parseSummary(r.summary),
	}));
	for (const p of rows)
		note(
			String(p.fullName).slice(0, 22),
			`${p.currentTitle} @ ${p.currentCompany}`,
		);
	note("cost", `$${out?.costDollars?.total ?? 0}`);
	return rows;
}

async function enrich(linkedinUrl) {
	console.log("\n── enrich ──");
	const res = await fetch("https://app.findymail.com/api/search/linkedin", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.FINDYMAIL_API_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ linkedin_url: linkedinUrl }),
	});
	const c = (await res.json())?.contact ?? {};
	note("email", c.email ?? "(none)");
	note("name", c.name ?? "(none)");
	note("company", c.company ?? "(none)");
	note("credits", "1 email credit");
	return c;
}

const companies = await findCompanies();
const people = await findPeople("Ramp");
const person = people.find((p) => p.url?.includes("linkedin.com/in/"));
if (person) await enrich(person.url);

console.log("\n════ smoke ════");
note("companies found", companies.length);
note("people found", people.length);
note("exa spend", `$${spent.toFixed(4)}`);
note("findymail spend", person ? "1 credit" : "0 credits");
