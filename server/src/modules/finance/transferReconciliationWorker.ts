import {
  generateTransferWorkerId,
  runTransferReconciliationPass,
  sanitizeTransferDiagnosticMessage,
  TRANSFER_RECONCILIATION_BATCH_SIZE,
  TRANSFER_RECONCILIATION_LEASE_MS,
  TransferReconciliationPassStats,
} from './transferReconciliation.service.js';

export const TRANSFER_RECONCILIATION_POLL_INTERVAL_MS = 2 * 60_000;
export const TRANSFER_RECONCILIATION_STARTUP_DELAY_MS = 12_000;
export const TRANSFER_RECONCILIATION_SHUTDOWN_DRAIN_MS = 5_000;

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
    processWorkerId = generateTransferWorkerId();
  }
  return processWorkerId;
}

export async function executeTransferReconciliationWorkerPass(): Promise<TransferReconciliationPassStats | null> {
  if (isPassRunning) {
    rerunRequested = true;
    return null;
  }

  isPassRunning = true;
  let lastStats: TransferReconciliationPassStats | null = null;

  const runner = (async () => {
    try {
      do {
        rerunRequested = false;
        const stats = await runTransferReconciliationPass({
          workerId: getProcessWorkerId(),
          batchSize: TRANSFER_RECONCILIATION_BATCH_SIZE,
          leaseMs: TRANSFER_RECONCILIATION_LEASE_MS,
        });
        lastStats = stats;

        if (stats.claimed > 0) {
          console.log(
            `[TransferReconciliationWorker] Pass complete: claimed=${stats.claimed}, succeeded=${stats.succeeded}, failedRestored=${stats.failedRestored}, stillUncertain=${stats.stillUncertain}, retried=${stats.retried}, manualReviewRequired=${stats.manualReviewRequired}, leaseLost=${stats.leaseLost}`
          );
        }

        if (stats.claimed >= TRANSFER_RECONCILIATION_BATCH_SIZE && isWorkerStarted) {
          rerunRequested = true;
        }
      } while (rerunRequested && isWorkerStarted);
    } catch (err) {
      console.error(
        `[TransferReconciliationWorker] Pass failed: ${sanitizeTransferDiagnosticMessage(err)}`
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

export function triggerTransferReconciliationDispatch(): void {
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
    executeTransferReconciliationWorkerPass().catch((err) => {
      console.error(
        `[TransferReconciliationWorker] Wake-up dispatch error: ${sanitizeTransferDiagnosticMessage(err)}`
      );
    });
  }, 10);

  if (wakeupTimer.unref) {
    wakeupTimer.unref();
  }
}

export function startTransferReconciliationWorker(
  intervalMs = TRANSFER_RECONCILIATION_POLL_INTERVAL_MS
): void {
  if (workerInterval || isWorkerStarted) return;

  isWorkerStarted = true;
  processWorkerId = generateTransferWorkerId();

  console.log(
    `🔁 Transfer reconciliation worker started (workerId=${processWorkerId}, interval=${intervalMs / 1000}s)`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isWorkerStarted) return;
    executeTransferReconciliationWorkerPass().catch(() => {});
  }, TRANSFER_RECONCILIATION_STARTUP_DELAY_MS);

  if (startupTimer.unref) {
    startupTimer.unref();
  }

  workerInterval = setInterval(() => {
    if (!isWorkerStarted) return;
    executeTransferReconciliationWorkerPass().catch(() => {});
  }, intervalMs);

  if (workerInterval.unref) {
    workerInterval.unref();
  }
}

export async function stopTransferReconciliationWorker(
  drainTimeoutMs = TRANSFER_RECONCILIATION_SHUTDOWN_DRAIN_MS
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
    console.log('🛑 Transfer reconciliation worker stopped');
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
