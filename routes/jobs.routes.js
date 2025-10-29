import express from "express";
import {
  listAllWWRJobs,
  searchWWRJobs,
} from "../controllers/jobs.controllers.js";

const router = express.Router();

router.get("/get-all-jobs", listAllWWRJobs);
router.get("/search-jobs", searchWWRJobs);

export default router;
