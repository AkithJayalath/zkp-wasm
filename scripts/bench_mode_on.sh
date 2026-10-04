#!/usr/bin/env bash
# Put the CPU in a stable state for benchmarking.  Usage: sudo bash scripts/bench_mode_on.sh
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi

# Remember the current governor so bench_mode_off.sh can restore it
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor > /var/tmp/zkb_governor 2>/dev/null

# 1. Fixed "performance" governor on every core
for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "$g"
done

# 2. Turbo / boost off (frequency stays constant as the chip heats up)
if [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ]; then
  echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo && echo "Intel Turbo Boost: OFF"
elif [ -f /sys/devices/system/cpu/cpufreq/boost ]; then
  echo 0 > /sys/devices/system/cpu/cpufreq/boost && echo "AMD Core Performance Boost: OFF"
else
  echo "WARNING: no turbo switch found. Disable Turbo/Boost in the BIOS instead."
fi

# 3. Desktop power profile to performance (Ubuntu's power-profiles-daemon), if present
command -v powerprofilesctl >/dev/null && powerprofilesctl set performance 2>/dev/null

echo "Governor now: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"
echo "Current MHz per core:"; grep MHz /proc/cpuinfo | head -n 4
