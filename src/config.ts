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
} as const;
