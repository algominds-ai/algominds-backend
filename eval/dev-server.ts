import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { armDatabaseUrl } from "@eval/arm-db";

const BASE_CONNECTION_STRING =
	"postgresql://postgres:postgres@localhost:5432/algo";
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 60_000;
const LOG_DIR = "eval/logs";

function devServerLogPath(arm: string, port: number): string {
	return `${LOG_DIR}/dev-${arm}-${port}.log`;
}

function armConfigPath(arm: string): string {
	return `wrangler.eval-${arm}.jsonc`;
}

/**
 * A copy of `wrangler.jsonc` with both Hyperdrive local connection strings
 * pointed at `eval_<arm>` instead of `algo`, written beside it as
 * `wrangler.eval-<arm>.jsonc` (gitignored), because wrangler resolves the
 * entry point relative to the config file. A plain text substitution rather than a JSONC parse: the
 * file's only well-known variable part is that one literal string.
 */
function writeArmConfig(arm: string, token: string): string {
	const base = readFileSync("wrangler.jsonc", "utf8");
	if (!base.includes(BASE_CONNECTION_STRING))
		throw new Error("eval: local database configuration changed");
	if (!/"vars"\s*:\s*\{/.test(base))
		throw new Error("eval: missing Worker vars");
	const swapped = base
		.replaceAll(BASE_CONNECTION_STRING, armDatabaseUrl(arm))
		.replace(/"vars"\s*:\s*\{/, `"vars": {"EVAL_TOKEN":"${token}",`);
	const path = armConfigPath(arm);
	writeFileSync(path, swapped, { mode: 0o600 });
	return path;
}

export type DevServer = {
	url: string;
	token: string;
	stop: () => void;
};

async function waitForHealth(url: string, token: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/__eval/health`, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
	}
	throw new Error(`eval: dev server at ${url} never became healthy`);
}

/**
 * Starts `wrangler dev` on `port` against `eval_<arm>`'s own database and
 * waits for `/health` to answer. The caller owns calling `stop()` once the
 * arm's runs are done, which kills the process and removes the generated
 * config.
 */
export async function startDevServer(
	arm: string,
	port: number,
): Promise<DevServer> {
	const token = crypto.randomUUID();
	const configPath = writeArmConfig(arm, token);
	const url = `http://localhost:${port}`;
	mkdirSync(LOG_DIR, { recursive: true });
	const logFd = openSync(devServerLogPath(arm, port), "a");
	const child = spawn(
		"bunx",
		[
			"wrangler",
			"dev",
			"eval/worker.ts",
			"--ip",
			"127.0.0.1",
			"--config",
			configPath,
			"--port",
			String(port),
		],
		{
			stdio: ["ignore", logFd, logFd],
			detached: true,
			env: { ...process.env, SFW_SHIM_DISABLE: "1" },
		},
	);
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
		}
		closeSync(logFd);
		spawnSync("trash", [configPath]);
	};
	try {
		await waitForHealth(url, token);
	} catch (error) {
		stop();
		throw error;
	}
	return { url, token, stop };
}
