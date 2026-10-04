// Page side of the browser benchmark: reads the URL, starts the worker, collects results.
// Playwright (runner/chrome_bench.mjs) polls window.__benchDone and reads window.__benchResults.
(function () {
  const q = new URLSearchParams(location.search);
  const cfg = {
    circuit: q.get("circuit") || "multiplier",
    threads: q.get("threads") || "all",
    runs: Number(q.get("runs") || 30),
    warmup: Number(q.get("warmup") || 5),
  };
  window.__benchDone = false;
  window.__benchError = null;
  window.__benchResults = null;

  const logEl = document.getElementById("log");
  const log = (m) => { console.log(m); logEl.textContent += m + "\n"; };
  log(`config ${JSON.stringify(cfg)}`);
  log(`crossOriginIsolated=${self.crossOriginIsolated}  hardwareConcurrency=${navigator.hardwareConcurrency}`);

  // S0 part 1: worker start-up (create the worker and load snarkjs into it)
  const t0 = performance.now();
  const worker = new Worker("/web/bench_worker.js");
  let workerStartMs = null;

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "ready") {
      workerStartMs = performance.now() - t0;
      log(`worker ready in ${workerStartMs.toFixed(1)} ms`);
      worker.postMessage(cfg);
    } else if (m.type === "progress") {
      log(m.msg);
    } else if (m.type === "done") {
      for (const r of m.records) r.worker_start_ms = r.iter === 0 ? workerStartMs : 0;
      window.__benchResults = { records: m.records, userAgent: navigator.userAgent };
      window.__benchDone = true;
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
