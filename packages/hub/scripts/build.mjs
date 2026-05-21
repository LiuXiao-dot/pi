import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

function loadEsbuild() {
	const paths = [
		"esbuild",
		"../../../node_modules/esbuild",
		"../../../../node_modules/esbuild",
	];
	const require = createRequire(import.meta.url);
	for (const p of paths) {
		try {
			return require(p);
		} catch {
			// try next
		}
	}
	throw new Error("esbuild not found; run npm install from repo root");
}

const esbuild = loadEsbuild();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await esbuild.build({
	entryPoints: [join(root, "src", "cli.ts"), join(root, "src", "index.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outdir: dist,
	packages: "external",
});

await esbuild.build({
	entryPoints: [join(root, "test", "run-ws-smoke.mjs")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: join(dist, "run-ws-smoke.js"),
	packages: "external",
});

chmodSync(join(dist, "cli.js"), 0o755);

mkdirSync(join(dist, "public"), { recursive: true });
const webDist = join(root, "..", "web", "dist");
cpSync(webDist, join(dist, "public"), { recursive: true });

console.log("Built pi-hub to", dist);
