import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { BuyerBackfillResult } from "@/core/db/icp";
import { backfillIcpBuyer } from "@/core/db/icp";
import * as schema from "@/core/db/schema";
import type { IcpBuyer } from "@/core/synthesize";
import { IcpBuyerSchema, SENIOR_BANDS } from "@/core/synthesize";

const ARIS_RUBRIC = `Aris Search is a recruiting firm that places technicians and service-delivery staff
(helpdesk, cloud, network, security, project engineers, service-delivery leads) at managed
service providers. The buyer is the person who OWNS THE DECISION TO ENGAGE AN OUTSIDE
RECRUITER for technical hiring, or who owns the headcount those hires fill.

## POSITIVE (would own the budget or the decision)
- Owner, founder, CEO, president, managing partner — at an MSP under ~150 people the owner
  usually makes this call personally.
- COO, chief services officer, chief customer officer, VP/director of service delivery,
  VP/director of operations, VP/director of managed services, VP/director of professional
  services — they own the technical headcount.
- Head of people, HR director, VP people, director of talent acquisition, recruiting
  manager — they own the recruiting relationship. At small MSPs an "HR Manager" who is the
  only HR person counts.
- Market president / regional president at a roll-up — owns a regional P&L and its hiring.

## CHAMPION (influences, does not own) — label INFLUENCER, not positive
- Service desk manager, NOC manager, engineering manager, team lead — feel the pain, rarely
  sign a recruiter.
- Chief technology officer / CIO at an MSP — often owns technical strategy, sometimes owns
  hiring; label INFLUENCER unless the company is small enough that the CTO is a founder.

## HARD NEGATIVE (looks senior, is not a buyer for THIS purchase)
- CFO, controller, finance director — approve spend, do not choose recruiters.
- VP/director of sales, account executives, account managers, marketing — revenue side.
- Chief information security officer / vCISO delivering security to clients — a delivered
  service role, not a hiring owner.
- Individual engineers, technicians, analysts, project managers, consultants.
- Board members, investors, advisors.
- Anyone at a PARENT PE firm rather than at the MSP itself.

## NOT APPLICABLE
- Anyone whose current employer is not this company.`;

const ONDATO_RUBRIC = `Ondato sells identity verification and onboarding (KYC/KYB) to fintech and consumer platforms
that run their own signup flow. THE CLIENT'S STATED INTENT, which overrides the compliance
vocabulary in the stored profile: target the PRODUCT AND GROWTH side — the people who own
signup conversion, onboarding drop-off, activation and pass rates — NOT the compliance
officers who sign off on it. The buyer is whoever owns the onboarding funnel as a product.

## POSITIVE (would own the budget or the decision)
- Chief product officer, VP/head/director of product — especially if their scope names
  onboarding, growth, identity, activation, or the consumer/business signup journey.
- VP/head/director of growth, growth product, activation, lifecycle, conversion.
- Head of onboarding, head of customer onboarding, head of user acquisition.
- Product manager / group PM explicitly owning onboarding, KYC/KYB product, identity, or
  signup (title must say so).
- At a company under ~100 people: the founder/CEO/COO/CPO who owns the product.

## CHAMPION (influences, does not own) — label INFLUENCER
- CTO / VP engineering / head of platform — builds the integration, rarely chooses the vendor.
- Head of risk or fraud PRODUCT (as opposed to the risk/compliance function) — borderline;
  label INFLUENCER.
- Chief operating officer at a company over ~100 people.

## HARD NEGATIVE (the failure mode this rubric exists to catch)
- Chief compliance officer, head/director of compliance, MLRO, head of AML, KYC analyst,
  financial crime lead, regulatory affairs — they are the compliance function the client
  explicitly does NOT want targeted.
- Chief risk officer / head of risk (the function, not a product role).
- Legal, general counsel, data protection officer.
- CFO, finance, sales, marketing (brand), HR, customer support.
- Board members, investors, advisors.

## NOT APPLICABLE
- Anyone whose current employer is not this company.`;

const BUYERS_BY_DOMAIN: Readonly<Record<string, IcpBuyer>> = {
	"arissearch.com": IcpBuyerSchema.parse({
		rubric: ARIS_RUBRIC,
		bands: SENIOR_BANDS,
		keywordBands: [{ band: "manager", keywords: ["HR", "recruiting"] }],
	}),
	"ondato.com": IcpBuyerSchema.parse({
		rubric: ONDATO_RUBRIC,
		bands: SENIOR_BANDS,
		keywordBands: [],
	}),
};

function describeResult(result: BuyerBackfillResult): string {
	if (result.status === "ambiguous") return `ambiguous:${result.count}`;
	if (result.status === "already-set") return "already set";
	return "updated";
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("backfill-buyer: DATABASE_URL is not set");
	}
	const connection = drizzle(postgres(databaseUrl), { schema });
	for (const [domain, buyer] of Object.entries(BUYERS_BY_DOMAIN)) {
		const result = await backfillIcpBuyer(connection, domain, buyer);
		console.log(`${domain} ${describeResult(result)}`);
	}
	await connection.$client.end();
}

await main();
