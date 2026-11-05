#!/usr/bin/env node
// Correctness check in Chrome for any kernel build (including threaded and wide ones).
// Proves once with stock SnarkJS and once with the kernels, compares every intermediate
// buffer and verifies the proof (same checks as scripts/check_kernels.mjs).
//
//   node runner/chrome_check.mjs --circuit c1_12 --config ALL --threads all
//   node runner/chrome_check.mjs --circuit c1_12 --kernel threads-wide --opt qap,ntt,msm --threads all
import path from "node:path";
import { runPage } from "./chrome_common.mjs";
import { resolveConfig, browserFlags } from "./configs.mjs";
import { ROOT, parseArgs, appendJsonl } from "./common.mjs";

const a = parseArgs();
const threads = a.threads || "all";
const { kernel, opt } = a.config ? resolveConfig(a.config, threads) : { kernel: a.kernel, opt: a.opt || "qap,ntt,msm" };
if (!kernel) { console.error("need --config (not B1) or --kernel"); process.exit(2); }
const flags = browserFlags(kernel);
const res = await runPage({ mode: "check", circuit: a.circuit || "c1_12", threads, kernel, opt }, { flags });
const c = res.check;
for (const [name, ok] of c.checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(`${c.ok ? "ALL CHECKS PASSED" : "CHECK FAILED"}: ${c.circuit} ${a.config || ""} kernel=${c.kernel} (${c.kernel_info}, ${c.kernel_threads} thread(s)) opt=${c.opt} threads=${c.threads} | ${res.browser}`);
appendJsonl(path.join(ROOT, "results/raw/kernel_checks.jsonl"), [{ ...c, config: a.config || null, browser: res.browser, flags: flags.join(" "), when: new Date().toISOString() }]);
process.exit(c.ok ? 0 : 1);
