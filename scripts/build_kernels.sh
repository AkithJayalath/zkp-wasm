#!/usr/bin/env bash
# Build the Rust kernels (kernels/) for RQ3/RQ4.
#
#   bash scripts/build_kernels.sh            # all builds
#   bash scripts/build_kernels.sh plain wide # only these
#
# WASM builds go to web/kernels/<build>/ (loaded by the browser worker and by Node):
#   plain         plain WASM                            T5.1, T4.1, T3.1 (and 1-thread runs)
#   wide          + wide-arithmetic instructions        T5.2 (1 thread)
#   simd          + 128-bit SIMD                        per-operation benchmark only
#   threads       + shared-memory thread pool           T4.2, T3.2, all-core T5.1, ALL
#   threads-wide  + thread pool + wide arithmetic       all-core T5.2, ALL-W
# Native builds go to kernels/target*/release/ :
#   native_kernels / micro            1 thread (N-K, 1-thread reference)
#   native_kernels (threads)          rayon on all cores (N-K, all-core reference)
#
# Every build uses the same rustc (recorded in web/kernels/BUILD_INFO.txt), so the
# only difference between builds is the flag being tested.
set -euo pipefail
cd "$(dirname "$0")/.."

BUILDS="${*:-plain wide simd threads threads-wide native}"
K=kernels
OUTROOT=web/kernels
mkdir -p "$OUTROOT"

command -v wasm-bindgen >/dev/null || { echo "wasm-bindgen CLI missing: cargo install wasm-bindgen-cli --version \$(grep -A1 'name = \"wasm-bindgen\"$' kernels/Cargo.lock | sed -n 's/version = \"\(.*\)\"/\1/p') --locked"; exit 1; }

# The threaded std rebuild uses -Z build-std. RUSTC_BOOTSTRAP=1 allows that on the same
# stable compiler as the other builds (instead of switching to a nightly compiler).
export RUSTC_BOOTSTRAP=1
THREAD_FLAGS="-C target-feature=+atomics,+bulk-memory -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=4294967296 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base"
# 4 GiB is the WASM32 limit; the plain builds grow on demand up to the same limit.
PLAIN_FLAGS="-C link-arg=--max-memory=4294967296"

wasm_build() {   # wasm_build <name> <rustflags> <cargo args...>
  local name="$1" flags="$2"; shift 2
  echo "=== [$name] cargo build (RUSTFLAGS: $flags)"
  (cd "$K" && RUSTFLAGS="$flags" cargo build --release --lib --target wasm32-unknown-unknown \
      --target-dir "target-wasm-$name" "$@")
  rm -rf "$OUTROOT/$name"
  wasm-bindgen --target web --out-dir "$OUTROOT/$name" \
      "$K/target-wasm-$name/wasm32-unknown-unknown/release/zkp_kernels.wasm"
  # wasm-bindgen-rayon's helper imports the package as '../../..', which only works
  # through a bundler. We serve files directly, so point it at the actual module file.
  find "$OUTROOT/$name" -name workerHelpers.js -exec \
      sed -i "s#import('../../..')#import('../../../zkp_kernels.js')#" {} +
  python3 - "$OUTROOT/$name/zkp_kernels_bg.wasm" "$name" <<'PY'
import sys
b = open(sys.argv[1], 'rb').read()
wide = b.count(bytes([0xfc, 0x16])) + b.count(bytes([0xfc, 0x15]))
print(f"[{sys.argv[2]}] {len(b)/1024:.0f} KiB, wide-multiply opcodes: {wide}")
PY
}

for b in $BUILDS; do
  case "$b" in
    plain)        wasm_build plain "$PLAIN_FLAGS" ;;
    wide)         wasm_build wide "$PLAIN_FLAGS -C target-feature=+wide-arithmetic" ;;
    simd)         wasm_build simd "$PLAIN_FLAGS -C target-feature=+simd128" ;;
    threads)      wasm_build threads "$THREAD_FLAGS" --features threads -Z build-std=panic_abort,std ;;
    threads-wide) wasm_build threads-wide "$THREAD_FLAGS -C target-feature=+wide-arithmetic" --features threads -Z build-std=panic_abort,std ;;
    native)
      echo "=== [native] 1-thread and all-core binaries"
      (cd "$K" && cargo build --release --bins && cargo build --release --bins --features threads --target-dir target-threads) ;;
    *) echo "unknown build: $b"; exit 1 ;;
  esac
done

{ echo "built: $(date -Iseconds)"; (cd "$K" && rustc --version); wasm-bindgen --version; echo "builds: $BUILDS"; } > "$OUTROOT/BUILD_INFO.txt"
cat "$OUTROOT/BUILD_INFO.txt"
