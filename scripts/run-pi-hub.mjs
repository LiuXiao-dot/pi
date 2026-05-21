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

const forwarded = process.argv.slice(2);
const child = spawnSync(process.execPath, [cli, ...forwarded], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

process.exit(child.status ?? 1);
