import { chromium } from "playwright";
import { isAllowedToCrawl } from "./robot.js";
import { upsertJob, batchUpsert } from "../models/jobs.models.js";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_USER_AGENT = process.env.CRAWL_USER_AGENT || "JobHunterBot/1.0 (+you@example.com)";
const DEFAULT_MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || "2", 10);
const DEFAULT_CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || "3", 10);
const DESCRIPTION_MAX_CHARS = 1000;
const PREVIEW_CHARS = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { startUrl: undefined, maxPages: undefined, concurrency: undefined, dryRun: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--startUrl" || a === "-u") out.startUrl = args[++i];
    else if (a === "--maxPages" || a === "-m") out.maxPages = parseInt(args[++i], 10);
    else if (a === "--concurrency" || a === "-c") out.concurrency = parseInt(args[++i], 10);
    else if (a === "--dry-run" || a === "--dry") out.dryRun = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sanitizeText(s) { return s ? String(s).replace(/\s+/g, " ").trim() : ""; }
function uniqueByJobId(items) {
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    if (!it || !it.jobId) continue;
    if (seen.has(it.jobId)) continue;
    seen.add(it.jobId);
    uniq.push(it);
  }
  return uniq;
}

async function extractDescriptionText(page) {
  try {
    const selectorList = [".listing-container", ".listing-body", ".content", "article", "main"];
    const descriptionText = await page.$$eval(selectorList.join(","), (nodes) => {
      const node = nodes.find((n) =>
        n && (n.innerText || n.textContent) && (n.innerText || n.textContent).trim().length > 0
      );
      return node ? node.innerText || node.textContent : "";
    }).catch(() => "");
    if (!descriptionText) return "";
    let text = descriptionText.replace(/\s+/g, " ").trim();
    text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (text.length > DESCRIPTION_MAX_CHARS) return text.slice(0, DESCRIPTION_MAX_CHARS) + "...";
    return text;
  } catch (err) {
    console.warn("[extractDescriptionText] failed:", err && err.message ? err.message : err);
    return "";
  }
}

async function parseJobDetail(page, url, opts = {}) {
  try {
    if (opts.verbose) console.log("[parseJobDetail] navigating to:", url);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response) {
      if (opts.verbose) console.warn("[parseJobDetail] no response for", url);
      return null;
    }
    const hasDetail = await page.$(".listing-container, .listing-body, .content, article, main");
    if (!hasDetail) {
      if (opts.verbose) console.warn("[parseJobDetail] page missing detail selectors, skipping:", url);
      return null;
    }
    await page.waitForTimeout(700 + Math.random() * 600);

    const title = await page.$$eval("h1, .listing-header h1, .job-title", (nodes) => (nodes[0] ? nodes[0].textContent.trim() : "")).catch(() => "");
    let company = "", location = "";
    try { company = await page.$eval(".company, .company a, .listing-header .company", (el) => el.textContent.trim()); } catch (e) { company = ""; }
    try { location = await page.$eval(".region, .location, .listing-header .location", (el) => el.textContent.trim()); } catch (e) { location = ""; }
    if (!location && /remote/i.test(title + " " + company)) location = "Remote";

    const descriptionText = await extractDescriptionText(page);
    const descriptionPreview = descriptionText ? descriptionText.slice(0, PREVIEW_CHARS) + (descriptionText.length > PREVIEW_CHARS ? "..." : "") : "";

    const parts = url.split("/").filter(Boolean);
    const rawId = parts[parts.length - 1] || url;

    const job = {
      jobId: `weworkremotely-${rawId}`,
      title: sanitizeText(title),
      company: sanitizeText(company),
      location: sanitizeText(location || "Remote"),
      postedAt: new Date().toISOString(),
      description: descriptionText,
      descriptionPreview,
      applyUrl: url,
      source: "weworkremotely",
      remoteOk: /remote/i.test((location || "") + " " + (title || "")),
    };
    return job;
  } catch (err) {
    console.error("[parseJobDetail] parse error", url, err && err.stack ? err.stack : err);
    return null;
  }
}

async function collectJobLinksFromListing(page, listingUrl) {
  try {
    await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(900);
    const rawLinks = await page.$$eval("a[href]", (anchors) => anchors.map((a) => (a.href || "").trim()).filter(Boolean));
    const links = Array.from(new Set(rawLinks)).filter((h) => {
      try {
        const u = new URL(h, "https://weworkremotely.com");
        if (!u.pathname.includes("/remote-jobs/")) return false;
        if (u.search || u.hash) return false;
        if (u.pathname.includes("/new") || u.pathname.includes("/all-jobs") || u.pathname.includes("/search")) return false;
        const parts = u.pathname.split("/").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        if (!last.includes("-")) return false;
        return true;
      } catch (e) { return false; }
    });
    return links;
  } catch (err) {
    console.error("[collectJobLinks] error", listingUrl, err && err.stack ? err.stack : err);
    return [];
  }
}

