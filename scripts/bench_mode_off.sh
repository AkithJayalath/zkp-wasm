#!/usr/bin/env bash
# Restore normal power settings.  Usage: sudo bash scripts/bench_mode_off.sh
set -uo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo"; exit 1; fi

GOV=$(cat /var/tmp/zkb_governor 2>/dev/null || echo powersave)
for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo "$GOV" > "$g"; done
[ -f /sys/devices/system/cpu/intel_pstate/no_turbo ] && echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo
[ -f /sys/devices/system/cpu/cpufreq/boost ] && echo 1 > /sys/devices/system/cpu/cpufreq/boost
command -v powerprofilesctl >/dev/null && powerprofilesctl set balanced 2>/dev/null
echo "Governor restored to: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"
