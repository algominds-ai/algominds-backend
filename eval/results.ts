import { type Output, OutputSchema } from "@eval/schema";
import type { Sql } from "postgres";

export async function readOutput(sql: Sql, runId: string): Promise<Output> {
	const [run] =
		await sql`select status, cost_dollars, extract(epoch from (finished_at-started_at))::float8 as seconds,
		(select doc from icp where icp.id=run.icp_id) as profile from run where id=${runId}`;
	if (!run) throw new Error(`eval: missing run ${runId}`);
	const entities = await sql`
		select c.domain as id, null::text as company, c.name, null::text as title,
			jsonb_build_object('record', c.data, 'description', c.description, 'selectionReason', c.selection_reason) as data
		from company c join run r on r.id=c.run_id where r.id=${runId} and r.capability='companies'
		union all
		select coalesce(p.linkedin_url,p.id::text), rc.domain, p.name, p.title, p.data
		from person p join run_company rc on rc.company_id=p.company_id where rc.run_id=${runId}`;
	const evidence = await sql`
		select e.subject_id as subject, e.kind, e.value, e.source, e.seen_at::text as "seenAt"
		from evidence e where e.subject_id in (
			select ${runId}::text
			union select id::text from run_company where run_id=${runId}
			union select id::text from company where run_id=${runId}
			union select p.id::text from person p join run_company rc on rc.company_id=p.company_id where rc.run_id=${runId}
		)`;
	const diagnostics = await sql`
		select jsonb_build_object('ordinal',ordinal,'plan',plan,'found',found,'rejects',rejects,'rejected',rejected) as data from round where run_id=${runId}
		union all select jsonb_build_object('domain',domain,'identity',identity,'mode',mode,'buyerSource',buyer_source,
			'peopleVerified',people_verified,'peopleRoster',people_roster,'spendDollars',spend_dollars) from run_company where run_id=${runId}`;
	return OutputSchema.parse({
		runId,
		status: run.status,
		error: null,
		asOf: new Date().toISOString(),
		costDollars: run.cost_dollars,
		seconds: run.seconds,
		profile: run.profile,
		entities,
		evidence,
		diagnostics: diagnostics.map((row) => row.data),
	});
}
