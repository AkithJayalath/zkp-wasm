#!/usr/bin/env bash
# Run every configuration (runtime x size x threads) in random order, with cool-downs.
#
#   bash scripts/run_rq1.sh native node      # Monday
#   bash scripts/run_rq1.sh chrome           # Monday night / Tuesday
#   SIZES="16" THREADS="all" bash scripts/run_rq1.sh chrome   # just a subset
#
# Results are appended to results/raw/<runtime>.jsonl ; a log goes to results/logs/.
set -uo pipefail
cd "$(dirname "$0")/.."
source ./config.sh

RUNTIMES="${*:-native node}"
mkdir -p results/logs
LOG="results/logs/run_$(date +%Y%m%d_%H%M%S).log"

configs=()
for rt in $RUNTIMES; do
  for k in $SIZES; do
    for t in $THREADS; do configs+=("$rt $k $t"); done
  done
done
mapfile -t configs < <(printf '%s\n' "${configs[@]}" | shuf)

echo "Running ${#configs[@]} configurations; log: $LOG"
n=0
for c in "${configs[@]}"; do
  read -r rt k t <<< "$c"
  n=$((n + 1))
  runs=$(runs_for "$k")
  echo "=== [$n/${#configs[@]}] $(date +%T)  $rt  c1_$k  threads=$t  runs=$runs ===" | tee -a "$LOG"
  node "runner/${rt}_bench.mjs" --circuit "c1_$k" --threads "$t" --runs "$runs" --warmup "$WARMUP" 2>&1 | tee -a "$LOG"
  [ "${PIPESTATUS[0]}" -ne 0 ] && echo "!!! FAILED: $c" | tee -a "$LOG" results/logs/failures.txt
  sleep "$COOLDOWN"
done
echo "All done $(date +%T)" | tee -a "$LOG"
