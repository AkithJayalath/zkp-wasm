#!/usr/bin/env node
// Per-operation microbenchmark in Chrome: one Fr multiplication and one G1 mixed addition,
// for several builds of the same Rust code. The native numbers come from kernels/.../micro.
//
//   node runner/chrome_micro.mjs --builds plain,wide,simd --iters 10000000 --reps 10
import path from "node:path";
import { runPage } from "./chrome_common.mjs";
import { ROOT, parseArgs, appendJsonl, median } from "./common.mjs";

const a = parseArgs();
const builds = a.builds || "plain,wide,simd";
const flags = /wide/.test(builds) ? ["--js-flags=--experimental-wasm-wide-arithmetic"] : [];
const res = await runPage({ mode: "micro", builds, iters: a.iters || "10000000", reps: a.reps || "10" }, { flags });
const recs = res.records.map((r) => ({ ...r, browser: res.browser, browser_flags: flags.join(" "), when: new Date().toISOString() }));
appendJsonl(path.join(ROOT, "results/raw/micro.jsonl"), recs);
for (const b of builds.split(",")) for (const op of ["fr_mul", "g1_add"]) {
  const xs = recs.filter((r) => r.build === b && r.op === op && r.ns_per_op).map((r) => r.ns_per_op);
  if (xs.length) console.log(`${b.padEnd(8)} ${op.padEnd(7)} median ${median(xs).toFixed(2)} ns/op  (${xs.length} reps)`);
}
