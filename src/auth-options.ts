import { apiKey } from "@better-auth/api-key";
import { openAPI } from "better-auth/plugins";
import { organization } from "better-auth/plugins/organization";
import { config } from "@/config";

export const ORGANIZATION_KEY_PREFIX = "ak_";
export const ORGANIZATION_KEY_CONFIG_ID = "org-keys";

type OrganizationOptions = NonNullable<Parameters<typeof organization>[0]>;

export type AfterCreateOrganization = NonNullable<
	NonNullable<
		OrganizationOptions["organizationHooks"]
	>["afterCreateOrganization"]
>;

/** The plugin list, optionally carrying a callback to run once an organization exists. */
export function buildPlugins(
	afterCreateOrganization?: AfterCreateOrganization,
) {
	return [
		organization({
			...(afterCreateOrganization
				? { organizationHooks: { afterCreateOrganization } }
				: {}),
			schema: {
				organization: {
					additionalFields: {
						domain: { type: "string", input: true, required: false },
					},
				},
			},
		}),
		openAPI(),
		apiKey([
			{
				configId: ORGANIZATION_KEY_CONFIG_ID,
				defaultPrefix: ORGANIZATION_KEY_PREFIX,
				references: "organization",
				rateLimit: { enabled: false },
			},
		]),
	];
}

/**
 * Everything about the auth surface except the database, so the runtime
 * instance and the schema generator describe the same thing. Keys carry no
 * quota of their own: rate limiting belongs at the edge, where a handler bug
 * cannot bypass it, and the plugin's default of ten requests a day would stop
 * a real run long before it finished.
 */
export const authOptions = {
	appName: "algo",
	baseURL: {
		allowedHosts: [...config.auth.allowedHosts],
		fallback: config.auth.fallbackUrl,
		protocol: "auto" as const,
	},
	trustedOrigins: [...config.auth.trustedOrigins],
	emailAndPassword: { enabled: true },
	plugins: buildPlugins(),
};
