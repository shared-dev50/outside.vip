import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env, normalizeEmail } from '../config/env.js';

export interface AdminAuditEntry {
  actorUserId?: string | null;
  actorEmail: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export const recordedAdminAuditLogs: Array<AdminAuditEntry & { createdAt: Date }> = [];

export function resetRecordedAdminAuditLogs(): void {
  recordedAdminAuditLogs.length = 0;
}

export async function recordAdminAuditLog(entry: AdminAuditEntry): Promise<void> {
  const normalizedActorEmail = normalizeEmail(entry.actorEmail);
  const record = {
    ...entry,
    actorEmail: normalizedActorEmail,
    createdAt: new Date(),
  };

  recordedAdminAuditLogs.push(record);

  if (env.NODE_ENV !== 'test') {
    console.info(
      `[AdminAudit] action=${entry.action} actor=${normalizedActorEmail} target=${entry.targetType || 'none'}:${entry.targetId || 'none'}`
    );
  }

  try {
    if (prisma.adminAuditLog && typeof prisma.adminAuditLog.create === 'function') {
      await prisma.adminAuditLog.create({
        data: {
          actorUserId: entry.actorUserId ?? null,
          actorEmail: normalizedActorEmail,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          metadata: entry.metadata ? (entry.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          ipAddress: entry.ipAddress ?? null,
        },
      });
    }
  } catch (err) {
    // Do not fail the primary operation if prisma is mocked in a unit test
    if (env.NODE_ENV !== 'test') {
      console.error('[AdminAudit] Failed to persist AdminAuditLog entry:', err);
    }
  }
}
