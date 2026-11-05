#!/usr/bin/env bash
# N-K: the same Rust kernels as the browser builds, run natively on the real proving keys.
# Same sizes, run counts and cool-down as the other runs. 1 thread uses the non-threaded
# binary; all cores uses the rayon binary (every logical core).
#
#   bash scripts/run_native_kernels.sh
#   SIZES="16" THREADS="1" bash scripts/run_native_kernels.sh
#   MSM_ALGOS="ba glv" bash scripts/run_native_kernels.sh     # only the ported MSMs (T5.3, T5.4)
#
# MSM_ALGOS (default "ark ba glv") repeats every run with each S5 algorithm:
#   ark = arkworks (as T5.1/T5.2), ba = batch-affine (T5.3), glv = batch-affine + GLV (T5.4).
#
# Results: results/raw/native_kernels.jsonl
set -uo pipefail
cd "$(dirname "$0")/.."
source ./config.sh
PREFIX="${PREFIX:-c1}"
MSM_ALGOS="${MSM_ALGOS:-ark ba glv}"
OUT=results/raw/native_kernels.jsonl
BATCH=$(date -u +%Y-%m-%dT%H-%M-%S)
mkdir -p results/raw
for k in $SIZES; do
  for t in $THREADS; do
   for a in $MSM_ALGOS; do
    c="${PREFIX}_$k"; runs=$(runs_for "$k")
    bin=kernels/target/release/native_kernels
    [ "$t" = all ] && bin=kernels/target-threads/release/native_kernels
    [ -x "$bin" ] || { echo "missing $bin: bash scripts/build_kernels.sh native"; exit 1; }
    echo "=== $(date +%T) N-K $c threads=$t msm=$a runs=$runs"
    MSM_ALGO="$a" "$bin" "$c" "build/$c/$c.zkey" "build/$c/witness.wtns" "$runs" "$WARMUP" "$t" \
      | jq -c --arg batch "$BATCH" --arg host "$(hostname)" --arg k "$k" '. + {batch: $batch, host: $host, k: ($k|tonumber)}' >> "$OUT"
    sleep "$COOLDOWN"
   done
  done
done
echo "done -> $OUT"
