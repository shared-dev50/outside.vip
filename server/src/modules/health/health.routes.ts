import { Router, Request, Response } from 'express';
import { prisma } from '../../db/prisma.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const dbStartTime = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - dbStartTime;

    res.json({
      status: 'ok',
      service: 'outside.vip-api',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      database: {
        status: 'connected',
        latencyMs: dbLatencyMs,
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      service: 'outside.vip-api',
      timestamp: new Date().toISOString(),
      database: {
        status: 'disconnected',
        error: (error as Error).message,
      },
    });
  }
});
