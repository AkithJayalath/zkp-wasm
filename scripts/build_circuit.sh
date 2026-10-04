#!/usr/bin/env bash
# Build every artifact for one circuit, then prove it once natively and verify.
#
#   bash scripts/build_circuit.sh <name> <file.circom> '<input json>'
#   e.g. bash scripts/build_circuit.sh multiplier circuits/multiplier.circom '{"a":"3","b":"11"}'
#
# Output folder build/<name>/ :
#   <name>.r1cs, <name>.sym       constraint system
#   <name>_js/<name>.wasm         WASM witness generator  (Node, Chrome)
#   <name>_cpp/<name>             C++ witness generator   (native)
#   <name>.zkey, vkey.json        Groth16 proving / verification key
#   input.json, witness.wtns      the fixed input and its witness
#   meta.json                     constraints, domain size, zkey size
set -euo pipefail
cd "$(dirname "$0")/.."
source ./config.sh

NAME="$1"; CIRCOM_FILE="$2"; INPUT="$3"
OUT="build/$NAME"
SNARKJS="npx --no-install snarkjs"

[ "$(basename "$CIRCOM_FILE" .circom)" = "$NAME" ] || { echo "circom file must be named $NAME.circom"; exit 1; }
[ -f "$PTAU" ] || { echo "Missing $PTAU (Day 1, step 7)"; exit 1; }
[ -x "$PROVER" ] || { echo "Missing $PROVER (Day 1, step 5)"; exit 1; }

step() { echo; echo "=== [$NAME] $* ==="; }
mkdir -p "$OUT"

step "1/9 compile with circom"
circom "$CIRCOM_FILE" --r1cs --wasm --c --sym -l node_modules -o "$OUT"

step "2/9 circuit size"
INFO=$(node scripts/r1cs_info.mjs "$OUT/$NAME.r1cs")
echo "$INFO" | jq .

step "3/9 build the C++ witness generator"
make -s -j"$(nproc)" -C "$OUT/${NAME}_cpp"

step "4/9 witness (native C++ and WASM) + constraint check"
echo "$INPUT" > "$OUT/input.json"
"$OUT/${NAME}_cpp/$NAME" "$OUT/input.json" "$OUT/witness.wtns"
$SNARKJS wtns calculate "$OUT/${NAME}_js/$NAME.wasm" "$OUT/input.json" "$OUT/witness_wasm.wtns"
$SNARKJS wtns check "$OUT/$NAME.r1cs" "$OUT/witness.wtns"
$SNARKJS wtns check "$OUT/$NAME.r1cs" "$OUT/witness_wasm.wtns"

step "5/9 Groth16 setup (phase 2)"
$SNARKJS groth16 setup "$OUT/$NAME.r1cs" "$PTAU" "$OUT/${NAME}_0000.zkey"

step "6/9 one phase-2 contribution"
$SNARKJS zkey contribute "$OUT/${NAME}_0000.zkey" "$OUT/$NAME.zkey" \
  --name="bench" -e="$(head -c 64 /dev/urandom | base64 -w0)"
rm -f "$OUT/${NAME}_0000.zkey"

step "7/9 export verification key"
$SNARKJS zkey export verificationkey "$OUT/$NAME.zkey" "$OUT/vkey.json"

step "8/9 sanity proof: Rapidsnark proves, SnarkJS verifies"
"$PROVER" "$OUT/$NAME.zkey" "$OUT/witness.wtns" "$OUT/proof_check.json" "$OUT/public_check.json"
$SNARKJS groth16 verify "$OUT/vkey.json" "$OUT/public_check.json" "$OUT/proof_check.json"

step "9/9 meta.json"
ZKEY_BYTES=$(stat -c %s "$OUT/$NAME.zkey")
echo "$INFO" | jq --arg name "$NAME" --argjson zkeyBytes "$ZKEY_BYTES" --argjson N "${CHAIN_N:-null}" \
  '. + {name: $name, N: $N, zkeyBytes: $zkeyBytes}' > "$OUT/meta.json"
cat "$OUT/meta.json"
echo; echo "[$NAME] built OK"
