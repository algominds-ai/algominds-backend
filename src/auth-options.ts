import { apiKey } from "@better-auth/api-key";
import { organization } from "better-auth/plugins/organization";

export const ORGANIZATION_KEY_PREFIX = "ak_";

/**
 * Everything about the auth surface except the database, so the runtime
 * instance and the schema generator describe the same thing.
 */
export const authOptions = {
	appName: "algo",
	plugins: [
		organization(),
		apiKey([
			{
				configId: "org-keys",
				defaultPrefix: ORGANIZATION_KEY_PREFIX,
				references: "organization",
			},
		]),
	],
};
