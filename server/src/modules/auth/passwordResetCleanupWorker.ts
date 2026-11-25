import { purgeExpiredPasswordResetTokens } from './passwordReset.service.js';

export const PASSWORD_RESET_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_CLEANUP_STARTUP_DELAY_MS = 15_000;
export const PASSWORD_RESET_CLEANUP_SHUTDOWN_DRAIN_MS = 5_000;

let cleanupInterval: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isWorkerStarted = false;
let isCleanupRunning = false;
let activeCleanupPromise: Promise<void> | null = null;

/**
 * Overlap-guarded maintenance pass removing expired/stale PasswordResetToken records
 * beyond the retention window without failing the host server on transient errors.
 */
export async function runPasswordResetCleanupPass(
  purgeFn: () => Promise<number> = purgeExpiredPasswordResetTokens
): Promise<number> {
  if (isCleanupRunning) {
    return 0;
  }

  isCleanupRunning = true;
  let purgedCount = 0;

  const runner = (async () => {
    try {
      purgedCount = await purgeFn();
      if (purgedCount > 0) {
        console.log(
          `[PasswordResetCleanup] Purged ${purgedCount} expired password reset token record(s).`
        );
      }
    } catch (err) {
      const safeMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[PasswordResetCleanup] Cleanup pass failed: ${safeMsg}`);
      purgedCount = 0;
    } finally {
      isCleanupRunning = false;
      activeCleanupPromise = null;
    }
  })();

  activeCleanupPromise = runner;
  await runner;
  return purgedCount;
}

export function isPasswordResetCleanupWorkerRunning(): boolean {
  return isWorkerStarted;
}

export function startPasswordResetCleanupWorker(
  intervalMs = PASSWORD_RESET_CLEANUP_INTERVAL_MS,
  startupDelayMs = PASSWORD_RESET_CLEANUP_STARTUP_DELAY_MS
): void {
  if (cleanupInterval || isWorkerStarted) return;

  isWorkerStarted = true;
  console.log(
    `🧹 Password-reset cleanup worker started (interval: ${Math.round(intervalMs / 1000)}s)`
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isWorkerStarted) return;
    runPasswordResetCleanupPass().catch(() => {});
  }, startupDelayMs);

  if (startupTimer.unref) {
    startupTimer.unref();
  }

  cleanupInterval = setInterval(() => {
    if (!isWorkerStarted) return;
    runPasswordResetCleanupPass().catch(() => {});
  }, intervalMs);

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

export async function stopPasswordResetCleanupWorker(
  drainTimeoutMs = PASSWORD_RESET_CLEANUP_SHUTDOWN_DRAIN_MS
): Promise<void> {
  isWorkerStarted = false;

  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🛑 Password-reset cleanup worker stopped');
  }

  if (activeCleanupPromise && drainTimeoutMs > 0) {
    await Promise.race([
      activeCleanupPromise,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, drainTimeoutMs);
        if (t.unref) t.unref();
      }),
    ]);
  }
}
