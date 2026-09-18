import { betterAuth } from "better-auth";
import { authOptions } from "@/auth-options";

/** The static Better Auth instance the schema generator reads; the Worker builds its own from `env` in src/auth.ts. */
export const auth = betterAuth(authOptions);
