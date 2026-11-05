#!/usr/bin/env node
// Instrument SnarkJS's Groth16 prover (v2: stage timers + kernel switches).
//
// Patches two copies of the same code inside node_modules/snarkjs:
//   src/groth16_prove.js + src/curves.js  -> used by Node   (import "snarkjs")
//   build/snarkjs.js                      -> used by Chrome (importScripts in the worker)
//
// 1. Stage timers (unchanged from v1, used for RQ1/RQ2). After each prove() call,
//    globalThis.__zkbStages holds:
//      list:  [[stageName, milliseconds], ...] in execution order
//      bytes: { "zkey_sec5": byteLength, ... }  sizes of every section read
// 2. Single-thread curve cache (unchanged from v1).
// 3. Kernel switches (new for RQ3/RQ4). If globalThis.__zkOpt = { kernel, qap, ntt, msm }
//    is set, the chosen stages call the Rust kernel instead of SnarkJS's own code:
//      qap -> kernel.buildABC(...) and kernel.joinABC(...)   (S3)
//      ntt -> kernel.cosetEval(...) for A, B and C            (S4)
//      msm -> kernel.msm("G1"|"G2", bases, scalars)           (S5, all five MSMs)
//    Without __zkOpt, the code path is stock SnarkJS (one extra property check per stage).
// 4. Debug dump (correctness checks only, never during timed runs). If globalThis.__zkDump
//    is an object, intermediate buffers are stored in it after each stage.
//
// Runs automatically after `npm install` (postinstall). Always re-patches from the
// original files saved as *.orig, so it is safe to run again after editing this script.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNARKJS = path.join(ROOT, "node_modules", "snarkjs");
const MARK = "/*ZKBENCH-INSTRUMENTED v2*/";
const EXPECTED_LAPS = 16;     // 7 section reads + buildABC + fft + joinABC + 5 MSMs + finalize
const EXPECTED_SWITCHES = 10; // buildABC + 3 coset FFTs (x3 lines each = 9, counted as 3) + joinABC + 5 MSMs

function helpers(indent) {
  return [
    `${indent}${MARK}`,
    `${indent}function zkbState() { if (!globalThis.__zkbStages) globalThis.__zkbStages = { list: [], bytes: {}, t: 0 }; return globalThis.__zkbStages; }`,
    `${indent}function zkbStart() { const s = zkbState(); s.list = []; s.bytes = {}; s.t = performance.now(); }`,
    `${indent}function zkbLap(name) { const s = zkbState(); const now = performance.now(); s.list.push([name, now - s.t]); s.t = now; }`,
    `${indent}function zkbBytes(name, buf) { zkbState().bytes[name] = (buf && buf.byteLength) || 0; }`,
    `${indent}function zkbOpt(stage) { const o = globalThis.__zkOpt; return !!(o && o.kernel && o[stage]); }`,
    `${indent}function zkbK() { return globalThis.__zkOpt.kernel; }`,
    `${indent}function zkbDump(name, v) { const d = globalThis.__zkDump; if (d) d[name] = v; }`,
    `${indent}async function zkbMsm(G, g, bases, scalars, logger, name) { return zkbOpt("msm") ? zkbK().msm(g, bases, scalars) : G.multiExpAffine(bases, scalars, logger, name); }`,
  ];
}

