import { NonRetryableError } from "cloudflare:workflows";
import type { SQL } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { Run } from "@/core/db/schema";
import { company } from "@/core/db/schema";

/**
 * The condition selecting the companies a run covers, or null when the
 * capability covers none. A companies run owns its rows directly; a people run
 * covers the profile's companies, because a person carries no run id of its
 * own. Onboarding and enrich cover none: onboarding finds no companies, and an
 * enrich run reads the run it was asked to enrich. Never `undefined`, which
 * drizzle reads as no condition at all and would return every row.
 */
export function companyScopeForRun(run: Run): SQL | null {
	if (run.capability === "companies") return eq(company.runId, run.id);
	if (run.capability !== "people") return null;
	if (run.icpId !== null) return eq(company.icpId, run.icpId);
	throw new NonRetryableError(
		`run ${run.id} is a people run that names no profile, so its companies cannot be found`,
	);
}
