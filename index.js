import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";
import cron from "node-cron";
import { crawlWeWorkRemotely } from "./utils/crawler.js";
import jobsRoutes from "./routes/jobs.routes.js";

dotenv.config();
const app = express();
app.use(express.json());
app.use(morgan('dev'))

// Routes
app.use("/jobs", jobsRoutes);

// Root route — simple health check
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "JobHunter backend running",
    availableEndpoints: [
      "GET /jobs",
      "GET /jobs/:id",
      "GET /api (list available APIs)"
    ],
  });
});

// 🔹 CRON JOB: Runs every 2 hours (at minute 0)
cron.schedule("0 */2 * * *", async () => {
  console.log("🕓 Cron: Starting scheduled crawl job...");
  try {
    await crawlWeWorkRemotely({
      startUrl: "https://weworkremotely.com/remote-jobs",
      maxPages: 10,
    });
    console.log("✅ Cron: Crawl job completed successfully.");
  } catch (err) {
    console.error("❌ Cron: Crawl job failed:", err.message);
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
