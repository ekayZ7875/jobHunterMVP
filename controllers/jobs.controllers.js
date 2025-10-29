import { scanJobs } from "../models/jobs.models.js";
import { crawlWeWorkRemotely } from "../utils/crawler.js";

/**
 * Returns all jobs in Dynamo where source === 'weworkremotely'
 */
export async function listAllWWRJobs(req, res, next) {
  try {
    const pageLimit = 1000;
    const all = [];
    let lastKey = undefined;
    while (true) {
      const { items, lastEvaluatedKey } = await scanJobs({
        limit: pageLimit,
        exclusiveStartKey: lastKey,
      });
      if (items && items.length) {
        for (const it of items) {
          if (it && it.source === "weworkremotely") all.push(it);
        }
      }
      if (!lastEvaluatedKey) break;
      lastKey = lastEvaluatedKey;
    }

    // sort by postedAt desc
    all.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || ""));

    res.json({ total: all.length, jobs: all });
  } catch (err) {
    next(err);
  }
}

/**
 * - term (required): search keyword
 * - live (optional): if 'true', run crawler against WWR search endpoint for that term before returning results
 *
 * Without live=true, this just queries DynamoDB (fast).
 */
export async function searchWWRJobs(req, res, next) {
  try {
    const term = (req.query.term || "").trim();
    const live = String(req.query.live || "").toLowerCase() === "true";

    const startPage = Math.max(1, parseInt(req.query.page || "1", 10));
    const pagesToCrawl = Math.max(
      1,
      parseInt(req.query.pages || (live ? "1" : "1"), 10)
    );

    if (!term) {
      return res
        .status(400)
        .json({ error: "Missing required query param: term" });
    }

    if (live) {
      const startUrl = `https://weworkremotely.com/remote-jobs/search?term=${encodeURIComponent(
        term
      )}${startPage > 1 ? `&page=${startPage}` : ""}`;

      const maxPages = pagesToCrawl;
      console.log(
        `[searchWWRJobs] live crawl requested: term=${term} startPage=${startPage} pages=${pagesToCrawl}`
      );
      await crawlWeWorkRemotely({ startUrl, maxPages });
    }

    const pageLimit = 1000;
    const results = [];
    let lastKey = undefined;
    const q = term.toLowerCase();

    while (true) {
      const { items, lastEvaluatedKey } = await scanJobs({
        limit: pageLimit,
        exclusiveStartKey: lastKey,
      });

      if (items && items.length) {
        for (const it of items) {
          if (it && it.source === "weworkremotely") {
            const hay = [
              it.title || "",
              it.company || "",
              it.description || "",
              it.descriptionPreview || "",
              Array.isArray(it.tags) ? it.tags.join(" ") : "",
            ]
              .join(" ")
              .toLowerCase();

            if (hay.includes(q)) results.push(it);
          }
        }
      }

      if (!lastEvaluatedKey) break;
      lastKey = lastEvaluatedKey;
    }

    results.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || ""));

    res.json({ total: results.length, term, jobs: results });
  } catch (err) {
    next(err);
  }
}
