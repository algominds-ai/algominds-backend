/** The ten angles one deep search reads a seller's own site from. Its own module because the icp-profile skill's script imports it, and that script cannot resolve the Workers runtime the rest of onboarding pulls in. */
export function sellerAngles(domain: string): string[] {
	return [
		`what ${domain} sells and the problem its product solves`,
		`${domain} customers, case studies and customer stories naming real companies`,
		`${domain} testimonials and quotes from named customers`,
		`who ${domain} is built for: the segments, company sizes and industries it names`,
		`${domain} pricing and plans, and which kind of customer each plan is for`,
		`${domain} product pages and what each product does`,
		`${domain} about page, founding story and mission`,
		`${domain} integrations and the systems its customers already run`,
		`${domain} competitors and how it says it differs from them`,
		`${domain} newsroom and announcements about customers or markets`,
	];
}
