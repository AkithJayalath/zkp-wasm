#!/usr/bin/env python3
"""Turn results/raw/*.jsonl into the RQ1 and RQ2 tables and figures.

    python analysis/analyze.py          # C1 circuits (default)
    python analysis/analyze.py c2_      # another circuit family later

Reads   results/raw/native.jsonl, node.jsonl, chrome.jsonl
Writes  results/summary/*.csv   and   results/figures/*.png (+ .pdf)

Only the latest batch of each (runtime, circuit, threads) configuration is used,
so re-running a noisy configuration simply replaces it. Only "warm" runs with a
verified proof enter the statistics.
"""
from pathlib import Path
import json
import sys

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402
from scipy.stats import mannwhitneyu  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW, SUMMARY, FIGS = ROOT / "results/raw", ROOT / "results/summary", ROOT / "results/figures"
SUMMARY.mkdir(parents=True, exist_ok=True)
FIGS.mkdir(parents=True, exist_ok=True)

RUNTIMES = ["native", "node", "chrome"]
RT_LABEL = {"native": "Native (Rapidsnark)", "node": "Node.js (SnarkJS WASM)", "chrome": "Chrome (SnarkJS WASM)"}
RT_COLOR = {"native": "#2a78d6", "node": "#eb6834", "chrome": "#1baf7a"}
STAGES = ["load_io", "witness", "qap", "fft", "msm", "finalize"]
STAGE_LABEL = {
    "load_io": "S0–S1 Load + data bridging",
    "witness": "S2 Witness generation",
    "qap": "S3 QAP construction",
    "fft": "S4 FFT / NTT",
    "msm": "S5 MSM",
    "finalize": "S6 Finalize + output",
}
STAGE_COLOR = dict(zip(STAGES, ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]))
STAGE_SHORT = {
    "load_io": "S0–S1\nLoad + bridge", "witness": "S2\nWitness", "qap": "S3\nQAP",
    "fft": "S4\nFFT / NTT", "msm": "S5\nMSM", "finalize": "S6\nFinalize",
}
THREAD_LABEL = {"1": "1 thread", "all": "all cores"}
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"
RNG = np.random.default_rng(42)
N_BOOT = 10_000

plt.rcParams.update({
    "font.size": 10, "axes.edgecolor": INK2, "axes.labelcolor": INK, "xtick.color": INK2,
    "ytick.color": INK2, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True,
    "legend.frameon": False, "figure.dpi": 110, "savefig.dpi": 200, "savefig.bbox": "tight",
})


# ---------------------------------------------------------------- loading ---
def load():
    rows = []
    for rt in RUNTIMES:
        f = RAW / f"{rt}.jsonl"
        if f.exists():
            rows += [json.loads(line) for line in f.read_text().splitlines() if line.strip()]
    if not rows:
        sys.exit("No results in results/raw/ yet.")
    df = pd.DataFrame(rows)
    prefix = sys.argv[1] if len(sys.argv) > 1 else "c1_"   # smoke-test circuits are ignored
    df = df[df["circuit"].str.startswith(prefix)].copy()
    if df.empty:
        sys.exit(f"No results for circuits starting with {prefix!r}.")
    df["threads"] = df["threads"].astype(str)
    keys = ["runtime", "circuit", "threads"]
    df = df[df["batch"] == df.groupby(keys)["batch"].transform("max")].copy()  # latest batch only
    return df


def stage_split(r):
    """Map each runtime's raw timers onto the common stages S0..S6 (milliseconds)."""
    st = r["stages"]
    msm = sum(v for k, v in st.items() if k.startswith("S5_msm"))
    qap = st.get("S3_buildABC", 0) + st.get("S3_joinABC", 0)
    fft = st.get("S4_fft", 0)
    if r["runtime"] == "native":
        n_load, n_call, n_write = st.get("N_load_files", 0), st.get("N_prover_call", 0), st.get("N_write", 0)
        internal = sum(v for k, v in st.items() if k[:2] in ("S0", "S3", "S4", "S5", "S6"))
        parse = n_call - internal                       # zkey/wtns parsing + proof to JSON
        process = r["prove_ms"] - (n_load + n_call + n_write)  # exec, exit, mmap teardown
        load_io = n_load + parse + process + st.get("S0_threadpool", 0)
        finalize = st.get("S6_finalize", 0) + n_write
        residual = process
    else:
        laps = sum(st.values())
        load_io = sum(v for k, v in st.items() if k.startswith("S1_"))
        residual = r["prove_ms"] - laps                 # time inside prove() outside any lap
        finalize = st.get("S6_finalize", 0) + residual
    return pd.Series({"load_io": load_io, "witness": r["witness_ms"], "qap": qap, "fft": fft,
                      "msm": msm, "finalize": finalize, "residual_ms": residual})


