#!/usr/bin/env node
/**
 * Run pi-hub from the monorepo without a global install.
 * Builds web + hub first when dist artifacts are missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages/hub/dist/cli.js");
const webInHub = join(root, "packages/hub/dist/public/index.html");

function run(command, args, options = {}) {
	return spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
		...options,
	});
}

if (!existsSync(cli) || !existsSync(webInHub)) {
	console.log("[pi-hub] Missing build artifacts; running hub:build...");
	const build = run("npm", ["run", "hub:build"]);
	if (build.status !== 0) {
		process.exit(build.status ?? 1);
	}
}

// Detect pi CLI in the monorepo and set PI_COMMAND so role subprocesses can find it.
const piCli = join(root, "packages", "coding-agent", "dist", "cli.js");
const env = { ...process.env };
if (!env.PI_COMMAND && existsSync(piCli)) {
	env.PI_COMMAND = `${process.execPath} "${piCli}"`;
	console.log(`[pi-hub] Auto-detected pi CLI: ${env.PI_COMMAND}`);
} else if (env.PI_COMMAND) {
	console.log(`[pi-hub] Using PI_COMMAND from environment: ${env.PI_COMMAND}`);
} else if (!existsSync(piCli)) {
	console.warn(`[pi-hub] pi CLI not found at ${piCli} — role subprocesses will fail.`);
	console.warn(`[pi-hub] Set PI_COMMAND env var or build packages/coding-agent.`);
}

const forwarded = process.argv.slice(2);
const child = spawnSync(process.execPath, [cli, ...forwarded], {
	cwd: root,
	stdio: "inherit",
	env,
});

process.exit(child.status ?? 1);
