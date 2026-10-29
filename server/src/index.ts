import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { startWaitlistBackgroundWorker, stopWaitlistBackgroundWorker } from './modules/waitlist/waitlistWorker.js';

async function startServer() {
  try {
    // Verify database connectivity
    await prisma.$connect();
    console.log('⚡ Connected to Outside.vip PostgreSQL database successfully');

    // Start waitlist background worker (sweeps expired offers and reservations)
    startWaitlistBackgroundWorker(60_000);

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Outside.vip API server listening on http://localhost:${env.PORT}`);
      console.log(`📡 Health check available at http://localhost:${env.PORT}/api/health`);
    });

    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}. Gracefully terminating Outside.vip server...`);
      stopWaitlistBackgroundWorker();
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