function instrumentProve(src, label) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^\s*(export default )?async function groth16Prove[\w$]*\s*\(/.test(l));
  if (start < 0) throw new Error(`${label}: groth16Prove() not found`);
  const indent = lines[start].match(/^\s*/)[0];
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}}`) { end = i; break; }
  }
  if (end < 0) throw new Error(`${label}: end of groth16Prove() not found`);

  const body = [];
  let laps = 0, switches = 0;
  for (let i = start; i <= end; i++) {
    const orig = lines[i];
    const ind = orig.match(/^\s*/)[0];
    let line = orig;
    const after = []; // lines to insert after this one (lap first, then dumps)
    let m;

    if (/^\s*return \{\s*proof\s*,\s*publicSignals\s*\}\s*;/.test(orig)) {
      body.push(`${ind}zkbLap("S6_finalize");`); laps++;
    }

    // ---- stage timers (decided on the ORIGINAL line) ----
    if ((m = orig.match(/const (\w+) = await [\w$.]*readSection[\w$]*\(fd(ZKey|Wtns), sections(?:ZKey|Wtns), (\d+)\);/))) {
      const tag = `${m[2].toLowerCase()}_sec${m[3]}`;
      after.push(`${ind}zkbBytes("${tag}", ${m[1]}); zkbLap("S1_read_${tag}");`); laps++;
    } else if (/= await buildABC1[\w$]*\(/.test(orig)) {
      after.push(`${ind}zkbLap("S3_buildABC");`); laps++;
    } else if (/"FFT_C"\);\s*$/.test(orig)) {
      after.push(`${ind}zkbLap("S4_fft");`); laps++;
    } else if (/= await joinABC[\w$]*\(/.test(orig)) {
      after.push(`${ind}zkbLap("S3_joinABC");`); laps++;
    } else if ((m = orig.match(/multiExpAffine\(.*"multiexp (\w+)"\);\s*$/))) {
      after.push(`${ind}zkbLap("S5_msm_${m[1]}");`); laps++;
    }

    // ---- kernel switches ----
    if ((m = orig.match(/^(\s*const \[buffA_T, buffB_T, buffC_T\] = )(await buildABC1[\w$]*\(curve, zkey, buffWitness, buffCoeffs, logger\);)\s*$/))) {
      line = `${m[1]}zkbOpt("qap") ? await zkbK().buildABC(zkey, buffWitness, buffCoeffs) : ${m[2]}`; switches++;
      after.push(`${ind}zkbDump("A_T", buffA_T); zkbDump("B_T", buffB_T); zkbDump("C_T", buffC_T);`);
    } else if ((m = orig.match(/^(\s*const buff[ABC](?:odd)? = )(await Fr\.(?:ifft|batchApplyKey)\(.*\);)\s*$/))) {
      line = `${m[1]}zkbOpt("ntt") ? null : ${m[2]}`;
    } else if ((m = orig.match(/^(\s*const buff([ABC])odd_T = )(await Fr\.fft\(.*\);)\s*$/))) {
      line = `${m[1]}zkbOpt("ntt") ? await zkbK().cosetEval(buff${m[2]}_T) : ${m[3]}`; switches++;
      after.push(`${ind}zkbDump("${m[2]}odd_T", buff${m[2]}odd_T);`);
    } else if ((m = orig.match(/^(\s*const buffPodd_T = )(await joinABC[\w$]*\(curve, zkey, buffAodd_T, buffBodd_T, buffCodd_T, logger\);)\s*$/))) {
      line = `${m[1]}zkbOpt("qap") ? await zkbK().joinABC(buffAodd_T, buffBodd_T, buffCodd_T) : ${m[2]}`; switches++;
      after.push(`${ind}zkbDump("Podd_T", buffPodd_T);`);
    } else if ((m = orig.match(/^(\s*)(proof\.pi_a|let pib1|proof\.pi_b|proof\.pi_c|const resH) = await curve\.(G1|G2)\.multiExpAffine\((.*)\);\s*$/))) {
      line = `${m[1]}${m[2]} = await zkbMsm(curve.${m[3]}, "${m[3]}", ${m[4]});`; switches++;
      const v = m[2].replace(/^(let|const) /, "");
      after.push(`${ind}zkbDump("msm_${orig.match(/"multiexp (\w+)"/)[1]}", ${v});`);
    }

    body.push(line);
    if (i === start) { body.push(`${indent}    zkbStart();`); continue; }
    // the lap must come first so dump bookkeeping is never inside a timed stage
    body.push(...after);
  }
  if (laps !== EXPECTED_LAPS) throw new Error(`${label}: inserted ${laps} timers, expected ${EXPECTED_LAPS}. SnarkJS version changed?`);
  if (switches !== EXPECTED_SWITCHES) throw new Error(`${label}: inserted ${switches} kernel switches, expected ${EXPECTED_SWITCHES}. SnarkJS version changed?`);
  return [...lines.slice(0, start), ...helpers(indent), ...body, ...lines.slice(end + 1)].join("\n");
}

function cacheSingleThreadCurve(src, label) {
  let n = 0;
  const out = src.replace(/curve = await (buildBn128[\w$]*)\(singleThread\);/g, (_, fn) => {
    n++;
    return `curve = singleThread ? (globalThis.__zkbBn128ST || (globalThis.__zkbBn128ST = await ${fn}(true))) : await ${fn}(singleThread);`;
  });
  if (n === 0) throw new Error(`${label}: getCurve buildBn128(singleThread) call not found`);
  return [out, n];
}

function patchFile(rel, doProve, doCurves) {
  const file = path.join(SNARKJS, rel);
  const orig = file + ".orig";
  if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);   // first run: keep the pristine file
  let src = fs.readFileSync(orig, "utf8");
  const notes = [];
  if (doProve) { src = instrumentProve(src, rel); notes.push(`${EXPECTED_LAPS} stage timers, ${EXPECTED_SWITCHES} kernel switches`); }
  if (doCurves) { let n; [src, n] = cacheSingleThreadCurve(src, rel); notes.push(`${n} curve cache edits`); }
  if (!doProve) src = `${MARK}\n${src}`;
  fs.writeFileSync(file, src);
  execFileSync(process.execPath, ["--check", file]); // syntax check
  console.log(`[ok]    snarkjs/${rel} (${notes.join(", ")})`);
}

if (!fs.existsSync(SNARKJS)) {
  console.log("snarkjs not installed yet; run `npm install` first");
  process.exit(0);
}
const version = JSON.parse(fs.readFileSync(path.join(SNARKJS, "package.json"), "utf8")).version;
console.log(`Instrumenting snarkjs ${version}`);
patchFile("src/groth16_prove.js", true, false);
patchFile("src/curves.js", false, true);
patchFile("build/snarkjs.js", true, true);
console.log("Done.");
