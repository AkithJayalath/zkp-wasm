/* SnarkJS in the browser, inside a dedicated Web Worker (classic worker script).
 *
 * Modes (from the page URL, see bench_page.js):
 *   bench  (default)  time 1 cold + warmup + runs proofs, optionally with Rust kernels
 *   check             prove once with stock SnarkJS and once with kernels; compare outputs
 *   micro             per-operation microbenchmark of one or more kernel builds
 *
 * Kernels: cfg.kernel = build name under /web/kernels/ (plain, wide, threads, threads-wide, simd)
 *          cfg.opt    = stages that use the kernel, e.g. "msm", "msm:ba" or "qap,ntt,msm:glv"
 *                       (msm = arkworks, msm:ba = batch-affine T5.3, msm:glv = + GLV T5.4)
 * With no kernel this is exactly the B1 baseline used for RQ1/RQ2.
 */
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
const poolSize = (threads) => (threads === "1" ? 1 : navigator.hardwareConcurrency);

// Load a kernel build. The time includes download, compile and (threaded builds)
// starting the worker pool; it is reported once, on the cold run.
async function loadKernelBuild(build, threads) {
  const t = performance.now();
  const { loadKernel, optFlags: of } = await import("/web/kernels/adapter.js");
  optFlagsFn = of;
  const kernel = await loadKernel(build, { threads: poolSize(threads) });
  return { kernel, ms: performance.now() - t };
}

let optFlagsFn = null;
function optFlags(cfg, kernel) {
  return kernel ? optFlagsFn(kernel, cfg.opt) : undefined;
}

async function loadCircuit(name) {
  const base = `/build/${name}`;
  const tl = performance.now();
  const [zkeyBytes, wasmBytes, input, vkey, meta] = await Promise.all([
    fetchBytes(`${base}/${name}.zkey`),
    fetchBytes(`${base}/${name}_js/${name}.wasm`),
    fetchJson(`${base}/input.json`),
    fetchJson(`${base}/vkey.json`),
    fetchJson(`${base}/meta.json`),
  ]);
  return { zkeyBytes, wasmBytes, input, vkey, meta, load_ms: performance.now() - tl };
}

async function proveOnce(c, options) {
  const t0 = performance.now();
  const wtns = { type: "mem" };
  await snarkjs.wtns.calculate(c.input, { type: "mem", data: c.wasmBytes }, wtns);
  const t1 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove({ type: "mem", data: c.zkeyBytes }, wtns, undefined, options);
  const t2 = performance.now();
  return { proof, publicSignals, witness_ms: t1 - t0, prove_ms: t2 - t1, total_ms: t2 - t0 };
}

// ---------------------------------------------------------------------------
async function runBench(cfg) {
  const c = await loadCircuit(cfg.circuit);
  post("progress", { msg: `fetched zkey (${(c.zkeyBytes.byteLength / 1048576).toFixed(1)} MB) + wasm in ${c.load_ms.toFixed(1)} ms` });
  const options = cfg.threads === "1" ? { singleThread: true } : {};

  let kernel = null, kernelLoadMs = 0;
  if (cfg.kernel) {
    ({ kernel, ms: kernelLoadMs } = await loadKernelBuild(cfg.kernel, cfg.threads));
    post("progress", { msg: `kernel ${cfg.kernel} (${kernel.info}, ${kernel.threads} thread(s)) loaded in ${kernelLoadMs.toFixed(1)} ms; stages: ${cfg.opt}` });
  }
  self.__zkOpt = optFlags(cfg, kernel);

  const total = 1 + cfg.warmup + cfg.runs;
  const records = [], proofs = [];
  for (let i = 0; i < total; i++) {
    const phase = i === 0 ? "cold" : i <= cfg.warmup ? "warmup" : "warm";
    const r = await proveOnce(c, options);
    const st = self.__zkbStages;
    if (!st || st.list.length === 0) throw new Error("No stage timings: run `npm run instrument` first");
    proofs.push({ proof: r.proof, pub: r.publicSignals });
    records.push({
      circuit: cfg.circuit,
      k: c.meta.domainPower,
      constraints: c.meta.nConstraints,
      domain: c.meta.domain,
      threads: cfg.threads,
      iter: i,
      phase,
      nthreads: cfg.threads === "1" ? 1 : (self.curve_bn128 && self.curve_bn128.tm.concurrency) || navigator.hardwareConcurrency,
      opt: cfg.kernel ? cfg.opt : "",
      kernel_build: cfg.kernel || "",
      kernel_info: kernel ? kernel.info : "",
      kernel_threads: kernel ? kernel.threads : 0,
      kernel_load_ms: i === 0 ? kernelLoadMs : 0,
      kernel_mem_bytes: kernel ? kernel.memoryBytes() : 0,
      load_ms: i === 0 ? c.load_ms : 0,
      witness_ms: r.witness_ms,
      prove_ms: r.prove_ms,
      total_ms: r.total_ms,
      stages: stagesFromLaps(st.list),
      bytes: { ...st.bytes },
      cross_origin_isolated: self.crossOriginIsolated,
    });
    post("progress", { msg: `${phase} ${i}/${total - 1}  witness ${r.witness_ms.toFixed(1)} ms  prove ${r.prove_ms.toFixed(1)} ms` });
  }
  self.__zkOpt = undefined;

  // Verify every proof after timing, with the unmodified verifier
  for (let i = 0; i < records.length; i++) {
    records[i].verified = await snarkjs.groth16.verify(c.vkey, proofs[i].pub, proofs[i].proof);
  }
  return { records };
}

