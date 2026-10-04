#!/usr/bin/env bash
# Build the C1 Poseidon-chain circuit at every size in config.sh (SIZES).
# For each k it picks the largest chain length N whose circuit still fits a 2^k domain.
#
#   bash scripts/build_c1.sh            # build all sizes (skips ones already built)
#   FORCE=1 bash scripts/build_c1.sh    # rebuild everything
set -euo pipefail
cd "$(dirname "$0")/.."
source ./config.sh

mkdir -p circuits/gen build/tune

gen_main() {   # gen_main <N> <output file>
  cat > "$2" <<EOF
pragma circom 2.1.6;
include "../poseidon_chain.circom";
component main = PoseidonChain($1);
EOF
}

power_of() { node scripts/r1cs_info.mjs "$1" | jq -r .domainPower; }

# 1. Measure constraints per hash from N=1 and N=2
for n in 1 2; do
  gen_main "$n" "circuits/gen/tune_$n.circom"
  circom "circuits/gen/tune_$n.circom" --r1cs -l node_modules -o build/tune > /dev/null
done
C1=$(node scripts/r1cs_info.mjs build/tune/tune_1.r1cs | jq -r .nConstraints)
C2=$(node scripts/r1cs_info.mjs build/tune/tune_2.r1cs | jq -r .nConstraints)
PER_HASH=$((C2 - C1)); FIXED=$((C1 - PER_HASH))
echo "Constraints per Poseidon: $PER_HASH   fixed overhead: $FIXED"

# 2. Build each size
for k in $SIZES; do
  NAME="c1_$k"
  if [ -f "build/$NAME/meta.json" ] && [ "${FORCE:-0}" != "1" ]; then
    echo "[$NAME] already built, skipping (FORCE=1 to rebuild)"; continue
  fi
  N=$(( ((1 << k) - 8 - FIXED) / PER_HASH ))
  # Safety loop: shrink N until the circuit really fits 2^k
  while :; do
    gen_main "$N" "circuits/gen/$NAME.circom"
    circom "circuits/gen/$NAME.circom" --r1cs -l node_modules -o build/tune > /dev/null
    P=$(power_of "build/tune/$NAME.r1cs")
    [ "$P" -le "$k" ] && break
    N=$((N - 1))
  done
  echo "[$NAME] N = $N hashes -> domain 2^$P"
  CHAIN_N=$N bash scripts/build_circuit.sh "$NAME" "circuits/gen/$NAME.circom" '{"in": "12345"}'
done

echo; echo "Summary:"
for k in $SIZES; do jq -c '{name, N, nConstraints, domain, zkeyMB: (.zkeyBytes/1048576 | floor)}' "build/c1_$k/meta.json"; done
