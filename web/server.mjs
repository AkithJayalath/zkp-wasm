#!/usr/bin/env node
// Local static server for the browser benchmark.
// Sends COOP/COEP headers so the page is cross-origin isolated (needed later for
// SharedArrayBuffer / threaded WASM, and gives Chrome full-precision timers).
//
//   node web/server.mjs                 -> http://127.0.0.1:8123/
//   NO_ISOLATION=1 node web/server.mjs  -> same, without COOP/COEP (troubleshooting only)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["web", "build", path.join("node_modules", "snarkjs", "build")].map((d) => path.join(ROOT, d) + path.sep);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

export function startServer({ port = 8123, isolate = true } = {}) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (p === "/") p = "/web/bench.html";
    const file = path.join(ROOT, p);
    if (!ALLOWED.some((dir) => file.startsWith(dir))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      const headers = {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": "no-store",
      };
      if (isolate) {
        headers["Cross-Origin-Opener-Policy"] = "same-origin";
        headers["Cross-Origin-Embedder-Policy"] = "require-corp";
        headers["Cross-Origin-Resource-Policy"] = "same-origin";
      }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Run directly: node web/server.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8123);
  const isolate = process.env.NO_ISOLATION !== "1";
  await startServer({ port, isolate });
  console.log(`Serving on http://127.0.0.1:${port}/  (cross-origin isolation: ${isolate ? "ON" : "OFF"})`);
  console.log(`Open e.g. http://127.0.0.1:${port}/web/bench.html?circuit=multiplier&threads=all&runs=3&warmup=1`);
}
