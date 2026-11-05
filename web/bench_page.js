// Page side of the browser benchmark: reads the URL, starts the worker, collects results.
// Playwright (runner/chrome_bench.mjs, chrome_check.mjs, chrome_micro.mjs) polls
// window.__benchDone and reads window.__benchResults.
//
// URL parameters:
//   circuit, threads (1|all), runs, warmup        as before
//   kernel  (plain|wide|threads|threads-wide)      Rust kernel build; empty = stock SnarkJS
//   opt     (e.g. msm or qap,ntt,msm)              stages that use the kernel
//   mode    (bench|check|micro)                    see bench_worker.js
//   builds, iters, reps                            micro mode only
(function () {
  const q = new URLSearchParams(location.search);
  const cfg = {
    mode: q.get("mode") || "bench",
    circuit: q.get("circuit") || "multiplier",
    threads: q.get("threads") || "all",
    runs: Number(q.get("runs") || 30),
    warmup: Number(q.get("warmup") || 5),
    kernel: q.get("kernel") || "",
    opt: q.get("opt") || "",
    builds: q.get("builds") || "",
    iters: q.get("iters") || "",
    reps: q.get("reps") || "",
  };
  window.__benchDone = false;
  window.__benchError = null;
  window.__benchResults = null;

  const logEl = document.getElementById("log");
  const log = (m) => { console.log(m); logEl.textContent += m + "\n"; };
  log(`config ${JSON.stringify(cfg)}`);
  log(`crossOriginIsolated=${self.crossOriginIsolated}  hardwareConcurrency=${navigator.hardwareConcurrency}`);

  // Page-level memory (page + its workers), measured once per configuration after the
  // runs, while the worker is still alive. It can take several seconds, so it is never
  // inside a timed proof. Needs a cross-origin isolated page.
  async function pageMemory() {
    if (!self.crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return null;
    try {
      const m = await performance.measureUserAgentSpecificMemory();
      return m.bytes;
    } catch (e) {
      log(`memory measurement unavailable: ${e.message}`);
      return null;
    }
  }

  // S0 part 1: worker start-up (create the worker and load snarkjs into it)
  const t0 = performance.now();
  const worker = new Worker("/web/bench_worker.js");
  let workerStartMs = null;

  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === "ready") {
      workerStartMs = performance.now() - t0;
      log(`worker ready in ${workerStartMs.toFixed(1)} ms`);
      worker.postMessage(cfg);
    } else if (m.type === "progress") {
      log(m.msg);
    } else if (m.type === "done") {
      const memBytes = cfg.mode === "bench" ? await pageMemory() : null;
      if (m.records) {
        for (const r of m.records) {
          r.worker_start_ms = r.iter === 0 ? workerStartMs : 0;
          if (cfg.mode === "bench") r.page_mem_bytes = memBytes;
        }
      }
      window.__benchResults = { ...m, userAgent: navigator.userAgent };
      window.__benchDone = true;
      if (m.check) log(`CHECK ${m.check.ok ? "PASSED" : "FAILED"}: ${JSON.stringify(m.check.checks)}`);
      if (memBytes) log(`page memory: ${(memBytes / 1048576).toFixed(0)} MiB`);
      log("DONE");
    } else if (m.type === "error") {
      window.__benchError = m.message;
      log("ERROR: " + m.message);
    }
  };
  worker.onerror = (e) => {
    window.__benchError = `worker error: ${e.message} (${e.filename}:${e.lineno})`;
    log(window.__benchError);
  };
})();
