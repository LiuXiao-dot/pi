import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

function loadEsbuild() {
	const require = createRequire(import.meta.url);
	for (const p of ["esbuild", "../../../node_modules/esbuild"]) {
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

mkdirSync(dist, { recursive: true });

// Build main process (ESM for Node.js / Electron main)
await esbuild.build({
	entryPoints: [join(root, "src", "main.ts"), join(root, "src", "tray.ts"), join(root, "src", "updater.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outdir: dist,
	packages: "external",
	banner: {
		js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
	},
});

// Build preload (CJS, standard for Electron preload)
await esbuild.build({
	entryPoints: [join(root, "src", "preload.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: join(dist, "preload.js"),
	packages: "external",
});

// Copy web dist as public/ for the hub HTTP server
const publicDir = join(dist, "public");
mkdirSync(publicDir, { recursive: true });
const webDist = join(root, "..", "web", "dist");
if (existsSync(webDist)) {
	cpSync(webDist, publicDir, { recursive: true });
	console.log("Copied web dist to dist/public");
} else {
	console.warn("Warning: web dist not found at", webDist, "- run npm run web:build first");
	console.warn("The hub will fail to serve web UI without it.");
}

console.log("Built pi-desktop to", dist);
