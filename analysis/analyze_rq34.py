#!/usr/bin/env python3
"""RQ3 and RQ4 tables and figures.

    python analysis/analyze_rq34.py          # C1 circuits (default)
    python analysis/analyze_rq34.py c2_      # generality check circuits

Reads   results/raw/chrome_opt.jsonl     optimised configurations (+ B1 re-runs)
        results/raw/chrome.jsonl         October B1 baseline (used where no B1 re-run exists)
        results/raw/native.jsonl         Rapidsnark (for gap closure G)
        results/raw/native_kernels.jsonl same Rust kernels run natively (N-K)
        results/raw/micro.jsonl          per-operation benchmark (Chrome side)
        results/raw/micro_native.jsonl   per-operation benchmark (native side)
Writes  results/summary/rq3_*.csv, rq4_*.csv, rq34_*.csv and results/figures/F8..F12

Same rules as analysis/analyze.py: latest batch of each configuration only, only warm
runs with a verified proof, medians with 95% bootstrap confidence intervals.

Definitions (guide, section 6):
  speed-up      S = median(B1) / median(config)           per stage and end to end
  gap closure   G = (B1 - config) / (B1 - Rapidsnark)     0 = no gain, 1 = native speed
"""
from pathlib import Path
import json
import sys

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
RAW, SUMMARY, FIGS = ROOT / "results/raw", ROOT / "results/summary", ROOT / "results/figures"
PREFIX = sys.argv[1] if len(sys.argv) > 1 else "c1_"
TAG = ""
if PREFIX != "c1_":   # other circuit families get their own subfolders (never overwrite C1)
    SUMMARY, FIGS = SUMMARY / PREFIX.rstrip("_"), FIGS / PREFIX.rstrip("_")

RQ3 = ["T5.1", "T5.2", "T5.3", "T5.4", "T4.1", "T4.2", "T3.1", "T3.2"]
RQ4 = ["ALL", "ALL-W"]
STAGES = ["qap", "fft", "msm"]
STAGE_NAME = {"qap": "S3 QAP", "fft": "S4 NTT", "msm": "S5 MSM", "total": "End to end"}
TARGET = {"T5.1": "msm", "T5.2": "msm", "T5.3": "msm", "T5.4": "msm", "T4.1": "fft", "T4.2": "fft", "T3.1": "qap", "T3.2": "qap"}
RNG = np.random.default_rng(42)
N_BOOT = 10_000
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"
COLORS = {"B1": "#9b9a96", "T5.1": "#e87ba4", "T5.2": "#b8336a", "T5.3": "#8e2a8c", "T5.4": "#5b1a6e", "T4.1": "#eda100", "T4.2": "#a86f00",
          "T3.1": "#7fc8a9", "T3.2": "#2e8b57", "ALL": "#2a78d6", "ALL-W": "#123f7a", "native": "#0b0b0b"}
STAGE_COLOR = {"other": "#c9c8c3", "qap": "#1baf7a", "fft": "#eda100", "msm": "#e87ba4"}
plt.rcParams.update({
    "font.size": 10, "axes.edgecolor": INK2, "axes.labelcolor": INK, "xtick.color": INK2,
    "ytick.color": INK2, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True,
    "legend.frameon": False, "figure.dpi": 110, "savefig.dpi": 200, "savefig.bbox": "tight",
})


def read_jsonl(name):
    f = RAW / name
    if not f.exists():
        return pd.DataFrame()
    return pd.DataFrame([json.loads(x) for x in f.read_text().splitlines() if x.strip()])


def latest(df, keys):
    return df[df["batch"] == df.groupby(keys)["batch"].transform("max")].copy()


def stages(st):
    return {
        "qap": st.get("S3_buildABC", 0) + st.get("S3_joinABC", 0),
        "fft": st.get("S4_fft", 0),
        "msm": sum(v for k, v in st.items() if k.startswith("S5_msm")),
    }


def boot_median(x):
    x = np.asarray(x, float)
    return np.median(x[RNG.integers(0, len(x), size=(N_BOOT, len(x)))], axis=1)


def ci(s):
    return np.percentile(s, [2.5, 97.5])


