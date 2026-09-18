import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { log } from "@/core/log";

const LoggedLineSchema = z.object({
	provider: z.string(),
	operation: z.string(),
	ms: z.number(),
	ok: z.boolean(),
	costDollars: z.number(),
	requestId: z.string().optional(),
});

function parseLoggedLine(call: unknown[] | undefined) {
	const raw = call?.[0];
	if (typeof raw !== "string")
		throw new Error("expected console.log to receive a JSON string");
	return LoggedLineSchema.parse(JSON.parse(raw));
}

describe("log", () => {
	it("emits one JSON line per call, carrying every field passed including a failure's requestId and cost", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		log({
			provider: "exa",
			operation: "agent-run",
			ms: 1200,
			ok: true,
			costDollars: 0.5,
			requestId: "req-1",
		});
		log({
			provider: "exa",
			operation: "agent-run",
			ms: 300,
			ok: false,
			costDollars: 0.02,
			requestId: "req-2",
		});

		const lines = logSpy.mock.calls.map(parseLoggedLine);
		expect(lines[0]).toEqual({
			provider: "exa",
			operation: "agent-run",
			ms: 1200,
			ok: true,
			costDollars: 0.5,
			requestId: "req-1",
		});
		expect(lines[1]?.ok).toBe(false);
		expect(lines[1]?.requestId).toBe("req-2");
		expect(lines[1]?.costDollars).toBe(0.02);
		logSpy.mockRestore();
	});

	it("logs one line per attempt, so a provider that succeeds once after two misses shows two failures and one success", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		log({
			provider: "apollo",
			operation: "bulk_match",
			ms: 50,
			ok: false,
			costDollars: 0,
		});
		log({
			provider: "apollo",
			operation: "bulk_match",
			ms: 50,
			ok: false,
			costDollars: 0,
		});
		log({
			provider: "apollo",
			operation: "bulk_match",
			ms: 80,
			ok: true,
			costDollars: 0.09,
		});

		const lines = logSpy.mock.calls.map(parseLoggedLine);
		expect(lines).toHaveLength(3);
		expect(lines.filter((line) => !line.ok)).toHaveLength(2);
		logSpy.mockRestore();
	});
});
