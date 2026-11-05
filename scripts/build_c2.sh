#!/usr/bin/env bash
# Build the C2 SHA-256 circuit (generality check, week 8) at the sizes in SIZES.
# For each k it picks the largest number of blocks B whose circuit still fits a 2^k domain.
#
#   SIZES="16 18" bash scripts/build_c2.sh
#   FORCE=1 SIZES="16 18" bash scripts/build_c2.sh   # rebuild
set -euo pipefail
cd "$(dirname "$0")/.."
source ./config.sh
mkdir -p circuits/gen build/tune

gen_main() {   # gen_main <B> <output file>
  cat > "$2" <<EOT
pragma circom 2.1.6;
include "../sha256_blocks.circom";
component main = Sha256Blocks($1);
EOT
}
gen_input() {  # gen_input <B>  -> JSON with B*512-65 pseudo-random bits (fixed seed)
  node -e "const n=$1*512-65;let s=12345;const b=[];for(let i=0;i<n;i++){s=(s*1103515245+12345)&0x7fffffff;b.push(String((s>>16)&1));}console.log(JSON.stringify({in:b}));"
}
power_of() { node scripts/r1cs_info.mjs "$1" | jq -r .domainPower; }

gen_main 1 circuits/gen/c2_tune1.circom
circom circuits/gen/c2_tune1.circom --r1cs -l node_modules -o build/tune > /dev/null
PER_BLOCK=$(node scripts/r1cs_info.mjs build/tune/c2_tune1.r1cs | jq -r .nConstraints)
echo "Constraints for 1 SHA-256 block: $PER_BLOCK"

for k in $SIZES; do
  NAME="c2_$k"
  if [ -f "build/$NAME/meta.json" ] && [ "${FORCE:-0}" != "1" ]; then echo "[$NAME] already built"; continue; fi
  B=$(( (1 << k) / PER_BLOCK )); [ "$B" -ge 1 ] || { echo "2^$k is too small for one block"; exit 1; }
  while :; do
    gen_main "$B" "circuits/gen/$NAME.circom"
    circom "circuits/gen/$NAME.circom" --r1cs -l node_modules -o build/tune > /dev/null
    [ "$(power_of "build/tune/$NAME.r1cs")" -le "$k" ] && break
    B=$((B - 1))
  done
  echo "[$NAME] B = $B blocks"
  CHAIN_N=$B bash scripts/build_circuit.sh "$NAME" "circuits/gen/$NAME.circom" "$(gen_input "$B")"
done
for k in $SIZES; do jq -c '{name, N, nConstraints, domain, zkeyMB: (.zkeyBytes/1048576 | floor)}' "build/c2_$k/meta.json"; done
