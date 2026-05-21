import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
};

export interface HttpServerOptions {
	publicDir: string;
}

export function createHttpServer(options: HttpServerOptions): ReturnType<typeof createServer> {
	const publicRoot = normalize(options.publicDir);

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
		const resolved = normalize(join(publicRoot, filePath));
		if (!resolved.startsWith(publicRoot)) {
			res.writeHead(403);
			res.end("Forbidden");
			return;
		}

		if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
			const indexFallback = join(publicRoot, "index.html");
			if (existsSync(indexFallback)) {
				filePath = "/index.html";
			} else {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
		}

		const finalPath = filePath === "/index.html" && !existsSync(resolved) ? join(publicRoot, "index.html") : resolved;
		const ext = extname(finalPath);
		res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
		createReadStream(finalPath).pipe(res);
	});

	return server;
}

export function defaultPublicDir(): string {
	return join(__dirname, "public");
}