def save(fig, name):
    name += TAG
    fig.savefig(FIGS / f"{name}.png")
    fig.savefig(FIGS / f"{name}.pdf")
    plt.close(fig)
    print(f"  figure  results/figures/{name}.png")


def write(df, name):
    p = SUMMARY / f"{name}{TAG}.csv"
    df.to_csv(p, index=False)
    print(f"  table   {p.relative_to(ROOT)}  ({len(df)} rows)")


SUMMARY.mkdir(parents=True, exist_ok=True)
FIGS.mkdir(parents=True, exist_ok=True)


# ------------------------------------------------------------------ load ---
def load():
    opt = read_jsonl("chrome_opt.jsonl")
    if opt.empty:
        sys.exit("No results/raw/chrome_opt.jsonl yet (optimised runs start in week 4).")
    opt = opt[opt["circuit"].str.startswith(PREFIX)]
    opt["threads"] = opt["threads"].astype(str)
    opt = latest(opt, ["config", "circuit", "threads"])

    # B1: prefer a re-run in chrome_opt.jsonl (same Chrome version as the optimised runs),
    # otherwise the October baseline in chrome.jsonl.
    old = read_jsonl("chrome.jsonl")
    if not old.empty:
        old = old[old["circuit"].str.startswith(PREFIX)]
        old["threads"] = old["threads"].astype(str)
        old = latest(old, ["circuit", "threads"])
        old["config"] = "B1"
        have = set(map(tuple, opt.loc[opt.config == "B1", ["circuit", "threads"]].values))
        old = old[[tuple(x) not in have for x in old[["circuit", "threads"]].values]]
        old["b1_source"] = "October"
    opt["b1_source"] = np.where(opt["config"] == "B1", "re-run", "")
    df = pd.concat([opt, old], ignore_index=True) if not old.empty else opt
    df = df[(df["phase"] == "warm")]
    bad = df[df["verified"] != True]  # noqa: E712
    if len(bad):
        print(f"WARNING: {len(bad)} unverified proofs excluded")
    df = df[df["verified"] == True].copy()  # noqa: E712
    for s in STAGES:
        df[s] = df["stages"].apply(lambda st: stages(st)[s])
    df["total"] = df["total_ms"]

    nat = read_jsonl("native.jsonl")
    if not nat.empty:
        nat = nat[nat["circuit"].str.startswith(PREFIX)]
        nat["threads"] = nat["threads"].astype(str)
        nat = latest(nat, ["circuit", "threads"])
        nat = nat[(nat["phase"] == "warm") & (nat["verified"] == True)].copy()  # noqa: E712
        for s in STAGES:
            nat[s] = nat["stages"].apply(lambda st: stages(st)[s])
        nat["total"] = nat["total_ms"]
    return df, nat


# ---------------------------------------------------------------- tables ---
def speedup_table(df, nat, configs):
    out = []
    for (circ, th), g in df.groupby(["circuit", "threads"]):
        b = g[g.config == "B1"]
        if b.empty:
            continue
        n = nat[(nat.circuit == circ) & (nat.threads == th)] if not nat.empty else pd.DataFrame()
        for cfg in configs:
            o = g[g.config == cfg]
            if o.empty:
                continue
            for s in STAGES + ["total"]:
                xb, xo = b[s].to_numpy(), o[s].to_numpy()
                boots = boot_median(xb) / boot_median(xo)
                lo, hi = ci(boots)
                row = {"config": cfg, "circuit": circ, "k": int(o.k.iloc[0]), "threads": th, "stage": STAGE_NAME[s],
                       "b1_ms": np.median(xb), "opt_ms": np.median(xo), "speedup": np.median(xb) / np.median(xo),
                       "ci95_lo": lo, "ci95_hi": hi, "n_b1": len(xb), "n_opt": len(xo),
                       "b1_source": b["b1_source"].iloc[0]}
                if not n.empty:
                    xn = n[s].to_numpy()
                    gap = np.median(xb) - np.median(xn)
                    row["native_ms"] = np.median(xn)
                    row["gap_closure_G"] = (np.median(xb) - np.median(xo)) / gap if gap > 0 else np.nan
                    gb = (boot_median(xb) - boot_median(xo)) / (boot_median(xb) - boot_median(xn))
                    row["G_ci95_lo"], row["G_ci95_hi"] = ci(gb)
                out.append(row)
    return pd.DataFrame(out)


