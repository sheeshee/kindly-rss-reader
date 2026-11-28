// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end check for the paginated article view.
//
// Boots the app against a throwaway data directory, subscribes to a real feed
// (BBC News by default), opens the lists and a few articles in a Kindle-sized
// viewport and verifies that:
//   - articles and lists are split into pages and never scroll vertically
//   - no line of text / list row is cut in half at a page boundary
//   - a tap on the right half goes forward, on the left half goes back,
//     and a tap on a link does not turn the page
//   - the toolbar buttons move by pages (next/prev/first/last)
//   - images keep their aspect ratio and are at most half a page tall
//   - a short tap on an image turns the page; a long press opens it full
//     screen and a tap closes it
//   - zooming re-paginates without breaking the above
//   - a list remembers its page when you come back to it
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

// Returns a point in the given half ("left"/"right") of #body that is not on
// a link or an image, so tapping it turns the page.
async function tapPoint(page, side) {
  return page.evaluate((side) => {
    const r = document.getElementById("body").getBoundingClientRect();
    const xs = side === "left" ? [0.05, 0.15, 0.25, 0.35, 0.45] : [0.95, 0.85, 0.75, 0.65, 0.55];
    for (let fy = 0.05; fy < 1; fy += 0.05) {
      for (const fx of xs) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        const el = document.elementFromPoint(x, y);
        if (el && el.closest("#body") && !el.closest("a") && el.tagName !== "IMG") return { x, y };
      }
    }
    return null;
  }, side);
}

async function tapSide(page, side) {
  const pt = await tapPoint(page, side);
  if (!pt) return false;
  await page.touchscreen.tap(pt.x, pt.y);
  await page.waitForTimeout(50);
  return true;
}

// Toolbar buttons (the toolbar ids are unique; scope anyway for safety).
const button = (page, id) => page.click(`#toolbar #${id}`);

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
    if (box.width === 0) return [];
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

// Images: aspect ratio kept, at most half a page tall, tap opens a viewer.
async function checkImages(page, label) {
  const imgs = await page.evaluate(() => {
    const body = document.getElementById("body");
    const style = getComputedStyle(body);
    const inner = body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return [...body.querySelectorAll("img:not(.favicon)")]
      .filter((i) => i.naturalWidth > 0 && i.width > 0)
      .map((i, idx) => {
        i.setAttribute("data-e2e-img", idx);
        return {
          idx,
          natural: i.naturalWidth / i.naturalHeight,
          shown: i.width / i.height,
          height: i.height,
          maxHeight: inner / 2,
          src: i.src.split("/").pop(),
        };
      });
  });
  if (imgs.length === 0) {
    console.log("  skip no images in article");
    return;
  }
  const distorted = imgs.filter((i) => Math.abs(i.shown / i.natural - 1) > 0.02);
  check(distorted.length === 0, `${imgs.length} images keep aspect ratio${distorted.length ? ": " + distorted.map((d) => `${d.src} ${d.natural.toFixed(2)} vs ${d.shown.toFixed(2)}`).join(", ") : ""}`);
  const tall = imgs.filter((i) => i.height > i.maxHeight + 1);
  check(tall.length === 0, `images at most half a page tall${tall.length ? ": " + tall.map((t) => `${t.src} ${t.height}px`).join(", ") : ""}`);

  // Go to the page with the first unlinked image.
  const target = await page.evaluate(() => {
    const img = [...document.querySelectorAll("[data-e2e-img]")].find((i) => !i.closest("a"));
    if (!img) return null;
    const body = document.getElementById("body");
    const page = Math.floor((img.offsetLeft) / body.clientWidth);
    showPage(page);
    const r = body.getBoundingClientRect();
    return { idx: img.getAttribute("data-e2e-img"), page: currentPage, pageCount, mid: r.left + r.width / 2 };
  });
  if (!target) {
    console.log("  skip all images are inside links");
    return;
  }
  await page.waitForTimeout(50);
  const box = await page.locator(`[data-e2e-img="${target.idx}"]`).boundingBox();
  const cy = box.y + box.height / 2;

  // Short tap on the image turns the page like text does.
  const onRight = box.x + box.width > target.mid + 10;
  const tx = onRight ? (Math.max(box.x, target.mid) + box.x + box.width) / 2 : box.x + box.width / 2;
  const expected = onRight ? Math.min(target.page + 1, target.pageCount - 1) : Math.max(target.page - 1, 0);
  await page.touchscreen.tap(tx, cy);
  await page.waitForTimeout(100);
  const viewerShown = () => page.evaluate(() => {
    const v = document.getElementById("imageViewer");
    return !!v && getComputedStyle(v).display !== "none";
  });
  check(!(await viewerShown()), "short tap on image does not open viewer");
  check((await state(page)).currentPage === expected,
    `short tap on image (${onRight ? "right" : "left"} half) turns page ${target.page + 1} -> ${expected + 1}`);
  await page.evaluate((p) => showPage(p), target.page);
  await page.waitForTimeout(50);

  // Long press (real touch events via CDP) opens the viewer, and it stays
  // open after the finger lifts.
  const cx = box.x + box.width / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(150);
  const viewer = await page.evaluate(() => {
    const v = document.getElementById("imageViewer");
    if (!v || getComputedStyle(v).display === "none") return null;
    const i = v.querySelector("img");
    return { w: i.width, h: i.height, ratio: i.width / i.height, natural: i.naturalWidth / i.naturalHeight, vw: innerWidth, vh: innerHeight };
  });
  check(!!viewer, "long press on image opens viewer (and it stays open after release)");
  check((await state(page)).currentPage === target.page, "long press does not turn the page");
  if (viewer) {
    check(Math.abs(viewer.ratio / viewer.natural - 1) < 0.02, `viewer keeps aspect ratio (${viewer.w}x${viewer.h})`);
    check(Math.abs(viewer.w - viewer.vw) < 2 || Math.abs(viewer.h - viewer.vh) < 2, "viewer fills the screen on one axis");
    await page.screenshot({ path: path.join(outDir, `${label}-image-viewer.png`) });
    await page.waitForTimeout(600); // past the post-long-press click guard
    await page.touchscreen.tap(viewer.vw / 2, viewer.vh / 2);
    await page.waitForTimeout(50);
    check(!(await viewerShown()), "tap on viewer closes it");
    check((await state(page)).currentPage === target.page, "closing viewer keeps the page");
  }

  // A press that moves (a swipe) must not open the viewer.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + 40, y: cy }] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(100);
  check(!(await viewerShown()), "press that moves does not open viewer");
  await cdp.detach();
  await button(page, "scrollToTopButton");
}

