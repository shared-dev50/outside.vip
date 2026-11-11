import { PrismaClient } from '@prisma/client';
import { invalidateUserAuthCache } from '../lib/session.service.js';
import { isSimulatedRedisFailureActive } from '../lib/redis.js';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __prismaCacheHookRegistered: boolean | undefined;
}

export const prisma =
  globalThis.__prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

let userDbReadCount = 0;

export function getUserDbReadCount(): number {
  return userDbReadCount;
}

export function resetUserDbReadCount(): void {
  userDbReadCount = 0;
}

if (!globalThis.__prismaCacheHookRegistered && typeof prisma.$use === 'function') {
  globalThis.__prismaCacheHookRegistered = true;
  prisma.$use(async (params, next) => {
    if (
      params.model === 'User' &&
      (params.action === 'findUnique' || params.action === 'findFirst')
    ) {
      userDbReadCount += 1;
    }

    const result = await next(params);

    if (
      params.model === 'User' &&
      (params.action === 'update' ||
        params.action === 'upsert' ||
        params.action === 'delete')
    ) {
      const userId =
        (result && typeof (result as any).id === 'string' ? (result as any).id : null) ||
        (params.args?.where && typeof params.args.where.id === 'string'
          ? params.args.where.id
          : null);

      if (userId && !isSimulatedRedisFailureActive()) {
        try {
          await invalidateUserAuthCache(userId);
        } catch {
          // Ignore cache invalidation errors inside DB hook if Redis is offline
        }
      }
    }

    return result;
  });
}

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
