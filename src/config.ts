/** Generated from config.yaml. Edit that file, then run `bun run config`. */
export const config = {
	limits: {
		maxCompaniesPerRequest: 300,
		defaultMaxCompaniesPerPeopleRun: 100,
		maxCompaniesPerPeopleRun: 300,
	},
	companies: {
		maxRounds: 3,
		resultsPerRound: 100,
		judgeCandidateMultiple: 3,
		descriptionChars: 600,
		seenDomainsWindowDays: 90,
		companySource: "exa-search",
		exaAgentEffort: "low",
		exaAgentPollIntervalSeconds: 5,
		exaAgentMaxPollAttempts: 24,
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
		cacheTtlSeconds: 86400,
	},
	stepConfig: {
		paidCall: {
			retries: {
				limit: 2,
				delay: "10 seconds",
			},
			timeout: "5 minutes",
		},
		databaseCall: {
			retries: {
				limit: 5,
				delay: "1 second",
			},
			timeout: "60 seconds",
		},
	},
} as const;