def boot_median(x):
    x = np.asarray(x, float)
    idx = RNG.integers(0, len(x), size=(N_BOOT, len(x)))
    return np.median(x[idx], axis=1)


def ci(samples):
    return np.percentile(samples, [2.5, 97.5])


# ----------------------------------------------------------------- tables ---
def config_summary(warm):
    out = []
    for (rt, circ, th), g in warm.groupby(["runtime", "circuit", "threads"]):
        t = g["total_ms"].to_numpy()
        lo, hi = ci(boot_median(t))
        out.append({
            "runtime": rt, "circuit": circ, "k": int(g["k"].iloc[0]), "threads": th,
            "nthreads": int(g["nthreads"].iloc[0]), "constraints": int(g["constraints"].iloc[0]),
            "domain": int(g["domain"].iloc[0]), "n_runs": len(g),
            "median_total_ms": np.median(t), "ci95_lo": lo, "ci95_hi": hi,
            "iqr_ms": np.subtract(*np.percentile(t, [75, 25])),
            "mean_total_ms": t.mean(), "sd_ms": t.std(ddof=1) if len(t) > 1 else 0.0,
            "cv": t.std(ddof=1) / t.mean() if len(t) > 1 else 0.0,
            "median_witness_ms": g["witness_ms"].median(), "median_prove_ms": g["prove_ms"].median(),
            "peak_rss_mb": (g["peak_rss_kb"].max() / 1024) if "peak_rss_kb" in g and g["peak_rss_kb"].notna().any() else np.nan,
        })
    return pd.DataFrame(out).sort_values(["k", "threads", "runtime"])


def overhead_table(warm, metric="total_ms"):
    pairs = [("chrome", "native"), ("node", "native"), ("chrome", "node")]
    out = []
    for (k, th), g in warm.groupby(["k", "threads"]):
        for a, b in pairs:
            xa = g.loc[g.runtime == a, metric].to_numpy()
            xb = g.loc[g.runtime == b, metric].to_numpy()
            if len(xa) == 0 or len(xb) == 0:
                continue
            boots = boot_median(xa) / boot_median(xb)
            lo, hi = ci(boots)
            p = mannwhitneyu(xa, xb).pvalue if len(xa) > 1 and len(xb) > 1 else np.nan
            out.append({"k": k, "domain": 2 ** int(k), "threads": th, "comparison": f"{a}/{b}", "metric": metric,
                        "ratio": np.median(xa) / np.median(xb), "ci95_lo": lo, "ci95_hi": hi,
                        "median_a_ms": np.median(xa), "median_b_ms": np.median(xb), "mannwhitney_p": p})
    return pd.DataFrame(out)


def scaling_slopes(summ):
    out = []
    for (rt, th), g in summ.groupby(["runtime", "threads"]):
        if len(g) >= 2:
            slope, _ = np.polyfit(np.log2(g["domain"]), np.log2(g["median_total_ms"]), 1)
            out.append({"runtime": rt, "threads": th, "log2_slope": slope, "sizes": len(g)})
    return pd.DataFrame(out)


def stage_table(warm):
    med = warm.groupby(["k", "threads", "runtime"])[STAGES].median()
    out = []
    for (k, th), g in med.groupby(level=[0, 1]):
        g = g.droplevel([0, 1])
        if "native" not in g.index:
            continue
        for target in ["chrome", "node"]:
            if target not in g.index:
                continue
            delta = g.loc[target] - g.loc["native"]
            total_delta = delta.sum()
            for s in STAGES:
                out.append({
                    "k": k, "threads": th, "compare": f"{target} vs native", "stage": STAGE_LABEL[s],
                    "native_ms": g.loc["native", s], f"{target}_ms": g.loc[target, s],
                    "added_ms": delta[s], "share_of_added": delta[s] / total_delta if total_delta else np.nan,
                    "ratio": g.loc[target, s] / g.loc["native", s] if g.loc["native", s] > 0 else np.nan,
                })
    return pd.DataFrame(out), med