// ---------------------------------------------------------------------------
async function runCheck(cfg) {
  const c = await loadCircuit(cfg.circuit);
  const options = cfg.threads === "1" ? { singleThread: true } : {};
  const { kernel } = await loadKernelBuild(cfg.kernel, cfg.threads);

  const once = async (useKernel) => {
    self.__zkDump = {};
    self.__zkOpt = useKernel ? optFlags(cfg, kernel) : undefined;
    const r = await proveOnce(c, options);
    const dump = self.__zkDump;
    self.__zkDump = undefined;
    self.__zkOpt = undefined;
    return { ...r, dump };
  };
  const base = await once(false);
  const kern = await once(true);

  const curve = self.curve_bn128 || self.__zkbBn128ST;
  const u8 = (b) => (b instanceof Uint8Array ? b : b.slice(0, b.byteLength));
  const same = (a, b) => { const x = u8(a), y = u8(b); if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
  const checks = [];
  for (const k of ["A_T", "B_T", "C_T", "Aodd_T", "Bodd_T", "Codd_T", "Podd_T"]) checks.push([`${k} byte-identical`, same(base.dump[k], kern.dump[k])]);
  for (const [k, G] of [["msm_A", curve.G1], ["msm_B1", curve.G1], ["msm_B2", curve.G2], ["msm_C", curve.G1], ["msm_H", curve.G1]]) checks.push([`${k} same point`, G.eq(u8(base.dump[k]), u8(kern.dump[k]))]);
  checks.push(["proof verifies", await snarkjs.groth16.verify(c.vkey, kern.publicSignals, kern.proof)]);
  checks.push(["public signals equal", JSON.stringify(kern.publicSignals) === JSON.stringify(base.publicSignals)]);
  return { check: { circuit: cfg.circuit, kernel: cfg.kernel, kernel_info: kernel.info, kernel_threads: kernel.threads, opt: cfg.opt, threads: cfg.threads, checks, ok: checks.every((x) => x[1]) } };
}

// ---------------------------------------------------------------------------
async function runMicro(cfg) {
  const builds = (cfg.builds || "plain,wide,simd").split(",");
  const iters = Number(cfg.iters || 10000000);
  const reps = Number(cfg.reps || 10);
  const records = [];
  for (const b of builds) {
    let kernel;
    try { ({ kernel } = await loadKernelBuild(b, "1")); }
    catch (e) { post("progress", { msg: `build ${b} could not be loaded: ${e.message}` }); records.push({ build: b, error: String(e.message) }); continue; }
    for (let rep = 0; rep < reps; rep++) {
      for (const op of ["fr_mul", "g1_add"]) {
        const n = op === "g1_add" ? Math.floor(iters / 10) : iters;
        const t = performance.now();
        const chk = kernel.micro[op](n);
        const ms = performance.now() - t;
        records.push({ runtime: "chrome", build: b, info: kernel.info, op, rep, iters: n, ns_per_op: (ms * 1e6) / n, check: String(chk) });
      }
    }
    post("progress", { msg: `micro ${b} done` });
  }
  return { records };
}

self.onmessage = async (ev) => {
  try {
    const cfg = ev.data;
    const mode = cfg.mode || "bench";
    const out = mode === "check" ? await runCheck(cfg) : mode === "micro" ? await runMicro(cfg) : await runBench(cfg);
    post("done", out);
  } catch (e) {
    post("error", { message: String((e && e.stack) || e) });
  }
};

post("ready", {});
