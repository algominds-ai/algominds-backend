/**
 * Shared abort timeout for every direct outbound call this engine waits on
 * synchronously: Exa's agent and search endpoints, and every structured
 * model call through the AI Gateway. One durable step pays for at most one
 * of these before it must give up and let the caller decide what a timeout
 * means.
 */
export const EXA_FETCH_TIMEOUT_MS = 60_000;
