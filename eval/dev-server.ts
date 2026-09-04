import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { armDatabaseUrl } from "@eval/arm-db";

const BASE_CONNECTION_STRING =
	"postgresql://postgres:postgres@localhost:5432/algo";
const HEALTH_POLL_MS = 500;
const HEALTH_TIMEOUT_MS = 60_000;

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
function writeArmConfig(arm: string): string {
	const base = readFileSync("wrangler.jsonc", "utf8");
	const swapped = base.replaceAll(BASE_CONNECTION_STRING, armDatabaseUrl(arm));
	const path = armConfigPath(arm);
	writeFileSync(path, swapped);
	return path;
}

export type DevServer = {
	url: string;
	stop: () => void;
};

async function waitForHealth(url: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/health`);
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
	const configPath = writeArmConfig(arm);
	const url = `http://localhost:${port}`;
	const child = spawn(
		"bunx",
		["wrangler", "dev", "--config", configPath, "--port", String(port)],
		{ stdio: "ignore", detached: false },
	);
	const stop = () => {
		child.kill();
		rmSync(configPath, { force: true });
	};
	try {
		await waitForHealth(url);
	} catch (error) {
		stop();
		throw error;
	}
	return { url, stop };
}
