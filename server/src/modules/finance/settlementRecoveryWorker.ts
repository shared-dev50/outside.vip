import {
  generateSettlementWorkerId,
  runSettlementRecoveryPass,
  sanitizeSettlementDiagnosticMessage,
  SETTLEMENT_BATCH_SIZE,
  SETTLEMENT_LEASE_MS,
  SettlementRecoveryPassStats,
} from './settlementRecovery.service.js';

export const SETTLEMENT_RECOVERY_POLL_INTERVAL_MS = 5 * 60_000;
export const SETTLEMENT_RECOVERY_STARTUP_DELAY_MS = 10_000;
export const SETTLEMENT_RECOVERY_SHUTDOWN_DRAIN_MS = 5_000;

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
    processWorkerId = generateSettlementWorkerId();
  }
  return processWorkerId;
}

export async function executeSettlementRecoveryWorkerPass(): Promise<SettlementRecoveryPassStats | null> {
  if (isPassRunning) {
    rerunRequested = true;
    return null;
  }

  isPassRunning = true;
  let lastStats: SettlementRecoveryPassStats | null = null;

  const runner = (async () => {
    try {
      do {
        rerunRequested = false;
        const stats = await runSettlementRecoveryPass({
          workerId: getProcessWorkerId(),
          batchSize: SETTLEMENT_BATCH_SIZE,
          leaseMs: SETTLEMENT_LEASE_MS,
        });
        lastStats = stats;

        if (stats.claimed > 0 || stats.reapedExhausted > 0) {
          console.log(
            `[SettlementWorker] Pass complete: claimed=${stats.claimed}, settled=${stats.settled}, stripePending=${stats.stripePending}, disputeHeld=${stats.disputeHeld}, retried=${stats.retried}, failedPermanent=${stats.failedPermanent}, leaseLost=${stats.leaseLost}, reapedExhausted=${stats.reapedExhausted}`
          );
        }

        if (stats.claimed >= SETTLEMENT_BATCH_SIZE && isWorkerStarted) {
          rerunRequested = true;
        }
      } while (rerunRequested && isWorkerStarted);
    } catch (err) {
      console.error(
        `[SettlementWorker] Recovery pass failed: ${sanitizeSettlementDiagnosticMessage(err)}`
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
 * Strictly post-commit, non-blocking wake-up triggered by balance.available or won dispute webhooks.
 */
export function triggerSettlementRecoveryDispatch(): void {
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
    executeSettlementRecoveryWorkerPass().catch((err) => {
      console.error(
        `[SettlementWorker] Wake-up dispatch error: ${sanitizeSettlementDiagnosticMessage(err)}`
      );
    });
  }, 10);

  if (wakeupTimer.unref) {
    wakeupTimer.unref();
  }
}

export function isSettlementRecoveryWorkerRunning(): boolean {
  return isWorkerStarted;
}

export function startSettlementRecoveryWorker(
  intervalMs = SETTLEMENT_RECOVERY_POLL_INTERVAL_MS
): void {
  if (workerInterval || isWorkerStarted) return;

  isWorkerStarted = true;
  processWorkerId = generateSettlementWorkerId();

  console.log(
    `💰 Settlement recovery worker started (workerId=${processWorkerId}, interval=${intervalMs / 1000}s)`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isWorkerStarted) return;
    executeSettlementRecoveryWorkerPass().catch(() => {});
  }, SETTLEMENT_RECOVERY_STARTUP_DELAY_MS);

  if (startupTimer.unref) {
    startupTimer.unref();
  }

  workerInterval = setInterval(() => {
    if (!isWorkerStarted) return;
    executeSettlementRecoveryWorkerPass().catch(() => {});
  }, intervalMs);

  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

export async function stopSettlementRecoveryWorker(
  drainTimeoutMs = SETTLEMENT_RECOVERY_SHUTDOWN_DRAIN_MS
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
    console.log('🛑 Settlement recovery worker stopped');
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
