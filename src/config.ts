import type { WorkflowStepConfig } from "cloudflare:workers";

/** Every tunable number in one place. Workers cannot read YAML at runtime, so this is a plain module. */
export const config = {
	companies: {
		maxRounds: 3,
		resultsPerRound: 100,
		judgeCandidateMultiple: 3,
		descriptionChars: 600,
		seenDomainsWindowDays: 90,
	},
	people: {
		resultsPerCompany: 3,
		batchSize: 5,
	},
	enrich: {
		batchSize: 5,
		emailTtlDays: 90,
		linkedinTtlDays: 30,
	},
	judge: {
		cacheTtlSeconds: 86_400,
	},
	stepConfig: {
		vendorWork: {
			retries: { limit: 2, delay: "10 seconds" },
			timeout: "5 minutes",
		} as const satisfies WorkflowStepConfig,
		databaseWork: {
			retries: { limit: 5, delay: "1 second" },
			timeout: "60 seconds",
		} as const satisfies WorkflowStepConfig,
	},
} as const;
