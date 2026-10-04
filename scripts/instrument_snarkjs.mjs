#!/usr/bin/env node
// Instrument SnarkJS's Groth16 prover with per-stage timers.
//
// Patches two copies of the same code inside node_modules/snarkjs:
//   src/groth16_prove.js + src/curves.js  -> used by Node   (import "snarkjs")
//   build/snarkjs.js                      -> used by Chrome (importScripts in the worker)
//
// After each prove() call, globalThis.__zkbStages holds:
//   list:  [[stageName, milliseconds], ...] in execution order
//   bytes: { "zkey_sec5": byteLength, ... }  sizes of every section read (bridging volume)
//
// It also caches the single-thread curve. Stock SnarkJS rebuilds the whole BN254
// WASM engine on every prove() when { singleThread: true } is passed, which would
// add a fixed start-up cost to every 1-thread run.
//
// Runs automatically after `npm install` (postinstall). Safe to run twice.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNARKJS = path.join(ROOT, "node_modules", "snarkjs");
const MARK = "/*ZKBENCH-INSTRUMENTED*/";
const EXPECTED_LAPS = 16; // 7 section reads + buildABC + fft + joinABC + 5 MSMs + finalize

function helpers(indent) {
  return [
    `${indent}${MARK}`,
    `${indent}function zkbState() { if (!globalThis.__zkbStages) globalThis.__zkbStages = { list: [], bytes: {}, t: 0 }; return globalThis.__zkbStages; }`,
    `${indent}function zkbStart() { const s = zkbState(); s.list = []; s.bytes = {}; s.t = performance.now(); }`,
    `${indent}function zkbLap(name) { const s = zkbState(); const now = performance.now(); s.list.push([name, now - s.t]); s.t = now; }`,
    `${indent}function zkbBytes(name, buf) { zkbState().bytes[name] = (buf && buf.byteLength) || 0; }`,
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
  let laps = 0;
  for (let i = start; i <= end; i++) {
    const line = lines[i];
    const ind = line.match(/^\s*/)[0];
    if (/^\s*return \{\s*proof\s*,\s*publicSignals\s*\}\s*;/.test(line)) {
      body.push(`${ind}zkbLap("S6_finalize");`);
      laps++;
    }
    body.push(line);
    if (i === start) { body.push(`${indent}    zkbStart();`); continue; }
    let m;
    if ((m = line.match(/const (\w+) = await [\w$.]*readSection[\w$]*\(fd(ZKey|Wtns), sections(?:ZKey|Wtns), (\d+)\);/))) {
      const tag = `${m[2].toLowerCase()}_sec${m[3]}`;
      body.push(`${ind}zkbBytes("${tag}", ${m[1]}); zkbLap("S1_read_${tag}");`);
      laps++;
    } else if (/= await buildABC1[\w$]*\(/.test(line)) {
      body.push(`${ind}zkbLap("S3_buildABC");`); laps++;
    } else if (/"FFT_C"\);\s*$/.test(line)) {
      body.push(`${ind}zkbLap("S4_fft");`); laps++;
    } else if (/= await joinABC[\w$]*\(/.test(line)) {
      body.push(`${ind}zkbLap("S3_joinABC");`); laps++;
    } else if ((m = line.match(/multiExpAffine\(.*"multiexp (\w+)"\);\s*$/))) {
      body.push(`${ind}zkbLap("S5_msm_${m[1]}");`); laps++;
    }
  }
  if (laps !== EXPECTED_LAPS) {
    throw new Error(`${label}: inserted ${laps} timers, expected ${EXPECTED_LAPS}. SnarkJS version changed?`);
  }
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
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(MARK) || src.includes("__zkbBn128ST")) {
    console.log(`[skip]  snarkjs/${rel} (already instrumented)`);
    return;
  }
  fs.writeFileSync(file + ".orig", src);
  const notes = [];
  if (doProve) { src = instrumentProve(src, rel); notes.push(`${EXPECTED_LAPS} stage timers`); }
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
