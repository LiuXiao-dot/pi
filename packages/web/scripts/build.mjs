import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const { build } = loadEsbuild();

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const outDir = join(pkgRoot, "dist");

mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [join(pkgRoot, "src", "main.ts")],
	bundle: true,
	format: "esm",
	platform: "browser",
	outdir: outDir,
	sourcemap: true,
});

const html = readFileSync(join(pkgRoot, "index.html"), "utf8")
	.replace('/src/style.css', './style.css')
	.replace('/src/main.ts', './main.js');
writeFileSync(join(outDir, "index.html"), html);
copyFileSync(join(pkgRoot, "src", "style.css"), join(outDir, "style.css"));

// Copy assets directory
const assetsDir = join(pkgRoot, "src", "assets");
const assetsOut = join(outDir, "assets");
cpSync(assetsDir, assetsOut, { recursive: true });

console.log("Built pi-web to", outDir);
