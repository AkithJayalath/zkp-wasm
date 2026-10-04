# Environment snapshot — 2026-10-05T00:22:20+05:30

## OS and kernel
```
Distributor ID:	Ubuntu
Description:	Ubuntu 26.04.1 LTS
Release:	26.04
Codename:	resolute
Linux akith-ThinkPad 7.0.0-38-generic #38-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep  4 09:10:14 UTC 2026 x86_64 GNU/Linux
```
## CPU
```
Architecture:                            x86_64
CPU op-mode(s):                          32-bit, 64-bit
Address sizes:                           39 bits physical, 48 bits virtual
Byte Order:                              Little Endian
CPU(s):                                  4
On-line CPU(s) list:                     0-3
Vendor ID:                               GenuineIntel
Model name:                              Intel(R) Core(TM) i7-6600U CPU @ 2.60GHz
CPU family:                              6
Model:                                   78
Thread(s) per core:                      2
Core(s) per socket:                      2
Socket(s):                               1
Stepping:                                3
CPU(s) scaling MHz:                      100%
CPU max MHz:                             2600.0000
CPU min MHz:                             400.0000
BogoMIPS:                                5599.85
Flags:                                   fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe syscall nx pdpe1gb rdtscp lm constant_tsc art arch_perfmon pebs bts rep_good nopl xtopology nonstop_tsc cpuid aperfmperf pni pclmulqdq dtes64 monitor ds_cpl vmx smx est tm2 ssse3 sdbg fma cx16 xtpr pdcm pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand lahf_lm abm 3dnowprefetch cpuid_fault epb pti ssbd ibrs ibpb stibp tpr_shadow flexpriority ept vpid ept_ad fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid mpx rdseed adx smap clflushopt intel_pt xsaveopt xsavec xgetbv1 xsaves dtherm ida arat pln pts hwp hwp_notify hwp_act_window hwp_epp vnmi md_clear flush_l1d arch_capabilities
Virtualization:                          VT-x
L1d cache:                               64 KiB (2 instances)
L1i cache:                               64 KiB (2 instances)
L2 cache:                                512 KiB (2 instances)
L3 cache:                                4 MiB (1 instance)
NUMA node(s):                            1
NUMA node0 CPU(s):                       0-3
Vulnerability Gather data sampling:      Vulnerable: No microcode
Vulnerability Ghostwrite:                Not affected
Vulnerability Indirect target selection: Not affected
Vulnerability Itlb multihit:             KVM: Mitigation: Split huge pages
Vulnerability L1tf:                      Mitigation; PTE Inversion; VMX conditional cache flushes, SMT vulnerable
Vulnerability Mds:                       Mitigation; Clear CPU buffers; SMT vulnerable
Vulnerability Meltdown:                  Mitigation; PTI
Vulnerability Mmio stale data:           Mitigation; Clear CPU buffers; SMT vulnerable
Vulnerability Old microcode:             Not affected
Vulnerability Reg file data sampling:    Not affected
Vulnerability Retbleed:                  Mitigation; IBRS
Vulnerability Spec rstack overflow:      Not affected
Vulnerability Spec store bypass:         Mitigation; Speculative Store Bypass disabled via prctl
Vulnerability Spectre v1:                Mitigation; usercopy/swapgs barriers and __user pointer sanitization
Vulnerability Spectre v2:                Mitigation; IBRS; IBPB conditional; STIBP conditional; RSB filling; PBRSB-eIBRS Not affected; BHI Not affected
Vulnerability Srbds:                     Mitigation; Microcode
Vulnerability Tsa:                       Not affected
Vulnerability Tsx async abort:           Mitigation; TSX disabled
Vulnerability Vmscape:                   Mitigation; IBPB before exit to userspace
```
## CPU core layout (look for P-cores vs E-cores)
```
CPU NODE SOCKET CORE L1d:L1i:L2:L3 ONLINE    MAXMHZ   MINMHZ       MHZ
  0    0      0    0 0:0:0:0          yes 2600.0000 400.0000 2600.0071
  1    0      0    1 1:1:1:0          yes 2600.0000 400.0000 2600.0010
  2    0      0    0 0:0:0:0          yes 2600.0000 400.0000 2601.1211
  3    0      0    1 1:1:1:0          yes 2600.0000 400.0000 2599.8391
```
## Memory
```
               total        used        free      shared  buff/cache   available
Mem:            18Gi       3.0Gi        11Gi       583Mi       4.9Gi        15Gi
Swap:          8.0Gi          0B       8.0Gi
```
## Power state
```
governor: performance
intel no_turbo: 1
cpufreq boost: n/a
on AC power: 1
```
## Toolchain
```
gcc: gcc (Ubuntu 15.2.0-16ubuntu1) 15.2.0
rustc: rustc 1.99.0 (b940084d7 2026-09-28)
circom: circom compiler 2.2.3
node: v22.23.3
snarkjs: 0.7.6
playwright: 1.63.0
google-chrome: Google Chrome 154.0.8037.97 
rapidsnark commit: 81eddf1a536d26497b237c0b8a04fe90baf7e439
ffiasm commit: aa90166dc4c5a075b835a398e15cc1e06ac90e95
python: Python 3.14.4
```