export async function crawlWeWorkRemotely({
  startUrl = "https://weworkremotely.com/remote-jobs/search?term=node",
  maxPages = DEFAULT_MAX_PAGES,
  concurrency = DEFAULT_CONCURRENCY,
  dryRun = false,
  verbose = false,
} = {}) {
  if (verbose) console.log("[crawl] starting with", { startUrl, maxPages, concurrency, dryRun });
  const base = "https://weworkremotely.com";
  try {
    const ok = await isAllowedToCrawl(base, DEFAULT_USER_AGENT);
    if (!ok) throw new Error("Crawling disallowed by robots.txt");
  } catch (err) {
    console.warn("[crawl] robots check failed or disallowed:", err && err.message ? err.message : err);
  }

  const headless = process.env.CRAWL_HEADLESS === "false" ? false : true;
  let browser = null, context = null;
  try {
    browser = await chromium.launch({ headless, args: ["--no-sandbox"] });
    context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT, locale: "en-US" });
    const listingPage = await context.newPage();
    await listingPage.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    let pageIndex = 0;
    const buffer = [];
    const seenUrls = new Set();

    while (pageIndex < maxPages) {
      const listingUrl = pageIndex === 0 ? startUrl : `${startUrl}&page=${pageIndex + 1}`;
      if (verbose) console.log(`[crawl] fetching listing page ${pageIndex + 1}: ${listingUrl}`);
      const links = await collectJobLinksFromListing(listingPage, listingUrl);
      if (!links.length) { if (verbose) console.warn("[crawl] no links, stopping"); break; }

      // process in batches of concurrency
      let idx = 0;
      while (idx < links.length) {
        const batch = links.slice(idx, idx + concurrency);
        const results = await Promise.all(batch.map(async (link) => {
          if (seenUrls.has(link)) { if (verbose) console.log("[crawl] skip seen", link); return null; }
          seenUrls.add(link);
          const page = await context.newPage();
          try {
            return await parseJobDetail(page, link, { verbose });
          } finally {
            try { await page.close(); } catch (e) {}
          }
        }));

        for (const r of results) if (r) buffer.push(r);

        if (buffer.length >= 20) {
          const chunk = buffer.splice(0, 20);
          const uniqueChunk = uniqueByJobId(chunk);
          if (uniqueChunk.length) {
            if (dryRun) {
              if (verbose) console.log(`[dry-run] would batchUpsert ${uniqueChunk.length} jobs`);
            } else {
              try {
                if (verbose) console.log(`[crawl] batchUpsert ${uniqueChunk.length}`);
                await batchUpsert(uniqueChunk);
              } catch (err) {
                console.error("[crawl] batchUpsert failed", err && err.stack ? err.stack : err);
                buffer.unshift(...uniqueChunk);
              }
            }
          }
        }

        idx += concurrency;
        await sleep(700 + Math.random() * 800);
      }

      pageIndex++;
      await sleep(1500 + Math.random() * 1500);
    }

    if (buffer.length) {
      const finalChunk = buffer.splice(0);
      const uniqueFinal = uniqueByJobId(finalChunk);
      if (uniqueFinal.length) {
        if (dryRun) {
          if (verbose) console.log(`[dry-run] would final batchUpsert ${uniqueFinal.length} jobs`);
        } else {
          try { await batchUpsert(uniqueFinal); } catch (err) { console.error("[crawl] final batchUpsert failed", err && err.stack ? err.stack : err); }
        }
      }
    }

    if (verbose) console.log("[crawl] finished");
  } catch (err) {
    console.error("[crawl] top-level error", err && err.stack ? err.stack : err);
    throw err;
  } finally {
    try { if (context) await context.close(); } catch (e) {}
    try { if (browser) await browser.close(); } catch (e) {}
  }
}

// If run directly, parse args and run
if (require.main === module) {
  const args = parseArgs();
  const opts = {
    startUrl: args.startUrl || "https://weworkremotely.com/remote-jobs/search?term=node",
    maxPages: args.maxPages || DEFAULT_MAX_PAGES,
    concurrency: args.concurrency || DEFAULT_CONCURRENCY,
    dryRun: !!args.dryRun,
    verbose: !!args.verbose,
  };
  (async () => {
    try {
      await crawlWeWorkRemotely(opts);
    } catch (err) {
      console.error("Crawler failed:", err && err.stack ? err.stack : err);
      process.exit(1);
    }
  })();
}
