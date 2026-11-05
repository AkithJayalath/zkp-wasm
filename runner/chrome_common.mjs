// Shared Playwright launcher for the browser runners (bench, check, micro).
// A fresh browser per call, so every configuration starts cold.
//
// Env: HEADFUL=1 shows the window; BROWSER_CHANNEL=chromium uses Playwright's Chromium
//      instead of Google Chrome; CHROME_PATH=/path/to/chrome uses that binary;
//      NO_ISOLATION=1 serves without COOP/COEP (troubleshooting only).
import { chromium } from "playwright";
import { startServer } from "../web/server.mjs";

export async function runPage(params, { flags = [] } = {}) {
  const PORT = Number(process.env.PORT || 8123);
  const isolate = process.env.NO_ISOLATION !== "1";
  const channel = process.env.BROWSER_CHANNEL || "chrome";
  const server = await startServer({ port: PORT, isolate });
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel }),
    headless: process.env.HEADFUL !== "1",
    args: flags,
  });
  const browserName = `${process.env.CHROME_PATH ? "custom" : channel} ${browser.version()}`;
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("console", (m) => console.log(`[chrome] ${m.text()}`));
    const crashed = new Promise((_, reject) => page.on("crash", () => reject(new Error("browser tab crashed (out of memory?)"))));
    crashed.catch(() => {});
    await page.goto(`http://127.0.0.1:${PORT}/web/bench.html?` + new URLSearchParams(params));
    await Promise.race([
      page.waitForFunction(() => window.__benchDone || window.__benchError, null, { timeout: 0, polling: 1000 }),
      crashed,
    ]);
    const res = await page.evaluate(() => ({ error: window.__benchError, results: window.__benchResults }));
    if (res.error) throw new Error(res.error);
    return { ...res.results, browser: browserName, flags };
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}
