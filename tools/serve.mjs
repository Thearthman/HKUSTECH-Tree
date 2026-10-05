#!/usr/bin/env node
/**
 * Minimal static file server for local development of the browser-only build.
 *
 * It mirrors the Vercel deployment: the `static/` directory is the site root,
 * pretty URLs resolve to `.html` files, and `/ustree` falls back to
 * `index.html` (the SPA entry point).
 *
 * Usage: node tools/serve.mjs [port]
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../static", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const candidate = join(ROOT, relative);
  if (!candidate.startsWith(ROOT + sep) && candidate !== ROOT) return null;

  const attempts = [];
  if (relative === "" || relative.endsWith("/")) {
    attempts.push(join(candidate, "index.html"));
  } else {
    attempts.push(candidate);
    if (!extname(relative)) {
      attempts.push(candidate + ".html");
      attempts.push(join(candidate, "index.html"));
    }
  }
  if (decoded === "/ustree" || decoded === "/ustree/") {
    attempts.push(join(ROOT, "index.html"));
  }
  for (const attempt of attempts) {
    try {
      const info = await stat(attempt);
      if (info.isFile()) return attempt;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const server = createServer(async (request, response) => {
  const file = await resolveFile(request.url || "/");
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  createReadStream(file).pipe(response);
});

server.listen(PORT, () => {
  console.log(`HKUSTECH-Tree static server running at http://localhost:${PORT}/`);
  console.log("Serving " + ROOT);
});
