# Shared settings for all scripts. Edit here, nowhere else.

# Circuit sizes: FFT domain = 2^k (C1 Poseidon chain is tuned to fill each domain)
SIZES="${SIZES:-12 14 16 18}"

# Thread settings to compare: "1" = single thread, "all" = every logical core
THREADS="${THREADS:-1 all}"

# Repetitions: 1 cold run + WARMUP discarded runs + measured runs
WARMUP="${WARMUP:-5}"
runs_for() {
  if [ "$1" -ge 18 ]; then echo 10; else echo 30; fi
}

# Seconds to rest between configurations (lets the CPU cool down)
COOLDOWN="${COOLDOWN:-30}"

# Powers of Tau file (one file covers every circuit up to 2^18)
PTAU_POWER=18
PTAU="${PTAU:-ptau/powersOfTau28_hez_final_${PTAU_POWER}.ptau}"

# Rapidsnark prover binary (built on Day 1)
PROVER="${PROVER:-tools/rapidsnark/package/bin/prover}"

# Give Node enough heap for 2^18 setup and proving
export NODE_OPTIONS="--max-old-space-size=8192"
