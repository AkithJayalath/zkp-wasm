/* B1: SnarkJS in the browser, inside a dedicated Web Worker (classic worker script). */
/* global snarkjs */
importScripts("/node_modules/snarkjs/build/snarkjs.js"); // the instrumented bundle

const post = (type, data) => self.postMessage({ type, ...data });

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
function stagesFromLaps(list) {
  const out = {};
  for (const [name, ms] of list) out[name] = (out[name] || 0) + ms;
  return out;
}

self.onmessage = async (ev) => {
  try {
    const cfg = ev.data;
    const name = cfg.circuit;
    const base = `/build/${name}`;
    const options = cfg.threads === "1" ? { singleThread: true } : {};

    // S0 part 2: download proving key, witness WASM, input, verification key
    const tl = performance.now();
    const [zkeyBytes, wasmBytes, input, vkey, meta] = await Promise.all([
      fetchBytes(`${base}/${name}.zkey`),
      fetchBytes(`${base}/${name}_js/${name}.wasm`),
      fetchJson(`${base}/input.json`),
      fetchJson(`${base}/vkey.json`),
      fetchJson(`${base}/meta.json`),
    ]);
    const load_ms = performance.now() - tl;
    post("progress", { msg: `fetched zkey (${(zkeyBytes.byteLength / 1048576).toFixed(1)} MB) + wasm in ${load_ms.toFixed(1)} ms` });

    const total = 1 + cfg.warmup + cfg.runs;
    const records = [];
    const proofs = [];
    for (let i = 0; i < total; i++) {
      const phase = i === 0 ? "cold" : i <= cfg.warmup ? "warmup" : "warm";

      const t0 = performance.now();
      const wtns = { type: "mem" };
      await snarkjs.wtns.calculate(input, { type: "mem", data: wasmBytes }, wtns);
      const t1 = performance.now();
      const { proof, publicSignals } = await snarkjs.groth16.prove({ type: "mem", data: zkeyBytes }, wtns, undefined, options);
      const t2 = performance.now();

      const st = self.__zkbStages;
      if (!st || st.list.length === 0) throw new Error("No stage timings: run `npm run instrument` first");
      proofs.push({ proof, pub: publicSignals });
      records.push({
        circuit: name,
        k: meta.domainPower,
        constraints: meta.nConstraints,
        domain: meta.domain,
        threads: cfg.threads,
        iter: i,
        phase,
        nthreads: cfg.threads === "1" ? 1 : (self.curve_bn128 && self.curve_bn128.tm.concurrency) || navigator.hardwareConcurrency,
        load_ms: i === 0 ? load_ms : 0,
        witness_ms: t1 - t0,
        prove_ms: t2 - t1,
        total_ms: t2 - t0,
        stages: stagesFromLaps(st.list),
        bytes: { ...st.bytes },
        cross_origin_isolated: self.crossOriginIsolated,
      });
      post("progress", { msg: `${phase} ${i}/${total - 1}  witness ${(t1 - t0).toFixed(1)} ms  prove ${(t2 - t1).toFixed(1)} ms` });
    }

    // Verify every proof after timing
    for (let i = 0; i < records.length; i++) {
      records[i].verified = await snarkjs.groth16.verify(vkey, proofs[i].pub, proofs[i].proof);
    }
    post("done", { records });
  } catch (e) {
    post("error", { message: String((e && e.stack) || e) });
  }
};

post("ready", {});