# ---------------------------------------------------------------- figures ---
def ms_fmt(v, _):
    return f"{v / 1000:.3g} s" if v >= 1000 else f"{v:.3g} ms"


def save(fig, name):
    fig.savefig(FIGS / f"{name}.png")
    fig.savefig(FIGS / f"{name}.pdf")
    plt.close(fig)
    print(f"  figure  results/figures/{name}.png")


def fig_scaling(summ):
    ths = [t for t in ["1", "all"] if t in set(summ.threads)]
    fig, axes = plt.subplots(1, len(ths), figsize=(5.2 * len(ths), 4), sharey=True, squeeze=False)
    for ax, th in zip(axes[0], ths):
        for rt in RUNTIMES:
            g = summ[(summ.runtime == rt) & (summ.threads == th)].sort_values("domain")
            if g.empty:
                continue
            yerr = [g.median_total_ms - g.ci95_lo, g.ci95_hi - g.median_total_ms]
            ax.errorbar(g.domain, g.median_total_ms, yerr=yerr, color=RT_COLOR[rt], marker="o",
                        markersize=6, linewidth=2, capsize=3, label=RT_LABEL[rt])
            last = g.iloc[-1]
            ax.annotate(RT_LABEL[rt].split(" (")[0], (last.domain, last.median_total_ms), xytext=(6, 0),
                        textcoords="offset points", va="center", color=INK, fontsize=9)
        ax.set_xscale("log", base=2)
        ax.set_yscale("log")
        ax.yaxis.set_major_formatter(FuncFormatter(ms_fmt))
        ax.set_xlabel("FFT domain size (≈ constraints)")
        ax.set_title(THREAD_LABEL[th], color=INK, loc="left")
    axes[0][0].set_ylabel("End-to-end proving time (median, warm)")
    axes[0][-1].legend(loc="upper left")
    fig.suptitle("RQ1 · Proving time vs circuit size", x=0.01, ha="left", fontweight="bold", color=INK)
    save(fig, "F1_rq1_scaling")


def fig_ratio(ov):
    ov = ov[ov.comparison.isin(["chrome/native", "node/native"])]
    ths = [t for t in ["1", "all"] if t in set(ov.threads)]
    if not ths:
        return
    fig, axes = plt.subplots(1, len(ths), figsize=(5.2 * len(ths), 4), sharey=True, squeeze=False)
    colors = {"chrome/native": RT_COLOR["chrome"], "node/native": RT_COLOR["node"]}
    labels = {"chrome/native": "Chrome ÷ native", "node/native": "Node.js ÷ native"}
    for ax, th in zip(axes[0], ths):
        for comp in ["chrome/native", "node/native"]:
            g = ov[(ov.threads == th) & (ov.comparison == comp)].sort_values("k")
            if g.empty:
                continue
            ax.errorbar(g.k, g.ratio, yerr=[g.ratio - g.ci95_lo, g.ci95_hi - g.ratio], color=colors[comp],
                        marker="o", markersize=6, linewidth=2, capsize=3, label=labels[comp])
            for _, r in g.iterrows():
                ax.annotate(f"{r.ratio:.1f}×", (r.k, r.ratio), xytext=(0, 8), textcoords="offset points",
                            ha="center", fontsize=8, color=INK2)
        ax.axhline(1, color=INK2, linewidth=1, linestyle="--")
        ax.set_xticks(sorted(ov.k.unique()))
        ax.set_xticklabels([f"2^{int(k)}" for k in sorted(ov.k.unique())])
        ax.set_xlabel("FFT domain size")
        ax.set_title(THREAD_LABEL[th], color=INK, loc="left")
    axes[0][0].set_ylabel("Overhead ratio (median ÷ native median)")
    axes[0][-1].legend(loc="upper left")
    fig.suptitle("RQ1 · Overhead factor vs native, with 95% bootstrap CI", x=0.01, ha="left",
                 fontweight="bold", color=INK)
    save(fig, "F2_rq1_overhead_ratio")


