#!/usr/bin/env node
// N1: native runtime. C++ witness generator + patched Rapidsnark, one process each per run.
//
//   node runner/native_bench.mjs --circuit c1_16 --threads all --runs 30 --warmup 5
//
// Optional: PIN_CORE=2 pins both processes to logical CPU 2 (taskset).
// Writes one JSON line per run to results/raw/native.jsonl
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as snarkjs from "snarkjs";
import {
  ROOT, parseArgs, benchConfig, circuitFiles, readJson, phaseOf, newBatchId,
  baseRecord, appendJsonl, printSummary,
} from "./common.mjs";

const cfg = benchConfig(parseArgs());
const F = circuitFiles(cfg.circuit);
const meta = readJson(F.meta);
const PROVER = path.join(ROOT, "tools/rapidsnark/package/bin/prover");
if (!fs.existsSync(PROVER)) throw new Error(`Rapidsnark not found at ${PROVER}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zkb-native-"));
const env = { ...process.env, RAPIDSNARK_STAGES: "1" };
if (cfg.threads === "1") {
  env.RAPIDSNARK_THREADS = "1";
  env.OMP_NUM_THREADS = "1";
} else {
  delete env.RAPIDSNARK_THREADS;
  delete env.OMP_NUM_THREADS;
}
const pin = process.env.PIN_CORE ? ["taskset", "-c", process.env.PIN_CORE] : [];

function timed(argv) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(argv[0], argv.slice(1), { env, encoding: "utf8", maxBuffer: 64 << 20 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.error) throw new Error(`could not start ${argv[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${argv.join(" ")}\nexit ${r.status}\n${r.stderr}`);
  return { ms, stderr: r.stderr || "" };
}

const batch = newBatchId();
const base = baseRecord({ batch, runtime: "native", engine: "rapidsnark", cfg, meta });
const total = 1 + cfg.warmup + cfg.runs;
const records = [];
const proofs = [];

for (let i = 0; i < total; i++) {
  const wtns = path.join(tmp, "witness.wtns");
  const proofFile = path.join(tmp, "proof.json");
  const publicFile = path.join(tmp, "public.json");

  // S2: witness generation (C++)
  const w = timed([...pin, F.witnessBin, F.input, wtns]);

  // S0-S6: Rapidsnark prover process, wrapped in GNU time for peak memory
  const p = timed(["/usr/bin/time", "-f", "ZKB_MAXRSS_KB=%M", ...pin, PROVER, F.zkey, wtns, proofFile, publicFile]);

  const stages = {};
  for (const m of p.stderr.matchAll(/^STAGE\t(\S+)\t([\d.]+)$/gm)) stages[m[1]] = Number(m[2]);
  if (!("S5_msm_H" in stages)) throw new Error("No STAGE lines from Rapidsnark: is it the patched build?");
  const rss = p.stderr.match(/ZKB_MAXRSS_KB=(\d+)/);

  proofs.push({ proof: readJson(proofFile), pub: readJson(publicFile) });
  const rec = {
    ...base,
    iter: i,
    phase: phaseOf(i, cfg.warmup),
    nthreads: cfg.threads === "1" ? 1 : os.cpus().length,
    witness_ms: w.ms,
    prove_ms: p.ms,
    total_ms: w.ms + p.ms,
    stages,
    peak_rss_kb: rss ? Number(rss[1]) : null,
    pinned_core: process.env.PIN_CORE ?? null,
  };
  records.push(rec);
  console.log(`[native ${cfg.circuit} t=${cfg.threads}] ${rec.phase} ${i}/${total - 1}  witness ${w.ms.toFixed(1)} ms  prove ${p.ms.toFixed(1)} ms`);
}

// Verify every proof (after timing, so verification never competes with the prover)
const vkey = readJson(F.vkey);
for (let i = 0; i < records.length; i++) {
  records[i].verified = await snarkjs.groth16.verify(vkey, proofs[i].pub, proofs[i].proof);
}

appendJsonl(path.join(ROOT, "results/raw/native.jsonl"), records);
printSummary(`native ${cfg.circuit} threads=${cfg.threads}`, records);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
