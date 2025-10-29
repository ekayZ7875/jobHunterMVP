import dotenv from "dotenv";
dotenv.config();

import { crawlWeWorkRemotely } from "../utils/crawler.js";

async function main() {
  console.log("=== Crawl runner starting ===");
  console.log("NODE ENV:", process.env.NODE_ENV || "dev");
  console.log("DYNAMODB_TABLE:", "JobHunterJobs");
  console.log("AWS_REGION:", process.env.AWS_REGION);
  console.log("CRAWL_START_URL:", process.env.CRAWL_START_URL || "");
  console.log("CRAWL_MAX_PAGES:", process.env.CRAWL_MAX_PAGES || "default");

  try {
    const startUrl =
      process.env.CRAWL_START_URL ||
      "https://weworkremotely.com/remote-jobs/search?term=javascript";
    const maxPages = parseInt(process.env.CRAWL_MAX_PAGES || "5", 10);

    console.log(
      `Calling crawlWeWorkRemotely({ startUrl: "${startUrl}", maxPages: ${maxPages} })`
    );
    await crawlWeWorkRemotely({ startUrl, maxPages });
    console.log("=== Crawl runner finished successfully ===");
    process.exit(0);
  } catch (err) {
    console.error("=== Crawl runner ERROR ===");
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
