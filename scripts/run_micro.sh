#!/usr/bin/env bash
# Per-operation microbenchmark (week 2): Fr multiplication and G1 mixed addition,
# natively and in Chrome, for the plain, SIMD and wide-arithmetic builds of the same code.
#
#   bash scripts/run_micro.sh            # 10M iterations, 10 repeats
#   ITERS=20000000 REPS=20 bash scripts/run_micro.sh
#
# Results: results/raw/micro_native.jsonl and results/raw/micro.jsonl
set -euo pipefail
cd "$(dirname "$0")/.."
ITERS="${ITERS:-10000000}"; REPS="${REPS:-10}"
mkdir -p results/raw
echo "=== native"
kernels/target/release/micro "$ITERS" "$REPS" | jq -c --arg when "$(date -Iseconds)" '. + {when: $when}' >> results/raw/micro_native.jsonl
tail -n 2 results/raw/micro_native.jsonl
echo "=== chrome (plain, simd, wide)"
node runner/chrome_micro.mjs --builds plain,simd,wide --iters "$ITERS" --reps "$REPS"
