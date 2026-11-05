// RQ3/RQ4 configurations (guide, section 6). Each maps a thread setting to the kernel
// build that is loaded and the stages that use it. B1 = stock SnarkJS.
//
// Why these builds:
//   1 thread  -> non-threaded builds (plain / wide): isolates the arithmetic technique.
//   all cores -> threaded builds where the technique needs the pool (T4.2, T3.2), or where
//                MSM must run multi-threaded for parity with multi-threaded SnarkJS (T5.x).
//                T4.1 and T3.1 stay single-threaded on all cores on purpose: that is
//                technique 1 alone; technique 2 (the pool) is T4.2 / T3.2.
//
// T5.3 / T5.4 port native MSM algorithms (batch-affine accumulation, GLV). They use the
// same builds as T5.1, so the only difference from T5.1 is the algorithm ("msm:ba",
// "msm:glv" in the stage list; see web/kernels/adapter.js).
//
// BEST_MSM is the S5 algorithm that ALL and ALL-W use. Set it at Gate 2b (runbook,
// week 4) to whichever of msm / msm:ba / msm:glv was fastest at 2^16 and 2^18 and
// passed every check, and record the choice in results/notes.md.
export const BEST_MSM = "msm:ba";

export const CONFIGS = {
  "B1":    { "1": { kernel: "",             opt: "" },            all: { kernel: "",             opt: "" } },
  "T5.1":  { "1": { kernel: "plain",        opt: "msm" },         all: { kernel: "threads",      opt: "msm" } },
  "T5.2":  { "1": { kernel: "wide",         opt: "msm" },         all: { kernel: "threads-wide", opt: "msm" } },
  "T5.3":  { "1": { kernel: "plain",        opt: "msm:ba" },      all: { kernel: "threads",      opt: "msm:ba" } },
  "T5.4":  { "1": { kernel: "plain",        opt: "msm:glv" },     all: { kernel: "threads",      opt: "msm:glv" } },
  "T4.1":  { "1": { kernel: "plain",        opt: "ntt" },         all: { kernel: "plain",        opt: "ntt" } },
  "T4.2":  {                                                      all: { kernel: "threads",      opt: "ntt" } },
  "T3.1":  { "1": { kernel: "plain",        opt: "qap" },         all: { kernel: "plain",        opt: "qap" } },
  "T3.2":  {                                                      all: { kernel: "threads",      opt: "qap" } },
  "ALL":   { "1": { kernel: "plain",        opt: `qap,ntt,${BEST_MSM}` }, all: { kernel: "threads",      opt: `qap,ntt,${BEST_MSM}` } },
  "ALL-W": { "1": { kernel: "wide",         opt: `qap,ntt,${BEST_MSM}` }, all: { kernel: "threads-wide", opt: `qap,ntt,${BEST_MSM}` } },
};

export function resolveConfig(id, threads) {
  const c = CONFIGS[id];
  if (!c) throw new Error(`unknown --config ${id}; one of ${Object.keys(CONFIGS).join(", ")}`);
  const v = c[threads];
  if (!v) throw new Error(`config ${id} is not defined for threads=${threads}`);
  return v;
}

// Wide-arithmetic WASM needs this V8 flag until Chrome enables the feature by default.
export function browserFlags(kernel) {
  return /wide/.test(kernel || "") ? ["--js-flags=--experimental-wasm-wide-arithmetic"] : [];
}
