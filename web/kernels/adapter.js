// Loads one kernel build (web/kernels/<build>/) and wraps it in the interface the
// patched SnarkJS calls through globalThis.__zkOpt.kernel (see scripts/instrument_snarkjs.mjs).
//
// Used in the browser worker (dynamic import) and in Node (scripts/check_kernels.mjs).
//
//   const kernel = await loadKernel("threads", { threads: 4 });
//   globalThis.__zkOpt = optFlags(kernel, "qap,ntt,msm:ba");
//
// Stage list ("opt"): qap, ntt, msm. The MSM algorithm is chosen with a suffix:
//   msm      arkworks Pippenger with signed digits      (T5.1, T5.2)
//   msm:ba   batch-affine bucket accumulation           (T5.3)
//   msm:glv  batch-affine + GLV endomorphism            (T5.4)
//
// SnarkJS sometimes hands over a BigBuffer (paged buffer) instead of a Uint8Array.
// toU8() copies it into one contiguous array; that copy, and the copy of every input
// into WASM memory done by the wasm-bindgen glue, happen inside the stage's timer.

const MSM_ALGO = { ark: 0, ba: 1, glv: 2 };

export function optFlags(kernel, opt) {
  if (!kernel) return undefined;
  const on = (opt || "").split(",").map((t) => t.trim()).filter(Boolean);
  const m = on.find((t) => t === "msm" || t.startsWith("msm:"));
  const msmAlgo = m && m.includes(":") ? m.split(":")[1] : "ark";
  if (!(msmAlgo in MSM_ALGO)) throw new Error(`unknown MSM algorithm "${msmAlgo}" (use msm, msm:ba or msm:glv)`);
  return { kernel, qap: on.includes("qap"), ntt: on.includes("ntt"), msm: !!m, msmAlgo };
}

export async function loadKernel(build, { threads = 1, wasmBytes } = {}) {
  const mod = await import(new URL(`./${build}/zkp_kernels.js`, import.meta.url).href);
  const wasm = await mod.default(wasmBytes ? { module_or_path: wasmBytes } : undefined);
  if (typeof mod.initThreadPool === "function") await mod.initThreadPool(threads);

  const toU8 = (b) => (b instanceof Uint8Array ? b : b.slice(0, b.byteLength));

  return {
    build,
    info: mod.build_info(),
    threads: mod.kernel_threads(),
    memoryBytes: () => wasm.memory.buffer.byteLength,

    // S3: returns [A, B, C] in SnarkJS's raw Montgomery layout
    buildABC(zkey, witness, coeffs) {
      const n = zkey.domainSize * 32;
      const out = mod.build_abc(toU8(coeffs), toU8(witness), zkey.domainSize);
      return [out.subarray(0, n), out.subarray(n, 2 * n), out.subarray(2 * n, 3 * n)];
    },
    // S3: P = A*B - C, standard form (scalars for the H MSM)
    joinABC(a, b, c) {
      return mod.join_abc(toU8(a), toU8(b), toU8(c));
    },
    // S4: ifft, coset shift, fft for one of A, B, C
    cosetEval(evals) {
      return mod.coset_eval(toU8(evals));
    },
    // S5: returns a Jacobian point (96 bytes for G1, 192 for G2), raw Montgomery.
    // The algorithm comes from globalThis.__zkOpt.msmAlgo (set by optFlags).
    msm(group, bases, scalars) {
      const o = globalThis.__zkOpt;
      const algo = MSM_ALGO[(o && o.msmAlgo) || "ark"];
      return group === "G1" ? mod.msm_g1(toU8(bases), toU8(scalars), algo) : mod.msm_g2(toU8(bases), toU8(scalars), algo);
    },

    // per-operation microbenchmark (returns a checksum; time it from the caller)
    micro: { fr_mul: (n) => mod.micro_fr_mul(n), g1_add: (n) => mod.micro_g1_add(n) },
  };
}