def fig_waterfall(med, k, th, target="chrome"):
    try:
        nat, tgt = med.loc[(k, th, "native")], med.loc[(k, th, target)]
    except KeyError:
        return
    deltas = [tgt[s] - nat[s] for s in STAGES]
    labels = ["Native\ntotal"] + [STAGE_SHORT[s] for s in STAGES] + [f"{target.title()}\ntotal"]
    fig, ax = plt.subplots(figsize=(9, 4.4))
    running = nat.sum()
    ax.bar(0, running, color=RT_COLOR["native"], width=0.6)
    ax.annotate(ms_fmt(running, None), (0, running), xytext=(0, 4), textcoords="offset points", ha="center", fontsize=8)
    for i, d in enumerate(deltas, start=1):
        bottom = running if d >= 0 else running + d
        ax.bar(i, abs(d), bottom=bottom, color="#eb6834" if d >= 0 else "#2a78d6", width=0.6)
        ax.annotate(("+" if d >= 0 else "−") + ms_fmt(abs(d), None), (i, max(running, running + d)),
                    xytext=(0, 4), textcoords="offset points", ha="center", fontsize=8, color=INK)
        ax.plot([i - 0.7, i + 0.3], [running, running], color=INK2, linewidth=0.8)
        running += d
    ax.bar(len(labels) - 1, running, color=RT_COLOR[target], width=0.6)
    ax.annotate(ms_fmt(running, None), (len(labels) - 1, running), xytext=(0, 4), textcoords="offset points",
                ha="center", fontsize=8)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, fontsize=8)
    ax.yaxis.set_major_formatter(FuncFormatter(ms_fmt))
    ax.set_ylabel("Median time per stage")
    ax.set_title(f"RQ2 · Where the extra {target.title()} time goes · domain 2^{int(k)}, {THREAD_LABEL[th]}",
                 loc="left", fontweight="bold", color=INK)
    ax.set_xlabel("Orange step = stage is slower than native (adds time) · blue step = stage is faster",
                  fontsize=8, color=INK2)
    ax.margins(y=0.08)
    save(fig, f"F3_rq2_waterfall_k{int(k)}_t{th}_{target}")


def fig_shares(med, k):
    rows = [(rt, th) for th in ["1", "all"] for rt in RUNTIMES if (k, th, rt) in med.index]
    if not rows:
        return
    fig, ax = plt.subplots(figsize=(9, 0.55 * len(rows) + 1.6))
    for y, (rt, th) in enumerate(rows):
        v = med.loc[(k, th, rt)]
        share = v / v.sum()
        left = 0.0
        for s in STAGES:
            ax.barh(y, share[s], left=left, color=STAGE_COLOR[s], edgecolor="white", linewidth=2, height=0.7,
                    label=STAGE_LABEL[s] if y == 0 else None)
            if share[s] >= 0.07:
                ax.text(left + share[s] / 2, y, f"{share[s]:.0%}", ha="center", va="center", fontsize=8, color="white")
            left += share[s]
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels([f"{RT_LABEL[rt].split(' (')[0]}, {THREAD_LABEL[th]}" for rt, th in rows])
    ax.invert_yaxis()
    ax.set_xlim(0, 1)
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0%}"))
    ax.grid(axis="y", visible=False)
    ax.legend(ncol=3, loc="upper left", bbox_to_anchor=(0, -0.12), fontsize=8)
    ax.set_title(f"RQ2 · Share of proving time per stage · domain 2^{int(k)}", loc="left",
                 fontweight="bold", color=INK)
    save(fig, f"F4_rq2_stage_shares_k{int(k)}")


def fig_memory(summ):
    g = summ.dropna(subset=["peak_rss_mb"])
    if g.empty:
        return
    fig, ax = plt.subplots(figsize=(6, 4))
    for (rt, th), h in g.groupby(["runtime", "threads"]):
        h = h.sort_values("domain")
        ax.plot(h.domain, h.peak_rss_mb, marker="o", linewidth=2, color=RT_COLOR[rt],
                linestyle="-" if th == "all" else ":", label=f"{RT_LABEL[rt].split(' (')[0]}, {THREAD_LABEL[th]}")
    ax.set_xscale("log", base=2)
    ax.set_xlabel("FFT domain size")
    ax.set_ylabel("Peak resident memory (MB)")
    ax.legend(fontsize=8)
    ax.set_title("Peak memory vs circuit size", loc="left", fontweight="bold", color=INK)
    save(fig, "F7_peak_memory")


