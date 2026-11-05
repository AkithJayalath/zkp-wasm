# zkp-wasm-overhead

Measures how much slower Groth16 proof generation is in the browser (SnarkJS, WASM)
than natively (Rapidsnark, C++), and which pipeline stage causes the gap.
Answers RQ1 (overhead factor) and RQ2 (stage breakdown), and RQ3/RQ4 (optimising S3–S5
with Rust kernels compiled to WebAssembly, alone and combined).

Follow the runbook doc day by day. Quick reference:

| Step | Command |
| --- | --- |
| Install JS packages (also instruments SnarkJS) | `npm install` |
| Patch + build Rapidsnark | `python3 scripts/patch_rapidsnark.py tools/rapidsnark && (cd tools/rapidsnark && make host)` |
| Stable CPU for timing | `sudo bash scripts/bench_mode_on.sh` |
| Build one circuit | `bash scripts/build_circuit.sh multiplier circuits/multiplier.circom '{"a":"3","b":"11"}'` |
| Build all C1 sizes | `bash scripts/build_c1.sh` |
| Run benchmarks | `bash scripts/run_rq1.sh native node` / `bash scripts/run_rq1.sh chrome` |
| One configuration | `node runner/<native|node|chrome>_bench.mjs --circuit c1_16 --threads all --runs 30 --warmup 5` |
| Tables + figures | `python analysis/analyze.py` |
| Record the machine | `bash scripts/env_snapshot.sh` |

Layout: `circuits/` sources · `scripts/` build and setup · `runner/` the three runtimes ·
`web/` browser page, worker and server · `analysis/` statistics and figures ·
`results/raw/` one JSON line per run · `results/summary/` CSV tables · `results/figures/` PNG + PDF.

Pipeline stages recorded for every run:
S0–S1 load and data bridging · S2 witness generation · S3 QAP construction ·
S4 FFT/NTT · S5 multi-scalar multiplication (MSM) · S6 finalize and output.

## RQ3 and RQ4 (runbook 2)

The optimised prover is stock SnarkJS with three stages switchable to Rust kernels
(`kernels/`, arkworks), compiled to WASM in five builds. Every configuration keeps the same
proving key, witness, stage timers and verifier.

| Step | Command |
| --- | --- |
| Re-patch SnarkJS (timers + kernel switches) | `npm run instrument` |
| Build all kernels (WASM + native) | `bash scripts/build_kernels.sh` |
| Correctness, Node (plain build) | `node scripts/check_kernels.mjs --circuit c1_16 --build plain` |
| Correctness of a ported MSM, Node | `node scripts/check_kernels.mjs --circuit c1_16 --build plain --opt msm:ba` (or `msm:glv`) |
| Ported MSMs vs arkworks, native unit tests | `(cd kernels && cargo test --release --lib)` |
| Correctness, Chrome (any configuration) | `node runner/chrome_check.mjs --circuit c1_16 --config ALL --threads all` |
| Per-operation benchmark | `bash scripts/run_micro.sh` |
| Same kernels natively (N-K), all three MSM algorithms | `bash scripts/run_native_kernels.sh` |
| RQ3 batch | `bash scripts/run_rq34.sh T5.1 T5.2 T5.3 T5.4 T4.1 T4.2 T3.1 T3.2` |
| RQ4 batch | `bash scripts/run_rq34.sh ALL ALL-W` |
| One configuration | `node runner/chrome_bench.mjs --config T5.1 --circuit c1_16 --threads all --runs 30 --warmup 5` |
| RQ1/RQ2 extra tables | `python analysis/rq12_extras.py` |
| RQ3/RQ4 tables + figures | `python analysis/analyze_rq34.py` |
| Generality circuit (SHA-256) | `SIZES="16 18" bash scripts/build_c2.sh` |

Configurations (`runner/configs.mjs`): B1 stock SnarkJS · T5.1 MSM kernel · T5.2 MSM kernel with
wide arithmetic · T5.3 batch-affine MSM (ported native algorithm) · T5.4 batch-affine + GLV MSM ·
T4.1 NTT kernel · T4.2 NTT kernel on the shared-memory pool · T3.1 QAP in one
WASM call · T3.2 QAP on the pool · ALL best of each together · ALL-W ALL with wide arithmetic. ALL and ALL-W use the MSM algorithm
set in `BEST_MSM` at the top of `runner/configs.mjs` (chosen at Gate 2b).
Optimised runs go to `results/raw/chrome_opt.jsonl` with a `config` field.
Wide-arithmetic builds run Chrome with `--js-flags=--experimental-wasm-wide-arithmetic`.
