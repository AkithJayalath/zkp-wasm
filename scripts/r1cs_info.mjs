#!/usr/bin/env node
// Print circuit size facts as JSON:  node scripts/r1cs_info.mjs build/c1_16/c1_16.r1cs
// domainPower uses SnarkJS's own rule (zkey_new.js):
//   2^power >= nConstraints + nPubInputs + nOutputs + 1
import * as snarkjs from "snarkjs";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/r1cs_info.mjs <file.r1cs>"); process.exit(2); }

const cir = await snarkjs.r1cs.info(file);
const need = cir.nConstraints + cir.nPubInputs + cir.nOutputs + 1;
let power = 0;
while (2 ** power < need) power++;

console.log(JSON.stringify({
  nConstraints: cir.nConstraints,
  nPubInputs: cir.nPubInputs,
  nPrvInputs: cir.nPrvInputs,
  nOutputs: cir.nOutputs,
  nVars: cir.nVars,
  domainPower: power,
  domain: 2 ** power,
}));
process.exit(0); // SnarkJS leaves worker threads open; exit explicitly