# ------------------------------------------------------------------- main ---
def main():
    df = load()
    df = pd.concat([df.reset_index(drop=True), df.apply(stage_split, axis=1).reset_index(drop=True)], axis=1)

    bad = df[(df.phase == "warm") & (df.verified != True)]  # noqa: E712
    if len(bad):
        print(f"WARNING: {len(bad)} warm runs have unverified proofs; they are excluded.")
    warm = df[(df.phase == "warm") & (df.verified == True)].copy()  # noqa: E712

    summ = config_summary(warm)
    summ.to_csv(SUMMARY / "config_summary.csv", index=False)
    summ[summ.cv > 0.05][["runtime", "circuit", "threads", "n_runs", "cv"]].to_csv(SUMMARY / "rerun_list.csv", index=False)

    ov = pd.concat([overhead_table(warm, "total_ms"), overhead_table(warm, "prove_ms")])
    ov.to_csv(SUMMARY / "rq1_overhead.csv", index=False)
    scaling_slopes(summ).to_csv(SUMMARY / "rq1_scaling_slopes.csv", index=False)

    st, med = stage_table(warm)
    st.to_csv(SUMMARY / "rq2_stages.csv", index=False)

    cov = warm.assign(residual_pct=100 * warm.residual_ms / warm.prove_ms).groupby(
        ["runtime", "circuit", "threads"])["residual_pct"].median().reset_index()
    cov.to_csv(SUMMARY / "stage_coverage.csv", index=False)

    if "bytes" in warm:
        b = warm.dropna(subset=["bytes"])
        b = b[b.bytes.apply(lambda x: isinstance(x, dict) and len(x) > 0)]
        if len(b):
            bt = pd.DataFrame(list(b.bytes)).assign(k=b.k.values, runtime=b.runtime.values)
            bt = bt.groupby(["runtime", "k"]).median()
            bt["total_MB"] = bt.sum(axis=1) / 2 ** 20
            bt.to_csv(SUMMARY / "bridging_bytes.csv")

    cold = df[df.phase == "cold"].groupby(["runtime", "circuit", "threads"])[["total_ms", "load_ms"]].median()
    cold.to_csv(SUMMARY / "cold_start.csv")

    print("\nTables written to results/summary/:")
    for f in sorted(SUMMARY.glob("*.csv")):
        print(f"  {f.name}")
    print("\nFigures:")
    fig_scaling(summ)
    fig_ratio(ov[ov.metric == "total_ms"])
    for (k, th) in sorted({(k, th) for k, th, _ in med.index}):
        fig_waterfall(med, k, th, "chrome")
        fig_waterfall(med, k, th, "node")
    for k in sorted({k for k, _, _ in med.index}):
        fig_shares(med, k)
    fig_memory(summ)

    print("\nRQ1 headline (end-to-end, warm, median ratio [95% CI]):")
    for _, r in ov[(ov.metric == "total_ms") & (ov.comparison == "chrome/native")].iterrows():
        print(f"  2^{int(r.k):<3} {THREAD_LABEL[r.threads]:<10} Chrome/native = {r.ratio:6.2f}x  [{r.ci95_lo:.2f}, {r.ci95_hi:.2f}]")
    if len(st):
        print("\nRQ2 headline (stage with the largest share of the added time):")
        for (k, th, comp), g in st.groupby(["k", "threads", "compare"]):
            top = g.loc[g.added_ms.idxmax()]
            print(f"  2^{int(k):<3} {THREAD_LABEL[th]:<10} {comp:<17} {top.stage:<28} {top.share_of_added:6.1%} of added time")
    if len(summ[summ.cv > 0.05]):
        print(f"\n{len(summ[summ.cv > 0.05])} configuration(s) have CV > 5%: see results/summary/rerun_list.csv")


if __name__ == "__main__":
    main()
