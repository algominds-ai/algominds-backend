import { draftIcp, type IcpDoc, type Requirement } from "@/core/icp";

/** A singleton company condition, with grouping available directly on the returned value. */
export function requirementFixture(
	text: string,
	kind: Requirement["kind"] = "required",
): Requirement {
	return {
		kind,
		anyOf: [{ allOf: [{ text, window: null, sourceRule: null }] }],
	};
}

/** A complete profile whose targeting fields can be replaced without copying seller boilerplate. */
export function profileFixture(
	icp: Partial<IcpDoc["icp"]> = {},
	instructions:
		| string
		| null = "Find software companies and their product leaders.",
	domain: string | null = "seller.example",
): IcpDoc {
	const doc = draftIcp(domain, instructions);
	return {
		...doc,
		extracted: true,
		icp: {
			...doc.icp,
			offer: "Product analytics",
			buyer: "Product leaders",
			...icp,
		},
	};
}
