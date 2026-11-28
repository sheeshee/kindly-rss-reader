// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end check for the paginated article view.
//
// Boots the app against a throwaway data directory, subscribes to a real feed
// (BBC News by default), opens a few articles in a Kindle-sized viewport and
// verifies that:
//   - the article is split into pages and never scrolls vertically
//   - no line of text is cut in half at a page boundary
//   - a tap on the text goes to the next page; a tap on a link does not
//   - the toolbar buttons move by pages (next/prev/first/last)
//   - zooming re-paginates without breaking the above
//   - list views (feed list) still scroll vertically
// Screenshots of each page are written to tests/e2e/out/.
//
// Usage:
//   cargo build && node tests/e2e/pagination.mjs [--feed URL] [--keep-open]
//
// Requires Playwright (`npm i -D playwright && npx playwright install chromium`).

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const argValue = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const FEED_URL = argValue("--feed", "https://feeds.bbci.co.uk/news/rss.xml");
const PORT = Number(argValue("--port", "3917"));
const ARTICLES_TO_CHECK = Number(argValue("--articles", "3"));
const KEEP_OPEN = args.includes("--keep-open");
// Kindle Paperwhite-ish CSS viewport.
const VIEWPORT = { width: 758, height: 1024 };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(repoRoot, "tests/e2e/out");
const binary = path.join(repoRoot, "target/debug/kindle-rss-reader");
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

// Returns a point inside #body whose element is not inside a link.
async function nonLinkPoint(page) {
  return page.evaluate(() => {
    const r = document.getElementById("body").getBoundingClientRect();
    for (let fy = 0.5; fy < 0.95; fy += 0.05) {
      for (let fx = 0.5; fx < 0.95; fx += 0.1) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest("a") && el.closest("#body")) return { x, y };
      }
    }
    return { x: r.left + r.width / 2, y: r.top + r.height - 5 };
  });
}

const state = (page) =>
  page.evaluate(() => {
    const b = document.getElementById("body");
    return {
      currentPage,
      pageCount,
      scrollLeft: b.scrollLeft,
      scrollTop: b.scrollTop,
      clientWidth: b.clientWidth,
      clientHeight: b.clientHeight,
      scrollHeight: b.scrollHeight,
      indicator: document.getElementById("pageIndicator")?.textContent,
    };
  });

// Lines of text that straddle the visible area of #body (partially visible).
const clippedLines = (page) =>
  page.evaluate(() => {
    const body = document.getElementById("body");
    const box = body.getBoundingClientRect();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const bad = [];
    const range = document.createRange();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const horizontallyVisible = r.right > box.left + 1 && r.left < box.right - 1;
        if (!horizontallyVisible) continue;
        const partiallyVisible =
          (r.top < box.top - 1 && r.bottom > box.top + 1) ||
          (r.top < box.bottom - 1 && r.bottom > box.bottom + 1);
        const horizontallyCut = r.left < box.left - 1 || r.right > box.right + 1;
        if (partiallyVisible || horizontallyCut) {
          bad.push(node.textContent.trim().slice(0, 40));
        }
      }
    }
    return bad;
  });

