import { Router } from 'express';
import { getAllTasks, getAllPendingTasks } from '../services/taskStore';

const router = Router();

/**
 * GET /stats
 * Returns the current count of active and pending tasks.
 * Unprotected endpoint for monitoring.
 */
router.get('/', (_req, res) => {
  const activeTasks = getAllTasks().length;
  const pendingTasks = getAllPendingTasks().length;

  res.json({
    ok: true,
    activeTasks,
    pendingTasks,
  });
});

export default router;
