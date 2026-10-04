#!/usr/bin/env python3
"""Patch Rapidsnark for the benchmark.

1. RAPIDSNARK_THREADS=<n> sets the size of Rapidsnark's thread pool
   (stock Rapidsnark always uses every core and ignores OMP_NUM_THREADS).
2. RAPIDSNARK_STAGES=1 prints one line per pipeline stage to stderr:
       STAGE<TAB><name><TAB><milliseconds>
   Stage boundaries sit next to Rapidsnark's own LOG_TRACE points.

Usage:  python3 scripts/patch_rapidsnark.py tools/rapidsnark
Safe to run twice: already-patched files are skipped.
"""
import pathlib
import sys

MARK = "ZKBENCH-PATCH"
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "tools/rapidsnark")
if not (root / "src" / "groth16.cpp").exists():
    sys.exit(f"[error] {root} does not look like a Rapidsnark checkout")

STAGE_CLOCK = """// ZKBENCH-PATCH: per-stage wall-clock timer (prints only when RAPIDSNARK_STAGES is set)
#ifndef ZKBENCH_STAGE_CLOCK_HPP
#define ZKBENCH_STAGE_CLOCK_HPP
#include <chrono>
#include <cstdio>
#include <cstdlib>

struct StageClock {
    std::chrono::steady_clock::time_point t;
    bool on;
    StageClock() : t(std::chrono::steady_clock::now()),
                   on(std::getenv("RAPIDSNARK_STAGES") != nullptr) {}
    void lap(const char *name) {
        auto now = std::chrono::steady_clock::now();
        if (on) {
            std::fprintf(stderr, "STAGE\\t%s\\t%.3f\\n", name,
                         std::chrono::duration<double, std::milli>(now - t).count());
        }
        t = now;
    }
};
#endif
"""


def patch(rel, edits, prepend=""):
    p = root / rel
    s = p.read_text()
    if MARK in s:
        print(f"[skip]  {rel} (already patched)")
        return
    for kind, anchor, text in edits:
        n = s.count(anchor)
        if n != 1:
            sys.exit(f"[error] {rel}: expected the anchor once, found {n} times:\n        {anchor!r}")
        if kind == "after":
            s = s.replace(anchor, anchor + text)
        elif kind == "before":
            s = s.replace(anchor, text + anchor)
        else:
            s = s.replace(anchor, text)
    p.with_suffix(p.suffix + ".orig").write_text(p.read_text())
    p.write_text(f"// {MARK}\n" + prepend + s)
    print(f"[ok]    {rel} ({len(edits)} edits)")


# --- 0. the timer header ---------------------------------------------------
(root / "src" / "stage_clock.hpp").write_text(STAGE_CLOCK)
print("[ok]    src/stage_clock.hpp")

# --- 1. thread count from RAPIDSNARK_THREADS --------------------------------
patch("depends/ffiasm/c/misc.hpp", [
    ("after", "#include <thread>", "\n#include <cstdlib>"),
    ("replace", "unsigned int n = std::thread::hardware_concurrency();",
     "unsigned int n = std::thread::hardware_concurrency();\n"
     "        if (const char *zkb_env = std::getenv(\"RAPIDSNARK_THREADS\")) {\n"
     "            int zkb_v = std::atoi(zkb_env);\n"
     "            if (zkb_v > 0) n = (unsigned int)zkb_v;\n"
     "        }"),
])

# --- 2. stage timers inside Prover::prove ------------------------------------
lap = lambda name: f'\n    zkb_sc.lap("{name}");'
patch("src/groth16.cpp", [
    ("replace", "ThreadPool &threadPool = ThreadPool::defaultPool();",
     "StageClock zkb_sc;\n    ThreadPool &threadPool = ThreadPool::defaultPool();" + lap("S0_threadpool")),
    ("after", "LOG_DEBUG(ss2);", lap("S5_msm_A")),
    ("after", "LOG_DEBUG(ss3);", lap("S5_msm_B1")),
    ("after", "LOG_DEBUG(ss4);", lap("S5_msm_B2")),
    ("after", "LOG_DEBUG(ss5);", lap("S5_msm_C")),
    ("before", 'LOG_TRACE("Initializing fft");', 'zkb_sc.lap("S3_buildABC");\n    '),
    ("before", 'LOG_TRACE("Start ABC");', 'zkb_sc.lap("S4_fft");\n    '),
    ("before", 'LOG_TRACE("Start Multiexp H");', 'zkb_sc.lap("S3_joinABC");\n    '),
    ("after", "LOG_DEBUG(ss1);", lap("S5_msm_H")),
    ("before", "Proof<Engine> *p = new Proof<Engine>(Engine::engine);", 'zkb_sc.lap("S6_finalize");\n    '),
], prepend='#include "stage_clock.hpp"\n')

# --- 3. timers around file loading and output in the prover executable -------
patch("src/main_prover.cpp", [
    ("before", "const std::string zkeyFilename = argv[1];", "StageClock zkb_sc;\n        "),
    ("after", "BinFileUtils::FileLoader wtnsFile(wtnsFilename);", '\n        zkb_sc.lap("N_load_files");'),
    ("before", "std::ofstream proofFile(proofFilename);", 'zkb_sc.lap("N_prover_call");\n        '),
    ("after", "publicFile.write(publicBuffer.data(), publicSize);",
     '\n        proofFile.close();\n        publicFile.close();\n        zkb_sc.lap("N_write");'),
], prepend='#include "stage_clock.hpp"\n')

print("\nDone. Now rebuild:  cd tools/rapidsnark && make host")