async function checkArticle(page, url, label) {
  console.log(`\n# ${label}: ${url}`);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(300);

  let s = await state(page);
  check(s.pageCount >= 1, `paginated (${s.pageCount} pages)`);
  check(s.indicator === `1/${s.pageCount}`, `indicator shows "${s.indicator}"`);
  check(s.scrollHeight <= s.clientHeight + 1, `no vertical overflow (${s.scrollHeight} <= ${s.clientHeight})`);

  // Walk every page with taps, checking for clipped lines and screenshotting.
  const pt = await nonLinkPoint(page);
  const allClipped = [];
  for (let i = 0; i < s.pageCount; i++) {
    const cur = await state(page);
    // The browser may clamp the last page a few px short of a full page; that
    // is fine as long as it stays within the column gap (checked by clippedLines).
    const tolerance = i === s.pageCount - 1 ? 30 : 2;
    check(cur.currentPage === i && Math.abs(cur.scrollLeft - i * cur.clientWidth) < tolerance,
      `page ${i + 1}: at scrollLeft ${cur.scrollLeft}`);
    const clipped = await clippedLines(page);
    allClipped.push(...clipped.map((t) => `p${i + 1}: ${t}`));
    await page.screenshot({ path: path.join(outDir, `${label}-page${i + 1}.png`) });
    await page.touchscreen.tap(pt.x, pt.y);
    await page.waitForTimeout(50);
  }
  check(allClipped.length === 0, `no lines cut at page edges${allClipped.length ? ": " + allClipped.slice(0, 3).join(" | ") : ""}`);

  s = await state(page);
  check(s.currentPage === s.pageCount - 1, "tap on last page stays on last page");

  // Toolbar buttons.
  await page.click("#scrollToTopButton");
  check((await state(page)).currentPage === 0, "top button -> first page");
  if (s.pageCount > 1) {
    await page.click("#scrollDownButton");
    check((await state(page)).currentPage === 1, "down button -> next page");
    await page.click("#scrollUpButton");
    check((await state(page)).currentPage === 0, "up button -> previous page");
  }
  await page.click("#scrollBottomButton");
  check((await state(page)).currentPage === s.pageCount - 1, "bottom button -> last page");
  await page.click("#scrollToTopButton");

  // Tapping a link must not turn the page (navigation blocked for the test).
  const hasLink = await page.evaluate(() => {
    const a = [...document.querySelectorAll("#body a")].find((a) => {
      const r = a.getBoundingClientRect();
      const b = document.getElementById("body").getBoundingClientRect();
      return r.width > 0 && r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom;
    });
    if (!a) return false;
    window.addEventListener("click", (e) => e.preventDefault(), true);
    a.setAttribute("data-e2e-link", "1");
    return true;
  });
  if (hasLink) {
    await page.click("[data-e2e-link]");
    check((await state(page)).currentPage === 0, "tap on link does not turn page");
  } else {
    console.log("  skip no link visible on first page");
  }

  // Zoom re-paginates.
  await page.click("#zoomInButton");
  await page.click("#zoomInButton");
  await page.waitForTimeout(100);
  const z = await state(page);
  check(z.pageCount >= s.pageCount, `zoom in re-paginates (${s.pageCount} -> ${z.pageCount} pages)`);
  check(z.scrollHeight <= z.clientHeight + 1, "no vertical overflow after zoom");
  const zClipped = [];
  for (let i = 0; i < z.pageCount; i++) {
    await page.evaluate((p) => showPage(p), i);
    zClipped.push(...(await clippedLines(page)));
  }
  check(zClipped.length === 0, `no lines cut after zoom${zClipped.length ? ": " + zClipped.slice(0, 3).join(" | ") : ""}`);
  await page.screenshot({ path: path.join(outDir, `${label}-zoomed.png`) });
  await page.click("#zoomOutButton");
  await page.click("#zoomOutButton");
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), "kindly-e2e-"));
  for (const d of ["articles", "favicons"]) mkdirSync(path.join(dataDir, d));

  const server = spawn(binary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      IP: "127.0.0.1",
      PORT: String(PORT),
      DATA_PATH: dataDir,
      STATIC_DATA_PATH: repoRoot,
      MAX_ARTICLES_QTY_TO_DOWNLOAD: String(ARTICLES_TO_CHECK),
      RUST_LOG: process.env.RUST_LOG || "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let browser;
  try {
    await waitForServer();
    console.log(`server up on ${base}, data in ${dataDir}`);

    const add = await fetch(base + "/feed/add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: FEED_URL }),
      redirect: "manual",
    });
    if (add.status >= 400) throw new Error(`adding feed failed: ${add.status} ${await add.text()}`);
    console.log(`added feed ${FEED_URL}`);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true });
    const page = await context.newPage();

    await page.goto(base + "/");
    const feedHref = await page.getAttribute("#body a", "href");
    await page.goto(new URL(feedHref, base + "/").href);
    const articleUrls = await page.$$eval("#body a[href*='/article/']", (as) => as.map((a) => a.href));
    if (articleUrls.length === 0) throw new Error("feed has no articles");

    // Regression: list views keep vertical scrolling.
    console.log("\n# article list");
    const before = await page.evaluate(() => document.getElementById("body").scrollTop);
    await page.click("#scrollDownButton");
    const after = await page.evaluate(() => document.getElementById("body").scrollTop);
    const scrollable = await page.evaluate(() => {
      const b = document.getElementById("body");
      return b.scrollHeight > b.clientHeight;
    });
    check(!scrollable || after > before, `list scrolls vertically (${before} -> ${after})`);

    for (const [i, url] of articleUrls.slice(0, ARTICLES_TO_CHECK).entries()) {
      await checkArticle(page, url, `article${i + 1}`);
    }

    if (KEEP_OPEN) {
      console.log(`\n--keep-open: server running at ${base} (Ctrl+C to stop)`);
      await new Promise(() => {});
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — screenshots in ${path.relative(repoRoot, outDir)}/`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
