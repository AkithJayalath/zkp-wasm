#!/usr/bin/env node
// J1: SnarkJS (WASM) in Node.js — same code as the browser, without the browser.
//
//   node runner/node_bench.mjs --circuit c1_16 --threads all --runs 30 --warmup 5
//
// threads=1   -> SnarkJS { singleThread: true } (all field math on this thread)
// threads=all -> SnarkJS default: one worker thread per logical CPU
// Writes one JSON line per run to results/raw/node.jsonl
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as snarkjs from "snarkjs";
import {
  ROOT, parseArgs, benchConfig, circuitFiles, readJson, phaseOf, newBatchId,
  baseRecord, appendJsonl, stagesFromLaps, printSummary,
} from "./common.mjs";

const cfg = benchConfig(parseArgs());
const F = circuitFiles(cfg.circuit);
const meta = readJson(F.meta);
const options = cfg.threads === "1" ? { singleThread: true } : {};

// S0: load inputs into memory once (the browser fetches them once too)
const tl = performance.now();
const zkeyBytes = new Uint8Array(fs.readFileSync(F.zkey));
const wasmBytes = new Uint8Array(fs.readFileSync(F.wasm));
const input = readJson(F.input);
const load_ms = performance.now() - tl;

const batch = newBatchId();
const base = baseRecord({ batch, runtime: "node", engine: "snarkjs", cfg, meta });
const total = 1 + cfg.warmup + cfg.runs;
const records = [];
const proofs = [];

for (let i = 0; i < total; i++) {
  // S2: witness generation (circom WASM calculator)
  const t0 = performance.now();
  const wtns = { type: "mem" };
  await snarkjs.wtns.calculate(input, { type: "mem", data: wasmBytes }, wtns);
  const t1 = performance.now();

  // S1, S3-S6: Groth16 prover (instrumented)
  const { proof, publicSignals } = await snarkjs.groth16.prove({ type: "mem", data: zkeyBytes }, wtns, undefined, options);
  const t2 = performance.now();

  const st = globalThis.__zkbStages;
  if (!st || st.list.length === 0) throw new Error("No stage timings: run `npm run instrument` first");

  proofs.push({ proof, pub: publicSignals });
  const rec = {
    ...base,
    iter: i,
    phase: phaseOf(i, cfg.warmup),
    nthreads: cfg.threads === "1" ? 1 : globalThis.curve_bn128?.tm?.concurrency ?? os.cpus().length,
    load_ms: i === 0 ? load_ms : 0,
    witness_ms: t1 - t0,
    prove_ms: t2 - t1,
    total_ms: t2 - t0,
    stages: stagesFromLaps(st.list),
    bytes: { ...st.bytes },
    node_version: process.version,
  };
  records.push(rec);
  console.log(`[node ${cfg.circuit} t=${cfg.threads}] ${rec.phase} ${i}/${total - 1}  witness ${rec.witness_ms.toFixed(1)} ms  prove ${rec.prove_ms.toFixed(1)} ms`);
}

const vkey = readJson(F.vkey);
for (let i = 0; i < records.length; i++) {
  records[i].verified = await snarkjs.groth16.verify(vkey, proofs[i].pub, proofs[i].proof);
}
// Peak resident memory of this whole process (main + worker threads), in KB
const peak = process.resourceUsage().maxRSS;
for (const r of records) r.peak_rss_kb = peak;

appendJsonl(path.join(ROOT, "results/raw/node.jsonl"), records);
printSummary(`node ${cfg.circuit} threads=${cfg.threads}`, records);
process.exit(process.exitCode ?? 0); // SnarkJS keeps worker threads alive; exit explicitly
