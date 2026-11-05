#!/usr/bin/env bash
# RQ3/RQ4: run Chrome configurations (runner/configs.mjs) x sizes x threads in random order,
# with the same protocol and cool-downs as RQ1.
#
#   bash scripts/run_rq34.sh T5.1 T5.2 T5.3 T5.4 T4.1 T4.2 T3.1 T3.2   # RQ3 batch
#   bash scripts/run_rq34.sh ALL ALL-W                          # RQ4 batch
#   bash scripts/run_rq34.sh B1                                 # baseline drift check (needs SIZES/THREADS)
#   SIZES="16" THREADS="all" bash scripts/run_rq34.sh T5.1      # a subset
#   PREFIX=c2 SIZES="16 18" bash scripts/run_rq34.sh B1 ALL     # generality check (week 8)
#
# Configurations not defined for a thread setting (T4.2 and T3.2 on 1 thread) are skipped.
# Results: results/raw/chrome_opt.jsonl ; log: results/logs/rq34_*.log
set -uo pipefail
cd "$(dirname "$0")/.."
source ./config.sh

CONFIGS="${*:?give one or more configuration IDs, e.g. T5.1 ALL}"
PREFIX="${PREFIX:-c1}"
mkdir -p results/logs
LOG="results/logs/rq34_$(date +%Y%m%d_%H%M%S).log"

configs=()
for c in $CONFIGS; do
  for k in $SIZES; do
    for t in $THREADS; do
      node -e "import('./runner/configs.mjs').then(m=>{try{m.resolveConfig('$c','$t')}catch(e){process.exit(1)}})" \
        && configs+=("$c $k $t")
    done
  done
done
mapfile -t configs < <(printf '%s\n' "${configs[@]}" | shuf)

echo "Running ${#configs[@]} configurations; Chrome: $(google-chrome --version 2>/dev/null || echo "custom/${CHROME_PATH:-?}"); log: $LOG" | tee -a "$LOG"
n=0
for c in "${configs[@]}"; do
  read -r id k t <<< "$c"
  n=$((n + 1))
  runs=$(runs_for "$k")
  echo "=== [$n/${#configs[@]}] $(date +%T)  $id  ${PREFIX}_$k  threads=$t  runs=$runs ===" | tee -a "$LOG"
  node runner/chrome_bench.mjs --config "$id" --circuit "${PREFIX}_$k" --threads "$t" --runs "$runs" --warmup "$WARMUP" 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" -ne 0 ] && echo "!!! FAILED: $c" | tee -a "$LOG" results/logs/failures.txt
  sleep "$COOLDOWN"
done
echo "All done $(date +%T)" | tee -a "$LOG"
