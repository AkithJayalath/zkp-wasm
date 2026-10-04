// Shared helpers for the three benchmark runners.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --key value pairs -> object
export function parseArgs(argv = process.argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    a[key] = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
  }
  return a;
}

export function benchConfig(args) {
  if (!args.circuit) throw new Error("--circuit <name> is required (e.g. c1_16)");
  const threads = args.threads || "all";
  if (!["1", "all"].includes(threads)) throw new Error("--threads must be 1 or all");
  return {
    circuit: args.circuit,
    threads,
    runs: Number(args.runs ?? 30),
    warmup: Number(args.warmup ?? 5),
  };
}

export function circuitFiles(name) {
  const dir = path.join(ROOT, "build", name);
  return {
    dir,
    wasm: path.join(dir, `${name}_js`, `${name}.wasm`),
    witnessBin: path.join(dir, `${name}_cpp`, name),
    zkey: path.join(dir, `${name}.zkey`),
    vkey: path.join(dir, "vkey.json"),
    input: path.join(dir, "input.json"),
    meta: path.join(dir, "meta.json"),
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Iteration 0 is the cold run, then `warmup` discarded runs, then measured runs.
export function phaseOf(i, warmup) {
  return i === 0 ? "cold" : i <= warmup ? "warmup" : "warm";
}

export function newBatchId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// Sum laps with the same name ([[name, ms], ...] -> {name: ms})
export function stagesFromLaps(list) {
  const out = {};
  for (const [name, ms] of list) out[name] = (out[name] || 0) + ms;
  return out;
}

export function baseRecord({ batch, runtime, engine, cfg, meta }) {
  return {
    schema: 1,
    batch,
    runtime,
    engine,
    circuit: cfg.circuit,
    k: meta.domainPower,
    constraints: meta.nConstraints,
    domain: meta.domain,
    threads: cfg.threads,
    host: os.hostname(),
    cpu: os.cpus()[0]?.model,
    logical_cpus: os.cpus().length,
  };
}

export function appendJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function printSummary(label, records) {
  const warm = records.filter((r) => r.phase === "warm");
  const ok = records.every((r) => r.verified === true);
  console.log(
    `${label}: ${warm.length} warm runs | median total ${median(warm.map((r) => r.total_ms)).toFixed(1)} ms` +
      ` | median prove ${median(warm.map((r) => r.prove_ms)).toFixed(1)} ms | all proofs verified: ${ok}`
  );
  if (!ok) process.exitCode = 1;
}
