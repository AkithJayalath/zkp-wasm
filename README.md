# zkp-wasm-overhead

Measures how much slower Groth16 proof generation is in the browser (SnarkJS, WASM)
than natively (Rapidsnark, C++), and which pipeline stage causes the gap.
Answers RQ1 (overhead factor) and RQ2 (stage breakdown).

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
