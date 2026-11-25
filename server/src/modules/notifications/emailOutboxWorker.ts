import {
  EMAIL_OUTBOX_BATCH_SIZE,
  EMAIL_OUTBOX_LEASE_MS,
  EmailOutboxPassStats,
  generateEmailOutboxWorkerId,
  runEmailOutboxPass,
} from './emailOutbox.service.js';

export const EMAIL_OUTBOX_POLL_INTERVAL_MS = 15_000;
export const EMAIL_OUTBOX_STARTUP_DELAY_MS = 3_000;
export const EMAIL_OUTBOX_SHUTDOWN_DRAIN_MS = 5_000;

let workerInterval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let wakeupTimer: NodeJS.Timeout | null = null;
let isWorkerStarted = false;
let isPassRunning = false;
let rerunRequested = false;
let activePassPromise: Promise<void> | null = null;
let processWorkerId: string | null = null;

function getProcessWorkerId(): string {
  if (!processWorkerId) {
    processWorkerId = generateEmailOutboxWorkerId();
  }
  return processWorkerId;
}

/**
 * Runs a single overlap-guarded dispatch pass for this process.
 * If another pass is already active, flags a follow-up pass so post-commit wake-ups are not lost.
 */
export async function executeWorkerPass(): Promise<EmailOutboxPassStats | null> {
  if (isPassRunning) {
    rerunRequested = true;
    return null;
  }

  isPassRunning = true;
  let lastStats: EmailOutboxPassStats | null = null;

  const runner = (async () => {
    try {
      do {
        rerunRequested = false;
        const stats = await runEmailOutboxPass({
          workerId: getProcessWorkerId(),
          batchSize: EMAIL_OUTBOX_BATCH_SIZE,
          leaseMs: EMAIL_OUTBOX_LEASE_MS,
        });
        lastStats = stats;

        if (
          stats.claimed > 0 ||
          stats.reapedExhausted > 0
        ) {
          console.log(
            `[EmailOutboxWorker] Pass complete: claimed=${stats.claimed}, accepted=${stats.accepted}, retried=${stats.retried}, failedPermanent=${stats.failedPermanent}, leaseLost=${stats.leaseLost}, reapedExhausted=${stats.reapedExhausted}`
          );
        }

        // If a full batch was claimed and worker is still active, drain immediately on next loop
        if (stats.claimed >= EMAIL_OUTBOX_BATCH_SIZE && isWorkerStarted) {
          rerunRequested = true;
        }
      } while (rerunRequested && isWorkerStarted);
    } catch (err) {
      console.error('[EmailOutboxWorker] Dispatch pass failed:', err);
    } finally {
      isPassRunning = false;
      activePassPromise = null;
    }
  })();

  activePassPromise = runner;
  await runner;
  return lastStats;
}

/**
 * Non-blocking post-commit wake-up called after order fulfillment commits.
 * Never throws and never blocks Stripe webhook or order lookup responses.
 * When the worker is stopped (e.g. during shutdown or paused durability tests), this is a safe no-op
 * because the PENDING outbox record remains durably persisted in PostgreSQL.
 */
export function triggerEmailOutboxDispatch(): void {
  if (!isWorkerStarted) {
    return;
  }

  if (isPassRunning) {
    rerunRequested = true;
    return;
  }

  if (wakeupTimer) {
    return;
  }

  wakeupTimer = setTimeout(() => {
    wakeupTimer = null;
    if (!isWorkerStarted) return;
    executeWorkerPass().catch((err) => {
      console.error('[EmailOutboxWorker] Wake-up dispatch error:', err);
    });
  }, 10);

  if (wakeupTimer.unref) {
    wakeupTimer.unref();
  }
}

export function isEmailOutboxWorkerRunning(): boolean {
  return isWorkerStarted;
}

export function startEmailOutboxWorker(
  intervalMs = EMAIL_OUTBOX_POLL_INTERVAL_MS
): void {
  if (workerInterval || isWorkerStarted) return;

  isWorkerStarted = true;
  processWorkerId = generateEmailOutboxWorkerId();

  console.log(
    `📬 Email outbox worker started (workerId=${processWorkerId}, interval=${intervalMs / 1000}s)`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isWorkerStarted) return;
    executeWorkerPass().catch(() => {});
  }, EMAIL_OUTBOX_STARTUP_DELAY_MS);

  if (startupTimer.unref) {
    startupTimer.unref();
  }

  workerInterval = setInterval(() => {
    if (!isWorkerStarted) return;
    executeWorkerPass().catch(() => {});
  }, intervalMs);

  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

/**
 * Stops the polling loop and waits briefly for any in-flight dispatch pass to settle.
 */
export async function stopEmailOutboxWorker(
  drainTimeoutMs = EMAIL_OUTBOX_SHUTDOWN_DRAIN_MS
): Promise<void> {
  isWorkerStarted = false;
  rerunRequested = false;

  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (wakeupTimer) {
    clearTimeout(wakeupTimer);
    wakeupTimer = null;
  }

  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
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

  console.log('🛑 Email outbox worker stopped');
}

