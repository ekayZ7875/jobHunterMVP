import express from 'express';
import { listJobs, getJob } from '../controllers/jobs.controllers.js';

const router = express.Router();

/**
 * GET /jobs
 * Query params:
 *  - search (string)
 *  - location (string)
 *  - jobType (string)
 *  - limit (int)
 *  - lastKey (base64)
 */
router.get('/', listJobs);

/** GET /jobs/:id */
router.get('/:id', getJob);

export default router;
