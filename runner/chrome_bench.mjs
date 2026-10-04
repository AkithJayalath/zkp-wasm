#!/usr/bin/env node
// B1: SnarkJS in Google Chrome, driven by Playwright. A fresh browser per configuration,
// so iteration 0 is a true cold start.
//
//   node runner/chrome_bench.mjs --circuit c1_16 --threads all --runs 30 --warmup 5
//
// Env: HEADFUL=1 shows the window; BROWSER_CHANNEL=chromium uses Playwright's Chromium
//      instead of Google Chrome; CHROME_PATH=/path/to/chrome uses that binary;
//      NO_ISOLATION=1 serves without COOP/COEP.
// Writes one JSON line per run to results/raw/chrome.jsonl
import path from "node:path";
import { chromium } from "playwright";
import { startServer } from "../web/server.mjs";
import {
  ROOT, parseArgs, benchConfig, circuitFiles, readJson, newBatchId, baseRecord,
  appendJsonl, printSummary,
} from "./common.mjs";

const cfg = benchConfig(parseArgs());
const meta = readJson(circuitFiles(cfg.circuit).meta);
const PORT = Number(process.env.PORT || 8123);
const isolate = process.env.NO_ISOLATION !== "1";
const channel = process.env.BROWSER_CHANNEL || "chrome";

const server = await startServer({ port: PORT, isolate });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel }),
  headless: process.env.HEADFUL !== "1",
});
const version = browser.version();
const page = await (await browser.newContext()).newPage();
page.on("console", (m) => console.log(`[chrome] ${m.text()}`));
const crashed = new Promise((_, reject) => page.on("crash", () => reject(new Error("browser tab crashed (out of memory?)"))));
crashed.catch(() => {}); // a crash after the run finished must not kill the process

const url = `http://127.0.0.1:${PORT}/web/bench.html?` +
  new URLSearchParams({ circuit: cfg.circuit, threads: cfg.threads, runs: cfg.runs, warmup: cfg.warmup });
const batch = newBatchId();
const base = {
  ...baseRecord({ batch, runtime: "chrome", engine: "snarkjs", cfg, meta }),
  browser: `${process.env.CHROME_PATH ? "custom" : channel} ${version}`,
};
let failed = null;

try {
  await page.goto(url);
  await Promise.race([
    page.waitForFunction(() => window.__benchDone || window.__benchError, null, { timeout: 0, polling: 1000 }),
    crashed,
  ]);
  const res = await page.evaluate(() => ({ error: window.__benchError, results: window.__benchResults }));
  if (res.error) throw new Error(res.error);
  const records = res.results.records.map((r) => ({ ...base, ...r, user_agent: res.results.userAgent }));
  appendJsonl(path.join(ROOT, "results/raw/chrome.jsonl"), records);
  printSummary(`chrome ${cfg.circuit} threads=${cfg.threads}`, records);
} catch (e) {
  failed = e;
  console.error(`FAILED chrome ${cfg.circuit} threads=${cfg.threads}: ${e.message}`);
  appendJsonl(path.join(ROOT, "results/raw/failures.jsonl"), [{ ...base, status: "failed", error: String(e.message) }]);
} finally {
  await browser.close().catch(() => {});
  server.close();
}
process.exit(failed ? 1 : process.exitCode ?? 0);
