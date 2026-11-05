#!/usr/bin/env node
// SnarkJS in Google Chrome, driven by Playwright. A fresh browser per configuration,
// so iteration 0 is a true cold start.
//
//   RQ1/RQ2 baseline (unchanged):
//     node runner/chrome_bench.mjs --circuit c1_16 --threads all --runs 30 --warmup 5
//       -> results/raw/chrome.jsonl
//   RQ3/RQ4 configurations (runner/configs.mjs):
//     node runner/chrome_bench.mjs --config T5.1 --circuit c1_16 --threads all --runs 30 --warmup 5
//       -> results/raw/chrome_opt.jsonl   (field "config" says which one)
//
// Env: see runner/chrome_common.mjs (HEADFUL, BROWSER_CHANNEL, CHROME_PATH, NO_ISOLATION).
import path from "node:path";
import { runPage } from "./chrome_common.mjs";
import { resolveConfig, browserFlags } from "./configs.mjs";
import { ROOT, parseArgs, benchConfig, circuitFiles, readJson, newBatchId, baseRecord, appendJsonl, printSummary } from "./common.mjs";

const args = parseArgs();
const cfg = benchConfig(args);
const meta = readJson(circuitFiles(cfg.circuit).meta);
const configId = args.config || null;
const { kernel, opt } = configId ? resolveConfig(configId, cfg.threads) : { kernel: "", opt: "" };
const flags = browserFlags(kernel);
const out = path.join(ROOT, "results/raw", configId ? "chrome_opt.jsonl" : "chrome.jsonl");
const batch = newBatchId();
const label = `chrome ${configId || ""} ${cfg.circuit} threads=${cfg.threads}`.replace(/\s+/g, " ");
const base = {
  ...baseRecord({ batch, runtime: "chrome", engine: kernel ? "snarkjs+kernels" : "snarkjs", cfg, meta }),
  ...(configId ? { config: configId } : {}),
};

let failed = null;
try {
  const res = await runPage({ circuit: cfg.circuit, threads: cfg.threads, runs: cfg.runs, warmup: cfg.warmup, kernel, opt }, { flags });
  const records = res.records.map((r) => ({ ...base, ...r, browser: res.browser, browser_flags: flags.join(" "), user_agent: res.userAgent }));
  appendJsonl(out, records);
  printSummary(label, records);
} catch (e) {
  failed = e;
  console.error(`FAILED ${label}: ${e.message}`);
  appendJsonl(path.join(ROOT, "results/raw/failures.jsonl"), [{ ...base, status: "failed", error: String(e.message) }]);
}
process.exit(failed ? 1 : process.exitCode ?? 0);
