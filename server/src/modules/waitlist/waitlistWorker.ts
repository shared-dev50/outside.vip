import { sweepExpiredOffers } from './waitlist.service.js';
import { releaseExpiredReservations } from '../checkout/checkout.service.js';

let workerInterval: NodeJS.Timeout | null = null;
let isJobRunning = false;

/**
 * Runs a single maintenance pass: sweeps expired checkout reservations
 * and sweeps expired waitlist purchase offers, advancing the queue.
 */
export async function runWaitlistMaintenancePass(): Promise<{
  releasedReservations: number;
  expiredOffers: number;
  sweptExpiredOffers: number;
  advancedTiers: number;
}> {
  if (isJobRunning) {
    return { releasedReservations: 0, expiredOffers: 0, sweptExpiredOffers: 0, advancedTiers: 0 };
  }

  isJobRunning = true;
  try {
    const releasedReservations = await releaseExpiredReservations().catch((err) => {
      console.error('[WaitlistWorker] Failed to release expired reservations:', err);
      return 0;
    });

    const { expiredOffersCount, advancedTiersCount } = await sweepExpiredOffers().catch((err) => {
      console.error('[WaitlistWorker] Failed to sweep expired waitlist offers:', err);
      return { expiredOffersCount: 0, advancedTiersCount: 0 };
    });

    if (releasedReservations > 0 || expiredOffersCount > 0 || advancedTiersCount > 0) {
      console.log(
        `[WaitlistWorker] Maintenance pass complete: ${releasedReservations} reservations released, ${expiredOffersCount} offers expired, ${advancedTiersCount} waitlists advanced.`
      );
    }

    return {
      releasedReservations,
      expiredOffers: expiredOffersCount,
      sweptExpiredOffers: expiredOffersCount,
      advancedTiers: advancedTiersCount,
    };
  } finally {
    isJobRunning = false;
  }
}

/**
 * Starts the server-side waitlist background worker.
 * Runs on a safe periodic interval (default: 60 seconds).
 */
export function startWaitlistBackgroundWorker(intervalMs = 60_000): void {
  if (workerInterval) return;

  console.log(`⏱️ Waitlist background worker started (interval: ${intervalMs / 1000}s)`);

  // Run initial pass shortly after boot
  setTimeout(() => {
    runWaitlistMaintenancePass().catch(() => {});
  }, 5000);

  workerInterval = setInterval(() => {
    runWaitlistMaintenancePass().catch(() => {});
  }, intervalMs);

  // Do not hold process open solely for timer if all connections close
  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

/**
 * Gracefully terminates the waitlist background worker.
 */
export function stopWaitlistBackgroundWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('🛑 Waitlist background worker stopped');
  }
}