def thread_scaling(df, nk):
    """1-thread time / all-core time per stage, for SnarkJS (B1), the kernels and native."""
    out = []
    pairs = {"B1 (SnarkJS)": ("B1", "B1"), "NTT kernel (T4.1 -> T4.2)": ("T4.1", "T4.2"),
             "QAP kernel (T3.1 -> T3.2)": ("T3.1", "T3.2"), "MSM kernel (T5.1)": ("T5.1", "T5.1"),
             "ALL": ("ALL", "ALL")}
    for circ, g in df.groupby("circuit"):
        for label, (c1, ca) in pairs.items():
            a = g[(g.config == c1) & (g.threads == "1")]
            b = g[(g.config == ca) & (g.threads == "all")]
            if a.empty or b.empty:
                continue
            for s in STAGES:
                out.append({"circuit": circ, "k": int(a.k.iloc[0]), "what": label, "stage": STAGE_NAME[s],
                            "t1_ms": a[s].median(), "tall_ms": b[s].median(), "thread_speedup": a[s].median() / b[s].median()})
        if not nk.empty:
            x = nk[nk.circuit == circ]
            a, b = x[x.threads == "1"], x[x.threads == "all"]
            if len(a) and len(b):
                for s in STAGES:
                    out.append({"circuit": circ, "k": int(a.k.iloc[0]), "what": "Native kernels (N-K)", "stage": STAGE_NAME[s],
                                "t1_ms": a[s].median(), "tall_ms": b[s].median(), "thread_speedup": a[s].median() / b[s].median()})
    return pd.DataFrame(out)


def same_source(df, nk):
    """WASM kernel stage time / native kernel stage time, identical Rust source."""
    if nk.empty:
        return pd.DataFrame()
    out = []
    for (circ, th), g in df.groupby(["circuit", "threads"]):
        x = nk[(nk.circuit == circ) & (nk.threads == th)]
        if x.empty:
            continue
        for cfg in ["ALL", "ALL-W"]:
            o = g[g.config == cfg]
            if o.empty:
                continue
            for s in STAGES:
                xo, xn = o[s].to_numpy(), x[s].to_numpy()
                lo, hi = ci(boot_median(xo) / boot_median(xn))
                out.append({"circuit": circ, "k": int(o.k.iloc[0]), "threads": th, "wasm_build": cfg, "stage": STAGE_NAME[s],
                            "wasm_ms": np.median(xo), "native_kernel_ms": np.median(xn),
                            "wasm_over_native": np.median(xo) / np.median(xn), "ci95_lo": lo, "ci95_hi": hi})
    return pd.DataFrame(out)


def ported_msm(df, nk_all):
    """T5.3/T5.4: the ported native MSM algorithms, in Chrome and natively (same source).
    gain = T5.1 (or native arkworks) S5 time / this algorithm's S5 time. If chrome_gain is
    close to native_gain, the algorithm closes the implementation part of the gap without
    changing the WebAssembly penalty (wasm_over_native stays the same)."""
    algo_cfg = {"ark": "T5.1", "ba": "T5.3", "glv": "T5.4"}
    out = []
    for (circ, th), g in df.groupby(["circuit", "threads"]):
        base = g[g.config == "T5.1"]
        x = nk_all[(nk_all.circuit == circ) & (nk_all.threads == th)] if not nk_all.empty else pd.DataFrame()
        nbase = x[x.msm_algo == "ark"] if not x.empty else pd.DataFrame()
        for algo, cfg in algo_cfg.items():
            o = g[g.config == cfg]
            if o.empty:
                continue
            row = {"circuit": circ, "k": int(o.k.iloc[0]), "threads": th, "config": cfg, "msm_algo": algo,
                   "chrome_S5_ms": o["msm"].median()}
            if not base.empty:
                row["chrome_gain_vs_T5.1"] = base["msm"].median() / o["msm"].median()
                row["chrome_gain_ci95_lo"], row["chrome_gain_ci95_hi"] = ci(boot_median(base["msm"].to_numpy()) / boot_median(o["msm"].to_numpy()))
            n = x[x.msm_algo == algo] if not x.empty else pd.DataFrame()
            if not n.empty:
                row["native_S5_ms"] = n["msm"].median()
                row["wasm_over_native"] = o["msm"].median() / n["msm"].median()
                if not nbase.empty:
                    row["native_gain_vs_ark"] = nbase["msm"].median() / n["msm"].median()
            out.append(row)
    return pd.DataFrame(out)


