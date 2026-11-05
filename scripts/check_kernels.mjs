#!/usr/bin/env node
// Correctness check for the Rust kernels, in Node (non-threaded builds: plain, wide*, simd).
// The browser version of the same check (all builds, including threads) is
// web/bench.html?check=1, driven by runner/chrome_check.mjs.
//
//   node scripts/check_kernels.mjs --circuit c1_12 --build plain [--opt qap,ntt,msm]
//   node scripts/check_kernels.mjs --circuit c1_12 --build plain --opt msm:ba     (T5.3)
//   node scripts/check_kernels.mjs --circuit c1_12 --build plain --opt msm:glv    (T5.4)
//
// 1. Proves once with stock SnarkJS and once with the chosen kernels switched on,
//    capturing every intermediate buffer (globalThis.__zkDump).
// 2. S3 and S4 outputs (A_T, B_T, C_T, Aodd_T, Bodd_T, Codd_T, Podd_T) must be
//    byte-identical. MSM results must be the same curve point (Jacobian coordinates
//    are not unique, so points are compared, not bytes).
// 3. The kernel proof must verify with the unmodified verifier, with the same public signals.
// (*) Node 22's V8 cannot run wide-arithmetic WASM; check those builds in Chrome.
import fs from "node:fs";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { buildBn128 } from "ffjavascript";
import { ROOT, parseArgs, circuitFiles, readJson } from "../runner/common.mjs";
import { loadKernel, optFlags } from "../web/kernels/adapter.js";

const args = parseArgs();
const circuit = args.circuit || "c1_12";
const build = args.build || "plain";
const optStr = args.opt || "qap,ntt,msm";
const opt = optStr.split(",");
const f = circuitFiles(circuit);

const wasmBytes = fs.readFileSync(path.join(ROOT, "web/kernels", build, "zkp_kernels_bg.wasm"));
const kernel = await loadKernel(build, { wasmBytes });
console.log(`kernel build=${build} (${kernel.info}), stages on: ${opt.join(", ")}, circuit ${circuit}`);

async function prove(useKernel) {
  globalThis.__zkDump = {};
  globalThis.__zkOpt = useKernel ? optFlags(kernel, optStr) : undefined;
  const res = await snarkjs.groth16.prove(f.zkey, f.witness ?? path.join(f.dir, "witness.wtns"));
  const dump = globalThis.__zkDump;
  globalThis.__zkDump = undefined;
  globalThis.__zkOpt = undefined;
  return { ...res, dump };
}

const toU8 = (b) => (b instanceof Uint8Array ? b : b.slice(0, b.byteLength));
const sameBytes = (a, b) => {
  const x = toU8(a), y = toU8(b);
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false;
  return true;
};

const base = await prove(false);
const kern = await prove(true);
const curve = await buildBn128(true);
const vkey = readJson(f.vkey);

let ok = true;
const report = (name, pass, note = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`);
  if (!pass) ok = false;
};

for (const k of ["A_T", "B_T", "C_T", "Aodd_T", "Bodd_T", "Codd_T", "Podd_T"]) {
  report(`${k.padEnd(7)} byte-identical`, sameBytes(base.dump[k], kern.dump[k]), `(${toU8(kern.dump[k]).byteLength} bytes)`);
}
for (const [k, G] of [["msm_A", curve.G1], ["msm_B1", curve.G1], ["msm_B2", curve.G2], ["msm_C", curve.G1], ["msm_H", curve.G1]]) {
  report(`${k.padEnd(7)} same point`, G.eq(toU8(base.dump[k]), toU8(kern.dump[k])));
}
report("proof verifies (unmodified verifier)", await snarkjs.groth16.verify(vkey, kern.publicSignals, kern.proof));
report("public signals equal baseline", JSON.stringify(kern.publicSignals) === JSON.stringify(base.publicSignals));

await curve.terminate();
console.log(ok ? `ALL CHECKS PASSED (${build}, ${optStr}, ${circuit})` : `CHECK FAILED (${build}, ${optStr}, ${circuit})`);
process.exit(ok ? 0 : 1);
