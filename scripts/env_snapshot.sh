#!/usr/bin/env bash
# Write the machine and software versions to results/ENVIRONMENT.md
cd "$(dirname "$0")/.."
OUT=results/ENVIRONMENT.md
{
  echo "# Environment snapshot — $(date -Iseconds)"
  echo
  echo '## OS and kernel'; echo '```'; lsb_release -a 2>/dev/null; uname -a; echo '```'
  echo '## CPU'; echo '```'; lscpu; echo '```'
  echo '## CPU core layout (look for P-cores vs E-cores)'; echo '```'; lscpu --all --extended; echo '```'
  echo '## Memory'; echo '```'; free -h; echo '```'
  echo '## Power state'; echo '```'
  echo "governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null)"
  echo "intel no_turbo: $(cat /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null || echo n/a)"
  echo "cpufreq boost: $(cat /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || echo n/a)"
  echo "on AC power: $(cat /sys/class/power_supply/A*/online 2>/dev/null || echo unknown)"
  echo '```'
  echo '## Toolchain'; echo '```'
  echo "gcc: $(gcc --version | head -n1)"
  echo "rustc: $(rustc --version 2>/dev/null)"
  echo "circom: $(circom --version 2>/dev/null)"
  echo "node: $(node --version)"
  echo "snarkjs: $(node -p "require('./node_modules/snarkjs/package.json').version" 2>/dev/null)"
  echo "playwright: $(node -p "require('./node_modules/playwright/package.json').version" 2>/dev/null)"
  echo "google-chrome: $(google-chrome --version 2>/dev/null || echo 'not on PATH')"
  echo "rapidsnark commit: $(git -C tools/rapidsnark rev-parse HEAD 2>/dev/null)"
  echo "ffiasm commit: $(git -C tools/rapidsnark/depends/ffiasm rev-parse HEAD 2>/dev/null)"
  echo "python: $(python3 --version)"
  echo '```'
} > "$OUT"
echo "Wrote $OUT"