def memory_and_cold(df):
    out = []
    for (cfg, circ, th), g in df.groupby(["config", "circuit", "threads"]):
        out.append({"config": cfg, "circuit": circ, "k": int(g.k.iloc[0]), "threads": th,
                    "page_mem_MiB": (g["page_mem_bytes"].dropna().max() / 2**20) if "page_mem_bytes" in g and g["page_mem_bytes"].notna().any() else np.nan,
                    "kernel_wasm_mem_MiB": (g["kernel_mem_bytes"].max() / 2**20) if "kernel_mem_bytes" in g and g["kernel_mem_bytes"].notna().any() else np.nan})
    mem = pd.DataFrame(out)
    raw = read_jsonl("chrome_opt.jsonl")
    cold = pd.DataFrame()
    if not raw.empty and "kernel_load_ms" in raw:
        raw = raw[raw["circuit"].str.startswith(PREFIX)]
        raw["threads"] = raw["threads"].astype(str)
        raw = latest(raw, ["config", "circuit", "threads"])
        c = raw[raw.phase == "cold"][["config", "circuit", "threads", "total_ms", "kernel_load_ms"]]
        w = raw[raw.phase == "warm"].groupby(["config", "circuit", "threads"])["total_ms"].median().rename("warm_median_ms")
        cold = c.merge(w, on=["config", "circuit", "threads"])
        cold["cold_penalty_ms"] = cold["total_ms"] - cold["warm_median_ms"]
    return mem, cold


def micro_table():
    a, b = read_jsonl("micro.jsonl"), read_jsonl("micro_native.jsonl")
    df = pd.concat([x for x in (a, b) if not x.empty], ignore_index=True) if not (a.empty and b.empty) else pd.DataFrame()
    if df.empty or "ns_per_op" not in df:
        return df
    df = df[df["ns_per_op"].notna()]
    t = df.groupby(["op", "build"])["ns_per_op"].median().rename("median_ns_per_op").reset_index()
    nat = t[t.build == "native"].set_index("op")["median_ns_per_op"]
    t["x_native"] = t.apply(lambda r: r.median_ns_per_op / nat.get(r.op, np.nan), axis=1)
    order = {"native": 0, "plain": 1, "simd": 2, "wide": 3}
    return t.sort_values(["op", "build"], key=lambda s: s.map(order) if s.name == "build" else s)


# --------------------------------------------------------------- figures ---
def fig_speedup(sp):
    """F8: end-to-end speed-up of every RQ3 technique and the RQ4 combinations, per size."""
    tot = sp[sp.stage == "End to end"]
    if tot.empty:
        return
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8), sharey=True)
    cfgs = [c for c in RQ3 + RQ4 if c in set(tot.config)]
    for ax, th in zip(axes, ["1", "all"]):
        d = tot[tot.threads == th]
        ks = sorted(d.k.unique())
        w = 0.8 / max(len(cfgs), 1)
        for i, c in enumerate(cfgs):
            x = d[d.config == c].set_index("k").reindex(ks)
            pos = np.arange(len(ks)) + (i - (len(cfgs) - 1) / 2) * w
            ax.bar(pos, x.speedup, w, label=c, yerr=[x.speedup - x.ci95_lo, x.ci95_hi - x.speedup], capsize=1.5,
                   color=COLORS.get(c, plt.cm.tab10(i)), error_kw={"elinewidth": 0.7})
        ax.axhline(1, color=INK2, lw=0.8)
        ax.set_xticks(range(len(ks)), [f"$2^{{{k}}}$" for k in ks])
        ax.set_title("1 thread" if th == "1" else "all cores", fontsize=10, loc="left")
        ax.set_xlabel("circuit size")
    axes[0].set_ylabel("end-to-end speed-up vs B1 (×)")
    axes[1].legend(ncol=2, fontsize=8, loc="upper left")
    save(fig, "F8_rq34_speedup")


