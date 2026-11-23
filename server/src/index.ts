import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { startWaitlistBackgroundWorker, stopWaitlistBackgroundWorker } from './modules/waitlist/waitlistWorker.js';
import {
  EMAIL_OUTBOX_POLL_INTERVAL_MS,
  startEmailOutboxWorker,
  stopEmailOutboxWorker,
} from './modules/notifications/emailOutboxWorker.js';
import {
  ORDER_REFUND_POLL_INTERVAL_MS,
  startOrderRefundWorker,
  stopOrderRefundWorker,
} from './modules/refunds/orderRefundWorker.js';

async function startServer() {
  try {
    await prisma.$connect();
    console.log('⚡ Connected to Outside.vip PostgreSQL database successfully');

    startWaitlistBackgroundWorker(60_000);
    startEmailOutboxWorker(EMAIL_OUTBOX_POLL_INTERVAL_MS);
    startOrderRefundWorker(ORDER_REFUND_POLL_INTERVAL_MS);

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Outside.vip API server listening on http://localhost:${env.PORT}`);
      console.log(`📡 Health check available at http://localhost:${env.PORT}/api/health`);
    });

    let isShuttingDown = false;
    const shutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\n🛑 Received ${signal}. Gracefully terminating Outside.vip server...`);
      await stopWaitlistBackgroundWorker();
      await stopEmailOutboxWorker();
      await stopOrderRefundWorker();
      server.close(async () => {
        await prisma.$disconnect();
        console.log('✅ PostgreSQL disconnected. Process exited.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('❌ Failed to start Outside.vip server:', error);
    process.exit(1);
  }
}

startServer();
