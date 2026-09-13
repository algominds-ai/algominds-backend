/** Generated from config.yaml. Edit that file, then run `bun run config`. */
export const config = {
	limits: {
		maxCompaniesPerRequest: 300,
		defaultMaxCompaniesPerPeopleRun: 100,
		maxCompaniesPerPeopleRun: 100,
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
	companies: {
		maxRounds: 3,
		resultsPerRound: 100,
		judgeCandidateMultiple: 2,
		descriptionChars: 600,
		exaAgentPollIntervalSeconds: 5,
		exaAgentMaxPollAttempts: 120,
		maxAnglesPerRound: 12,
		agentStartStaggerMs: 1500,
		provingConcurrency: 5,
		contentsMaxCharacters: 10000,
		judgeBatchSize: 4,
		exaRetryAfterMaxMs: 5000,
		exaPollBudgetPerSecond: 2,
	},
	people: {
		exaAgentPollIntervalSeconds: 5,
		exaAgentMaxPollAttempts: 24,
		clayFetchTimeoutMs: 30000,
		clayRetryAfterMaxMs: 5000,
		companyConcurrency: 5,
		maxVerifyPerCompany: 25,
		verifyConcurrency: 5,
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
	model: {
		timeoutMs: 90000,
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
		judgeCall: {
			retries: {
				limit: 1,
				delay: "10 seconds",
			},
			timeout: "5 minutes",
		},
		roundCall: {
			retries: {
				limit: 0,
				delay: "10 seconds",
			},
			timeout: "20 minutes",
		},
	},
} as const;