// Lists: paginated, rows not split, buttons page, page remembered on return.
async function checkList(page, url, label) {
  console.log(`\n# ${label}: ${url}`);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(200);
  const s = await state(page);
  check(s.indicator === `${s.currentPage + 1}/${s.pageCount}`, `paginated (${s.pageCount} pages, indicator "${s.indicator}")`);
  check(s.scrollHeight <= s.clientHeight + 1, "no vertical overflow");
  const split = [];
  for (let i = 0; i < s.pageCount; i++) {
    await page.evaluate((p) => showPage(p), i);
    split.push(...(await page.evaluate(() => {
      const box = document.getElementById("body").getBoundingClientRect();
      return [...document.querySelectorAll("#body > a")].filter((a) => {
        const r = a.getBoundingClientRect();
        const visible = r.right > box.left + 1 && r.left < box.right - 1;
        return visible && (r.top < box.top - 1 || r.bottom > box.bottom + 1);
      }).map((a) => a.textContent.trim().slice(0, 40));
    })));
    await page.screenshot({ path: path.join(outDir, `${label}-page${i + 1}.png`) });
  }
  check(split.length === 0, `no rows split across pages${split.length ? ": " + split.slice(0, 3).join(" | ") : ""}`);
  await button(page, "scrollToTopButton");
  if (s.pageCount > 1) {
    await button(page, "scrollDownButton");
    check((await state(page)).currentPage === 1, "down button -> next page");
    await page.reload({ waitUntil: "load" });
    check((await state(page)).currentPage === 1, "page remembered after reload");
    await button(page, "scrollUpButton");
    check((await state(page)).currentPage === 0, "up button -> previous page");
  }
}

async function checkArticle(page, url, label) {
  console.log(`\n# ${label}: ${url}`);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(300);

  let s = await state(page);
  check(s.pageCount >= 1, `paginated (${s.pageCount} pages)`);
  check(s.indicator === `1/${s.pageCount}`, `indicator shows "${s.indicator}"`);
  check(s.scrollHeight <= s.clientHeight + 1, `no vertical overflow (${s.scrollHeight} <= ${s.clientHeight})`);

  // Walk every page forward with right-half taps, checking for clipped
  // lines and screenshotting.
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
    if (!(await tapSide(page, "right"))) {
      await button(page, "scrollDownButton");
      console.log(`  note page ${i + 1}: no free spot on the right half, used button`);
    }
  }
  check(allClipped.length === 0, `no lines cut at page edges${allClipped.length ? ": " + allClipped.slice(0, 3).join(" | ") : ""}`);

  s = await state(page);
  check(s.currentPage === s.pageCount - 1, "right tap on last page stays on last page");

  if (s.pageCount > 1) {
    if (await tapSide(page, "left")) {
      check((await state(page)).currentPage === s.pageCount - 2, "left tap -> previous page");
    } else {
      console.log("  skip no free spot on the left half");
    }
  }

  // Toolbar buttons.
  await button(page, "scrollToTopButton");
  check((await state(page)).currentPage === 0, "top button -> first page");
  if (await tapSide(page, "left")) {
    check((await state(page)).currentPage === 0, "left tap on first page stays on first page");
  }
  if (s.pageCount > 1) {
    await button(page, "scrollDownButton");
    check((await state(page)).currentPage === 1, "down button -> next page");
    await button(page, "scrollUpButton");
    check((await state(page)).currentPage === 0, "up button -> previous page");
  }
  await button(page, "scrollBottomButton");
  check((await state(page)).currentPage === s.pageCount - 1, "bottom button -> last page");
  await button(page, "scrollToTopButton");

  await checkImages(page, label);

  // Tapping a link must not turn the page (navigation blocked for the test).
  const hasLink = await page.evaluate(() => {
    const a = [...document.querySelectorAll("#body a")].find((a) => {
      const r = a.getBoundingClientRect();
      const b = document.getElementById("body").getBoundingClientRect();
      return r.width > 0 && r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom;
    });
    if (!a) return false;
    if (!window.__e2eBlockLinks) {
      window.__e2eBlockLinks = true;
      window.addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); }, true);
    }
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
  await button(page, "zoomInButton");
  await button(page, "zoomInButton");
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
  await button(page, "zoomOutButton");
  await button(page, "zoomOutButton");
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
    const feedUrl = new URL(feedHref, base + "/").href;
    await page.goto(feedUrl);
    const articleUrls = await page.$$eval("#body a[href*='/article/']", (as) => as.map((a) => a.href));
    if (articleUrls.length === 0) throw new Error("feed has no articles");

    await checkList(page, base + "/", "feed-list");
    await checkList(page, feedUrl, "article-list");

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
