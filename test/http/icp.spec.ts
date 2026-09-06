import { env as testEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIcp } from "@/core/db/queries";
import { draftIcp } from "@/core/icp";
import { onboardScopeId } from "@/http/jobs";
import app from "@/index";
import { issueOrganizationKey } from "../support/db";

describe("profile review and targeting revisions", () => {
	it("returns exact instructions to its owner and hides the profile from another organization", async () => {
		const owner = await issueOrganizationKey(
			`profile-owner-${crypto.randomUUID()}`,
		);
		const other = await issueOrganizationKey(
			`profile-other-${crypto.randomUUID()}`,
		);
		const doc = draftIcp(
			"acme.example",
			"Only the remote-startup product; growth buyers.",
		);
		const row = await createIcp(testEnv, {
			domain: "acme.example",
			organizationId: owner.organizationId,
			doc,
		});
		const response = await app.fetch(
			new Request(`https://algo.test/icp/${row.id}`, {
				headers: { authorization: `Bearer ${owner.key}` },
			}),
			testEnv,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ icpId: row.id, profile: doc });
		const foreign = await app.fetch(
			new Request(`https://algo.test/icp/${row.id}`, {
				headers: { authorization: `Bearer ${other.key}` },
			}),
			testEnv,
		);
		expect(foreign.status).toBe(404);
		expect(await foreign.json()).toEqual({ error: "unknown profile" });
	});
	it("gives revised targeting a new scope while retaining same-note idempotency", async () => {
		const old = { domain: "acme.example", note: "Compliance buyers" };
		const revised = { ...old, note: "Growth buyers" };
		expect(await onboardScopeId(old, "owner")).toBe(
			await onboardScopeId(old, "owner"),
		);
		expect(await onboardScopeId(old, "owner")).not.toBe(
			await onboardScopeId(revised, "owner"),
		);
	});
});
