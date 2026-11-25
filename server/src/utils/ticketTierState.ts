import { TicketTierStatus } from '@prisma/client';

export interface TicketTierStateLike {
  status?: TicketTierStatus | string | null;
  isHidden?: boolean | null;
  salesDisabled?: boolean | null;
}

/**
 * Backward-compatible visibility check:
 * Treats either the explicit `isHidden` flag OR legacy `status === HIDDEN` as hidden.
 */
export function isTicketTierHidden(tier: TicketTierStateLike): boolean {
  return Boolean(tier.isHidden) || tier.status === TicketTierStatus.HIDDEN;
}

/**
 * Backward-compatible sales-disabled check:
 * Treats either the explicit `salesDisabled` flag OR legacy `status === PAUSED` as sales-disabled.
 */
export function isTicketTierSalesDisabled(tier: TicketTierStateLike): boolean {
  return Boolean(tier.salesDisabled) || tier.status === TicketTierStatus.PAUSED;
}

/**
 * Normalizes a TicketTier record for API responses so legacy rows (`status: HIDDEN` / `status: PAUSED`)
 * expose consistent `isHidden` and `salesDisabled` booleans without mutating database records.
 */
export function normalizeTicketTierFlags<T extends TicketTierStateLike>(
  tier: T
): T & { isHidden: boolean; salesDisabled: boolean } {
  return {
    ...tier,
    isHidden: isTicketTierHidden(tier),
    salesDisabled: isTicketTierSalesDisabled(tier),
  };
}

/**
 * Resolves the persisted `{ status, isHidden, salesDisabled }` triple for create/update requests.
 * Supports:
 * - Modern clients sending explicit `isHidden` and/or `salesDisabled` booleans (independently toggleable).
 * - Legacy clients sending only `status` (`ACTIVE`, `PAUSED`, `HIDDEN`, `SOLD_OUT`).
 * - Preserving `SOLD_OUT` when capacity remains exhausted.
 */
export function resolveTicketTierPersistenceState(
  input: {
    status?: TicketTierStatus;
    isHidden?: boolean;
    salesDisabled?: boolean;
    totalCapacity?: number;
  },
  existing?: {
    status: TicketTierStatus;
    isHidden?: boolean;
    salesDisabled?: boolean;
    soldQuantity?: number;
    reservedQuantity?: number;
    totalCapacity?: number;
  }
): {
  status: TicketTierStatus;
  isHidden: boolean;
  salesDisabled: boolean;
} {
  const hasExplicitFlags =
    input.isHidden !== undefined || input.salesDisabled !== undefined;

  if (hasExplicitFlags) {
    const isHidden =
      input.isHidden !== undefined
        ? Boolean(input.isHidden)
        : existing
          ? isTicketTierHidden(existing)
          : input.status === TicketTierStatus.HIDDEN;

    const salesDisabled =
      input.salesDisabled !== undefined
        ? Boolean(input.salesDisabled)
        : existing
          ? isTicketTierSalesDisabled(existing)
          : input.status === TicketTierStatus.PAUSED;

    const effectiveCapacity = input.totalCapacity ?? existing?.totalCapacity ?? 0;
    const committed = (existing?.soldQuantity ?? 0) + (existing?.reservedQuantity ?? 0);
    const remainsSoldOut =
      Boolean(existing) &&
      effectiveCapacity > 0 &&
      committed >= effectiveCapacity;

    let status: TicketTierStatus;
    if (isHidden) {
      status = TicketTierStatus.HIDDEN;
    } else if (salesDisabled) {
      status = TicketTierStatus.PAUSED;
    } else if (input.status === TicketTierStatus.SOLD_OUT || remainsSoldOut) {
      status = TicketTierStatus.SOLD_OUT;
    } else {
      status = TicketTierStatus.ACTIVE;
    }

    return { status, isHidden, salesDisabled };
  }

  // Legacy path: caller only passed `status` (or omitted all three)
  if (input.status !== undefined) {
    return {
      status: input.status,
      isHidden: input.status === TicketTierStatus.HIDDEN,
      salesDisabled: input.status === TicketTierStatus.PAUSED,
    };
  }

  const resolvedStatus = existing?.status ?? TicketTierStatus.ACTIVE;
  return {
    status: resolvedStatus,
    isHidden: existing ? isTicketTierHidden(existing) : false,
    salesDisabled: existing ? isTicketTierSalesDisabled(existing) : false,
  };
}

