import { sweepExpiredOffers } from './waitlist.service.js';
import { releaseExpiredReservations } from '../checkout/checkout.service.js';

export const WAITLIST_WORKER_POLL_INTERVAL_MS = 60_000;
export const WAITLIST_WORKER_STARTUP_DELAY_MS = 5_000;
export const WAITLIST_WORKER_SHUTDOWN_DRAIN_MS = 5_000;

let workerInterval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isWorkerStarted = false;
let isJobRunning = false;
let activePassPromise: Promise<void> | null = null;

export interface WaitlistMaintenancePassResult {
  releasedReservations: number;
  expiredOffers: number;
  sweptExpiredOffers: number;
  advancedTiers: number;
}

// Sweeps expired checkout reservations and waitlist purchase offers.
export async function runWaitlistMaintenancePass(): Promise<WaitlistMaintenancePassResult> {
  if (isJobRunning) {
    return { releasedReservations: 0, expiredOffers: 0, sweptExpiredOffers: 0, advancedTiers: 0 };
  }

  isJobRunning = true;
  let result: WaitlistMaintenancePassResult = {
    releasedReservations: 0,
    expiredOffers: 0,
    sweptExpiredOffers: 0,
    advancedTiers: 0,
  };

  const runner = (async () => {
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

      result = {
        releasedReservations,
        expiredOffers: expiredOffersCount,
        sweptExpiredOffers: expiredOffersCount,
        advancedTiers: advancedTiersCount,
      };
    } finally {
      isJobRunning = false;
      activePassPromise = null;
    }
  })();

  activePassPromise = runner;
  await runner;
  return result;
}

export function isWaitlistBackgroundWorkerRunning(): boolean {
  return isWorkerStarted;
}

export function startWaitlistBackgroundWorker(
  intervalMs = WAITLIST_WORKER_POLL_INTERVAL_MS,
  startupDelayMs = WAITLIST_WORKER_STARTUP_DELAY_MS
): void {
  if (workerInterval || isWorkerStarted) return;

  isWorkerStarted = true;
  console.log(`⏱️ Waitlist background worker started (interval: ${intervalMs / 1000}s)`);

  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isWorkerStarted) return;
    runWaitlistMaintenancePass().catch(() => {});
  }, startupDelayMs);

  if (startupTimer.unref) {
    startupTimer.unref();
  }

  workerInterval = setInterval(() => {
    if (!isWorkerStarted) return;
    runWaitlistMaintenancePass().catch(() => {});
  }, intervalMs);

  // Prevent interval from keeping the process alive on shutdown
  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

export async function stopWaitlistBackgroundWorker(
  drainTimeoutMs = WAITLIST_WORKER_SHUTDOWN_DRAIN_MS
): Promise<void> {
  isWorkerStarted = false;

  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('🛑 Waitlist background worker stopped');
  }

  if (activePassPromise && drainTimeoutMs > 0) {
    await Promise.race([
      activePassPromise,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, drainTimeoutMs);
        if (t.unref) t.unref();
      }),
    ]);
  }
}
