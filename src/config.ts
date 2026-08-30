/** Generated from config.yaml. Edit that file, then run `bun run config`. */
export const config = {
	limits: {
		maxCompaniesPerRequest: 300,
		defaultMaxCompaniesPerPeopleRun: 100,
		maxCompaniesPerPeopleRun: 300,
		maxRunPageSize: 200,
	},
	auth: {
		allowedHosts: ["localhost", "127.0.0.1", "api.algominds.ai"],
		fallbackUrl: "https://api.algominds.ai",
		trustedOrigins: [
			"http://localhost:8787",
			"http://127.0.0.1:8787",
			"https://algominds.ai",
			"https://*.algominds.ai",
		],
	},
	seller: {
		domain: "algominds.ai",
		name: "Algominds",
	},
	companies: {
		maxRounds: 3,
		resultsPerRound: 100,
		judgeCandidateMultiple: 3,
		descriptionChars: 600,
		seenDomainsWindowDays: 90,
		exaAgentPollIntervalSeconds: 5,
		exaAgentMaxPollAttempts: 60,
	},
	people: {
		seenPeopleWindowDays: 90,
		resultsPerCompany: 25,
		batchSize: 5,
		peopleSource: "exa-search",
		exaAgentEffort: "low",
		exaAgentPollIntervalSeconds: 5,
		exaAgentMaxPollAttempts: 24,
	},
	enrich: {
		batchSize: 5,
		emailTtlDays: 90,
		linkedinTtlDays: 30,
		exaAgentEffort: "low",
		exaAgentPollIntervalSeconds: 5,
		exaAgentMaxPollAttempts: 24,
	},
	spend: {
		perRunDollars: 2,
		perAccountDailyDollars: 50,
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