def fig_gap(sp):
    """F9: gap closure G of the combined configurations."""
    tot = sp[(sp.stage == "End to end") & sp.config.isin(RQ4)]
    if tot.empty or "gap_closure_G" not in tot:
        return
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.4), sharey=True)
    for ax, th in zip(axes, ["1", "all"]):
        d = tot[tot.threads == th]
        for c in RQ4:
            x = d[d.config == c].sort_values("k")
            if x.empty:
                continue
            ax.errorbar(x.k, x.gap_closure_G, yerr=[x.gap_closure_G - x.G_ci95_lo, x.G_ci95_hi - x.gap_closure_G],
                        marker="o", ms=4, capsize=2, label=c, color=COLORS[c])
        ax.axhline(0, color=INK2, lw=0.8)
        ax.axhline(1, color=INK2, lw=0.8, ls="--")
        ax.set_title("1 thread" if th == "1" else "all cores", fontsize=10, loc="left")
        ks = sorted(d.k.unique())
        ax.set_xticks(ks, [f"$2^{{{k}}}$" for k in ks])
        ax.set_xlabel("circuit size")
    axes[0].set_ylabel("gap closure G  (1 = native speed)")
    axes[0].legend()
    save(fig, "F9_rq4_gap_closure")


def fig_stages(df, nat, k):
    """F10: where the time goes before and after, at one size (stacked stage medians)."""
    rows = []
    for th in ["1", "all"]:
        for cfg in ["B1", "ALL", "ALL-W"]:
            g = df[(df.config == cfg) & (df.threads == th) & (df.k == k)]
            if g.empty:
                continue
            m = {s: g[s].median() for s in STAGES}
            rows.append((th, cfg, g.total.median() - sum(m.values()), m))
        if not nat.empty:
            g = nat[(nat.threads == th) & (nat.k == k)]
            if not g.empty:
                m = {s: g[s].median() for s in STAGES}
                rows.append((th, "Rapidsnark", g.total.median() - sum(m.values()), m))
    if not rows:
        return
    fig, ax = plt.subplots(figsize=(8, 0.42 * len(rows) + 1.2))
    labels = []
    for i, (th, cfg, other, m) in enumerate(rows):
        left = 0
        for s, v in [("other", other)] + [(s, m[s]) for s in ["qap", "fft", "msm"]]:
            ax.barh(i, v / 1000, left=left / 1000, color=STAGE_COLOR[s], label=s if i == 0 else None, height=0.65)
            left += v
        labels.append(f"{cfg}  ({'1 thread' if th == '1' else 'all cores'})")
    ax.set_yticks(range(len(rows)), labels)
    ax.invert_yaxis()
    ax.set_xlabel("median time (s)")
    names = {"other": "S0–S2, S6", "qap": "S3 QAP", "fft": "S4 NTT", "msm": "S5 MSM"}
    h, l = ax.get_legend_handles_labels()
    ax.legend(h, [names[x] for x in l], ncol=4, loc="lower right", fontsize=8)
    ax.set_title(f"Stage times before and after, $2^{{{k}}}$ constraints", fontsize=10, loc="left")
    save(fig, f"F10_rq34_stages_k{k}")


def fig_micro(mt):
    """F11: cost of one operation in each build, relative to native."""
    if mt.empty:
        return
    fig, axes = plt.subplots(1, 2, figsize=(8, 3))
    for ax, op, title in zip(axes, ["fr_mul", "g1_add"], ["Fr multiplication", "G1 mixed addition"]):
        d = mt[mt.op == op]
        ax.bar(d.build, d.median_ns_per_op, color=[COLORS.get("native") if b == "native" else "#2a78d6" for b in d.build])
        for i, (v, x) in enumerate(zip(d.median_ns_per_op, d.x_native)):
            ax.text(i, v, f"{x:.2f}×", ha="center", va="bottom", fontsize=8)
        ax.set_title(title, fontsize=10, loc="left")
        ax.set_ylabel("ns per operation")
    save(fig, "F11_micro_per_operation")


