import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://algo.test";

async function post(path: string, body: unknown): Promise<Response> {
	return exports.default.fetch(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

function newEmail(): string {
	return `signup-${crypto.randomUUID()}@algo.test`;
}

describe("the sign-up endpoint", () => {
	it("creates a user from an email and a password", async () => {
		const response = await post("/api/auth/sign-up/email", {
			email: newEmail(),
			password: "a-long-enough-password",
			name: "Probe User",
		});

		expect(response.status).toBe(200);
	}, 30000);

	it("refuses a second sign-up with the same email", async () => {
		const email = newEmail();
		const body = { email, password: "a-long-enough-password", name: "Probe" };

		expect((await post("/api/auth/sign-up/email", body)).status).toBe(200);
		expect((await post("/api/auth/sign-up/email", body)).status).not.toBe(200);
	}, 30000);

	it("refuses a password too short to be one", async () => {
		const response = await post("/api/auth/sign-up/email", {
			email: newEmail(),
			password: "x",
			name: "Probe",
		});

		expect(response.status).not.toBe(200);
	}, 30000);

	it("needs no api key, since a key is what sign-up leads to", async () => {
		const response = await post("/api/auth/sign-up/email", {
			email: newEmail(),
			password: "a-long-enough-password",
			name: "Probe",
		});

		expect(response.status).not.toBe(401);
	}, 30000);
});
