import { betterAuth } from "better-auth";
import { authOptions } from "./src/auth-options";

export const auth = betterAuth(authOptions);
