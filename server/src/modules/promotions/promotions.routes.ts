import { Router } from 'express';
import { handleShortLinkRedirect } from './promotions.controller.js';

const router = Router();

// GET /r/:slug or /api/r/:slug
router.get('/:slug', handleShortLinkRedirect);

export default router;

