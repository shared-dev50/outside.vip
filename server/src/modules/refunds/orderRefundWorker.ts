import {
  generateOrderRefundWorkerId,
  ORDER_REFUND_BATCH_SIZE,
  ORDER_REFUND_LEASE_MS,
  OrderRefundPassStats,
  runOrderRefundPass,
  sanitizeRefundDiagnosticMessage,
} from './orderRefund.service.js';

export const ORDER_REFUND_POLL_INTERVAL_MS = 15_000;
export const ORDER_REFUND_STARTUP_DELAY_MS = 3_000;
export const ORDER_REFUND_SHUTDOWN_DRAIN_MS = 5_000;

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
    processWorkerId = generateOrderRefundWorkerId();
  }
  return processWorkerId;
}

/**
 * Runs a single overlap-guarded refund dispatch pass for this process.
 * Follows the EmailOutboxWorker lifecycle: if a pass is already running, schedules one immediate follow-up.
 */
export async function executeOrderRefundWorkerPass(): Promise<OrderRefundPassStats | null> {
  if (isPassRunning) {
    rerunRequested = true;
    return null;
  }

  isPassRunning = true;
  let lastStats: OrderRefundPassStats | null = null;

  const runner = (async () => {
    try {
      do {
        rerunRequested = false;
        const stats = await runOrderRefundPass({
          workerId: getProcessWorkerId(),
          batchSize: ORDER_REFUND_BATCH_SIZE,
          leaseMs: ORDER_REFUND_LEASE_MS,
        });
        lastStats = stats;

        if (stats.claimed > 0 || stats.reapedExhausted > 0) {
          console.log(
            `[OrderRefundWorker] Pass complete: claimed=${stats.claimed}, succeeded=${stats.succeeded}, stripePending=${stats.stripePending}, retried=${stats.retried}, manualReview=${stats.manualReview}, leaseLost=${stats.leaseLost}, reapedExhausted=${stats.reapedExhausted}`
          );
        }

        if (stats.claimed >= ORDER_REFUND_BATCH_SIZE && isWorkerStarted) {
          rerunRequested = true;
        }
      } while (rerunRequested && isWorkerStarted);
    } catch (err) {
      console.error(
        `[OrderRefundWorker] Dispatch pass failed: ${sanitizeRefundDiagnosticMessage(err)}`
      );
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
 * Strictly post-commit, non-blocking wake-up called after a late-payment OrderRefund commits.
 * Safe no-op when the worker is stopped (the durable row remains persisted in PostgreSQL).
 */
export function triggerOrderRefundDispatch(): void {
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
    executeOrderRefundWorkerPass().catch((err) => {
      console.error(
        `[OrderRefundWorker] Wake-up dispatch error: ${sanitizeRefundDiagnosticMessage(err)}`
      );
    });
  }, 10);

  if (wakeupTimer.unref) {
    wakeupTimer.unref();
  }
}

export function isOrderRefundWorkerRunning(): boolean {
  return isWorkerStarted;
}

export function startOrderRefundWorker(
  intervalMs = ORDER_REFUND_POLL_INTERVAL_MS
): void {
  if (workerInterval || isWorkerStarted) return;

  isWorkerStarted = true;
  processWorkerId = generateOrderRefundWorkerId();

  console.log(
    `💸 Order refund worker started (workerId=${processWorkerId}, interval=${intervalMs / 1000}s)`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isWorkerStarted) return;
    executeOrderRefundWorkerPass().catch(() => {});
  }, ORDER_REFUND_STARTUP_DELAY_MS);

  if (startupTimer.unref) {
    startupTimer.unref();
  }

  workerInterval = setInterval(() => {
    if (!isWorkerStarted) return;
    executeOrderRefundWorkerPass().catch(() => {});
  }, intervalMs);

  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

export async function stopOrderRefundWorker(
  drainTimeoutMs = ORDER_REFUND_SHUTDOWN_DRAIN_MS
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
    console.log('🛑 Order refund worker stopped');
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
