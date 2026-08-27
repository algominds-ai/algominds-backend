import type { Provider } from "@/core/providers/types";

// One array per channel. A new provider costs one entry here and, for a REST
// provider, one new file — no other file changes (R1, R2). Arrays start
// empty; U9 and U10 fill them. There is no PHONE array in v1 (R31).
export const COMPANY: Provider<unknown, unknown>[] = [];
export const PEOPLE: Provider<unknown, unknown>[] = [];
export const EMPLOYMENT: Provider<unknown, unknown>[] = [];
export const EMAIL: Provider<unknown, unknown>[] = [];
export const LINKEDIN: Provider<unknown, unknown>[] = [];