# ------------------------------------------------------------------ main ---
def main():
    # The per-operation table needs no other data, so it is written first (usable from week 2)
    mt = micro_table()
    if not mt.empty:
        write(mt, "rq34_micro")
        fig_micro(mt)
    df, nat = load()
    print(f"configurations: {sorted(df.config.unique())}  circuits: {sorted(df.circuit.unique())}")
    nk = read_jsonl("native_kernels.jsonl")
    if not nk.empty:
        nk = nk[nk["circuit"].str.startswith(PREFIX)]
        nk["threads"] = nk["threads"].astype(str)
        nk["msm_algo"] = nk["msm_algo"].fillna("ark") if "msm_algo" in nk else "ark"
        nk = latest(nk, ["circuit", "threads", "msm_algo"])
        nk = nk[nk.phase == "warm"].copy()
        for s in STAGES:
            nk[s] = nk["stages"].apply(lambda st: stages(st)[s])
    nk_all = nk
    if not nk.empty:
        nk = nk[nk.msm_algo == "ark"]   # same-source and thread tables use the T5.1 algorithm

    # Drift check: B1 re-runs against the October baseline
    re = df[(df.config == "B1") & (df.b1_source == "re-run")]
    old = read_jsonl("chrome.jsonl")
    if len(re) and not old.empty:
        old = old[old["circuit"].str.startswith(PREFIX)]
        old["threads"] = old["threads"].astype(str)
        old = latest(old, ["circuit", "threads"])
        old = old[(old.phase == "warm") & (old.verified == True)]  # noqa: E712
        rows = []
        for (c, t), g in re.groupby(["circuit", "threads"]):
            o = old[(old.circuit == c) & (old.threads == t)]["total_ms"].to_numpy()
            if len(o):
                lo, hi = ci(boot_median(g.total.to_numpy()) / boot_median(o))
                rows.append({"circuit": c, "threads": t, "rerun_ms": g.total.median(), "october_ms": np.median(o),
                             "ratio": g.total.median() / np.median(o), "ci95_lo": lo, "ci95_hi": hi,
                             "within_5pct": abs(g.total.median() / np.median(o) - 1) <= 0.05})
        write(pd.DataFrame(rows), "rq34_baseline_drift")

    sp3 = speedup_table(df, nat, RQ3)
    sp4 = speedup_table(df, nat, RQ4)
    if sp3.empty and sp4.empty:
        sys.exit("No optimised configuration has a matching B1 run yet (B1 in chrome_opt.jsonl or chrome.jsonl).")
    write(sp3, "rq3_speedup")
    write(sp4, "rq4_speedup")
    write(thread_scaling(df, nk), "rq34_thread_scaling")
    write(same_source(df, nk), "rq34_same_source")
    write(ported_msm(df, nk_all), "rq34_ported_msm")
    # 5% rule (same as RQ1): configurations whose total time varies too much get re-run once
    cv = (df.groupby(["config", "circuit", "threads"])["total_ms"]
            .agg(n="count", cv=lambda x: x.std(ddof=1) / x.mean() if len(x) > 1 else 0.0).reset_index())
    write(cv[cv.cv > 0.05].sort_values("cv", ascending=False), "rq34_rerun_list")
    mem, cold = memory_and_cold(df)
    write(mem, "rq34_memory")
    write(cold, "rq34_cold_start")


    fig_speedup(pd.concat([sp3, sp4]))
    if not sp4.empty:
        fig_gap(sp4)
    have = sorted(set(df[df.config == "B1"].k) & set(df[df.config.isin(RQ4)].k))
    for k in have[-3:]:   # the three largest sizes that have both B1 and a combined configuration
        fig_stages(df, nat, int(k))

    # Headline lines for the write-up
    print("\nHeadline (end to end, all cores):")
    for _, r in (sp4 if sp4.empty else sp4[(sp4.stage == "End to end") & (sp4.threads == "all")].sort_values(["config", "k"])).iterrows():
        g = f", G = {r.gap_closure_G:.2f} [{r.G_ci95_lo:.2f}, {r.G_ci95_hi:.2f}]" if "gap_closure_G" in r and pd.notna(r.get("gap_closure_G")) else ""
        print(f"  {r.config:6s} 2^{r.k}: {r.b1_ms/1000:.2f} s -> {r.opt_ms/1000:.2f} s, "
              f"speed-up {r.speedup:.2f}x [{r.ci95_lo:.2f}, {r.ci95_hi:.2f}]{g}")


if __name__ == "__main__":
    main()
