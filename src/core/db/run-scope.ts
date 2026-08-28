import { NonRetryableError } from "cloudflare:workflows";
import type { SQL } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { Run } from "@/core/db/schema";
import { company } from "@/core/db/schema";

/**
 * The condition selecting the companies a run covers. A companies run owns
 * its rows directly; a people run covers the profile's companies, because a
 * person carries no run id of its own. An enrich run covers nothing itself:
 * it reads the run it was asked to enrich.
 */
export function companyScopeForRun(run: Run): SQL | undefined {
	if (run.capability === "companies") return eq(company.runId, run.id);
	if (run.capability === "people") return eq(company.icpId, run.icpId);
	throw new NonRetryableError(
		`run ${run.id} has no company scope for capability ${run.capability}`,
	);
}
