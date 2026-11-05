#!/usr/bin/env python3
"""Two extra tables for the RQ1/RQ2 chapter (week 1, guide sections 1 and 2).

    python analysis/analyze.py        # first, so the summary CSVs are current
    python analysis/rq12_extras.py

Writes
  results/summary/rq1_tiers.csv           native -> Node -> Chrome: how much of the gap is the
                                          WebAssembly code itself and how much the browser adds
  results/summary/rq2_thread_scaling.csv  per-stage gain from 1 thread to all cores, native vs Chrome
"""
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
S = ROOT / "results/summary"

ov = pd.read_csv(S / "rq1_overhead.csv")
ov = ov[ov.metric == "total_ms"]
t = ov.pivot_table(index=["k", "threads"], columns="comparison", values=["ratio", "ci95_lo", "ci95_hi"])
t.columns = [f"{c[1]}_{c[0]}" for c in t.columns]
t = t.reset_index()[["k", "threads",
                     "node/native_ratio", "node/native_ci95_lo", "node/native_ci95_hi",
                     "chrome/node_ratio", "chrome/node_ci95_lo", "chrome/node_ci95_hi",
                     "chrome/native_ratio"]]
t.to_csv(S / "rq1_tiers.csv", index=False)
print("rq1_tiers.csv")
print(t.round(2).to_string(index=False))
print(f"\nWASM code (Node / native): {t['node/native_ratio'].min():.2f}-{t['node/native_ratio'].max():.2f}x;"
      f" browser on top (Chrome / Node): {t['chrome/node_ratio'].min():.2f}-{t['chrome/node_ratio'].max():.2f}x")

st = pd.read_csv(S / "rq2_stages.csv")
st = st[st["compare"] == "chrome vs native"]
rows = []
for (k, stage), g in st.groupby(["k", "stage"]):
    one, allc = g[g.threads.astype(str) == "1"], g[g.threads.astype(str) == "all"]
    if one.empty or allc.empty:
        continue
    rows.append({"k": k, "stage": stage,
                 "native_1thread_ms": one.native_ms.iloc[0], "native_all_ms": allc.native_ms.iloc[0],
                 "native_speedup": one.native_ms.iloc[0] / allc.native_ms.iloc[0],
                 "chrome_1thread_ms": one.chrome_ms.iloc[0], "chrome_all_ms": allc.chrome_ms.iloc[0],
                 "chrome_speedup": one.chrome_ms.iloc[0] / allc.chrome_ms.iloc[0]})
ts = pd.DataFrame(rows)
ts.to_csv(S / "rq2_thread_scaling.csv", index=False)
print("\nrq2_thread_scaling.csv (S3-S5 only)")
print(ts[ts.stage.str.match(r"S[345]")].round(2).to_string(index=False))
