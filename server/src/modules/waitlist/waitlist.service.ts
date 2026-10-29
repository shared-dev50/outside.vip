import crypto from 'crypto';
import { nanoid } from 'nanoid';
import {
  Prisma,
  WaitlistEntryStatus,
  WaitlistOfferStatus,
  EventStatus,
  OrderStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from '../../utils/errors.js';
import { sendWaitlistOfferEmail } from './waitlistEmail.service.js';

export const OFFER_EXPIRY_MINUTES = 30;

/**
 * Generates an unguessable high-entropy bearer token for waitlist offers.
 */
export function generateOfferToken(): string {
  return `wlot_${nanoid(36)}`;
}

/**
 * Computes the SHA-256 hash of a bearer token for safe database persistence and lookup.
 */
export function hashOfferToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

export interface JoinWaitlistInput {
  eventId: string;
  ticketTierId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  quantity: number;
}

/**
 * Registers an attendee for an event ticket tier's FIFO waitlist.
 */
export async function joinWaitlist(input: JoinWaitlistInput) {
  const normalizedEmail = input.customerEmail.trim().toLowerCase();
  const trimmedName = input.customerName.trim();

  if (!trimmedName) {
    throw new BadRequestError('Customer name is required');
  }

  // 1. Validate ticket tier and event eligibility
  const tier = await prisma.ticketTier.findUnique({
    where: { id: input.ticketTierId },
    include: {
      event: {
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          endAt: true,
          isPasswordProtected: true,
        },
      },
    },
  });

  if (!tier || tier.eventId !== input.eventId) {
    throw new NotFoundError('Ticket tier not found for this event');
  }

  if (tier.event.status === EventStatus.CANCELLED) {
    throw new BadRequestError('Cannot join waitlist for a cancelled event');
  }

  if (new Date(tier.event.endAt) < new Date()) {
    throw new BadRequestError('This event has already ended');
  }

  if (!tier.waitlistEnabled) {
    throw new BadRequestError('Waitlist is not enabled for this ticket tier');
  }

  if (input.quantity < 1) {
    throw new BadRequestError('Requested quantity must be at least 1');
  }

  if (input.quantity > tier.maxPerOrder) {
    throw new BadRequestError(
      `Requested quantity exceeds the maximum limit of ${tier.maxPerOrder} tickets for this tier`
    );
  }

  // 2. Prevent duplicate active registrations for normalized email & ticket tier
  const existingActiveEntry = await prisma.ticketWaitlistEntry.findFirst({
    where: {
      ticketTierId: input.ticketTierId,
      customerEmail: normalizedEmail,
      status: {
        in: [WaitlistEntryStatus.WAITING, WaitlistEntryStatus.OFFERED],
      },
    },
  });

  if (existingActiveEntry) {
    throw new ConflictError(
      'You already have an active waitlist entry for this ticket tier'
    );
  }

  // 3. Create entry in WAITING status
  const entry = await prisma.ticketWaitlistEntry.create({
    data: {
      eventId: tier.eventId,
      ticketTierId: tier.id,
      customerName: trimmedName,
      customerEmail: normalizedEmail,
      customerPhone: input.customerPhone?.trim() || null,
      quantity: input.quantity,
      status: WaitlistEntryStatus.WAITING,
    },
  });

  // 4. In case inventory is already available, trigger queue processing
  await processWaitlistForTier(tier.id).catch((err) => {
    console.error(`Error processing waitlist immediately after join for tier ${tier.id}:`, err);
  });

  // 5. Calculate queue position (count waiting entries created on or before this entry)
  const position = await prisma.ticketWaitlistEntry.count({
    where: {
      ticketTierId: tier.id,
      status: WaitlistEntryStatus.WAITING,
      createdAt: { lte: entry.createdAt },
    },
  });

  return {
    entry: {
      id: entry.id,
      ticketTierId: entry.ticketTierId,
      customerName: entry.customerName,
      customerEmail: entry.customerEmail,
      quantity: entry.quantity,
      status: entry.status,
      position,
      createdAt: entry.createdAt,
    },
    position,
    message: `You are #${position} in line. We will notify you by email as soon as tickets become available.`,
  };
}

export interface ProcessWaitlistResult {
  ticketTierId: string;
  offersCreated: number;
  availableRemaining: number;
}

/**
 * Evaluates FIFO waitlist entries for a ticket tier and creates timed purchase offers
 * if inventory is genuinely available.
 * 
 * Queue Policy:
 * 1. Strict FIFO ordering based on creation timestamp.
 * 2. Head-of-line fairness: if available capacity is less than the quantity requested
 *    by the next customer in line, we DO NOT skip them to satisfy a smaller request behind them.
 * 3. Inventory is atomically held in tier.reservedQuantity during the offer window (30 mins).
 */
export async function processWaitlistForTier(
  ticketTierId: string
): Promise<ProcessWaitlistResult> {
  // Use a serializable or atomic row-locked transaction to prevent race conditions across concurrent workers
  const txResult = await prisma.$transaction(async (tx) => {
    const tier = await tx.ticketTier.findUnique({
      where: { id: ticketTierId },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            slug: true,
            status: true,
          },
        },
      },
    });

    if (!tier || !tier.waitlistEnabled || tier.event.status === EventStatus.CANCELLED) {
      return { ticketTierId, offersCreated: 0, availableRemaining: 0, createdOffersList: [] };
    }

    const available = tier.totalCapacity - tier.soldQuantity - tier.reservedQuantity;
    if (available <= 0) {
      return { ticketTierId, offersCreated: 0, availableRemaining: 0, createdOffersList: [] };
    }

    // Fetch waiting entries in FIFO order
    const waitingEntries = await tx.ticketWaitlistEntry.findMany({
      where: {
        ticketTierId,
        status: WaitlistEntryStatus.WAITING,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (waitingEntries.length === 0) {
      return { ticketTierId, offersCreated: 0, availableRemaining: available, createdOffersList: [] };
    }

    console.log('[DEBUG_WAITLIST]', {
      tierId: tier.id,
      waitlistEnabled: tier.waitlistEnabled,
      eventStatus: tier.event.status,
      totalCapacity: tier.totalCapacity,
      soldQuantity: tier.soldQuantity,
      reservedQuantity: tier.reservedQuantity,
      available,
      waitingEntries: waitingEntries.map(e => ({ email: e.customerEmail, qty: e.quantity, status: e.status })),
    });

    let currentAvailable = available;
    const createdOffersList: Array<{
      offerId: string;
      rawToken: string;
      expiresAt: Date;
      quantity: number;
      entry: (typeof waitingEntries)[0];
      tier: typeof tier;
    }> = [];

    for (const entry of waitingEntries) {
      if (currentAvailable <= 0) break;

      // If the next waiting customer requested more tickets than are currently available,
      // stop processing. Do not jump the line for smaller orders behind them.
      if (entry.quantity > currentAvailable) {
        break;
      }

      const rawToken = generateOfferToken();
      const tokenHash = hashOfferToken(rawToken);
      const expiresAt = new Date(Date.now() + OFFER_EXPIRY_MINUTES * 60 * 1000);

      // 1. Increment reservedQuantity on the tier
      await tx.ticketTier.update({
        where: { id: ticketTierId },
        data: {
          reservedQuantity: { increment: entry.quantity },
        },
      });

      // 2. Transition entry status to OFFERED
      await tx.ticketWaitlistEntry.update({
        where: { id: entry.id },
        data: {
          status: WaitlistEntryStatus.OFFERED,
        },
      });

      // 3. Create offer record
      const offer = await tx.ticketWaitlistOffer.create({
        data: {
          entryId: entry.id,
          eventId: tier.eventId,
          ticketTierId,
          quantity: entry.quantity,
          status: WaitlistOfferStatus.PENDING,
          tokenHash,
          expiresAt,
        },
      });

      currentAvailable -= entry.quantity;

      createdOffersList.push({
        offerId: offer.id,
        rawToken,
        expiresAt,
        quantity: entry.quantity,
        entry,
        tier,
      });
    }

    return {
      ticketTierId,
      offersCreated: createdOffersList.length,
      availableRemaining: currentAvailable,
      createdOffersList,
    };
  });

  // Dispatches emails after transaction commits
  for (const item of txResult.createdOffersList) {
    const claimUrl = `${env.CLIENT_URL}/events/${item.tier.event.slug}?offerToken=${item.rawToken}`;
    const declineUrl = `${env.CLIENT_URL}/events/${item.tier.event.slug}?declineOffer=${item.rawToken}`;

    try {
      const emailRes = await sendWaitlistOfferEmail({
        to: item.entry.customerEmail,
        customerName: item.entry.customerName,
        eventTitle: item.tier.event.title,
        eventSlug: item.tier.event.slug,
        tierName: item.tier.name,
        quantity: item.quantity,
        claimUrl,
        declineUrl,
        expiresAt: item.expiresAt,
      });

      if (emailRes.success) {
        await prisma.ticketWaitlistOffer.update({
          where: { id: item.offerId },
          data: {
            notificationSentAt: new Date(),
            notificationAttempts: { increment: 1 },
            notificationError: null,
          },
        }).catch(() => { });
      } else {
        await prisma.ticketWaitlistOffer.update({
          where: { id: item.offerId },
          data: {
            notificationAttempts: { increment: 1 },
            notificationError: emailRes.error || 'Failed to dispatch email',
          },
        }).catch(() => { });
      }
    } catch (err: any) {
      console.error(`Error sending waitlist offer email for offer ${item.offerId}:`, err);
    }
  }

  return {
    ticketTierId: txResult.ticketTierId,
    offersCreated: txResult.offersCreated,
    availableRemaining: txResult.availableRemaining,
  };
}

/**
 * Looks up a waitlist offer by bearer token. If the offer has expired, automatically sweeps
 * and releases its inventory, advancing the waitlist for the tier.
 */
export async function lookupWaitlistOffer(rawToken: string) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new BadRequestError('Offer token is required');
  }

  const tokenHash = hashOfferToken(rawToken);

  const offer = await prisma.ticketWaitlistOffer.findUnique({
    where: { tokenHash },
    include: {
      entry: true,
      ticketTier: {
        select: {
          id: true,
          name: true,
          priceInCents: true,
          currency: true,
          totalCapacity: true,
          maxPerOrder: true,
        },
      },
      event: {
        select: {
          id: true,
          title: true,
          slug: true,
          startAt: true,
          endAt: true,
          timezone: true,
          venueName: true,
          city: true,
          coverImageUrl: true,
          status: true,
        },
      },
      order: {
        select: {
          id: true,
          status: true,
          expiresAt: true,
        },
      },
    },
  });

  if (!offer) {
    throw new NotFoundError('Waitlist offer not found or invalid token');
  }

  const now = new Date();

  // If the customer has initiated checkout and their checkout reservation hold is still active,
  // do NOT expire the offer: allow them to finish checkout within their 15-minute checkout reservation hold.
  const isActivelyCheckingOut = Boolean(
    offer.order &&
    offer.order.status === OrderStatus.PENDING &&
    offer.order.expiresAt > now
  );

  // If offer is pending but past its expiry time (and not actively checking out), mark it expired
  if (offer.status === WaitlistOfferStatus.PENDING && offer.expiresAt < now && !isActivelyCheckingOut) {
    await prisma.$transaction(async (tx) => {
      await tx.ticketWaitlistOffer.update({
        where: { id: offer.id },
        data: { status: WaitlistOfferStatus.EXPIRED },
      });

      await tx.ticketWaitlistEntry.update({
        where: { id: offer.entryId },
        data: { status: WaitlistEntryStatus.EXPIRED },
      });

      // Only decrement if checkout was never initiated; otherwise releaseExpiredReservations handles order holds
      if (!offer.orderId) {
        await tx.ticketTier.update({
          where: { id: offer.ticketTierId },
          data: {
            reservedQuantity: { decrement: offer.quantity },
          },
        });
      }
    });

    if (!offer.orderId) {
      await processWaitlistForTier(offer.ticketTierId).catch(() => { });
    }

    return {
      valid: false,
      expired: true,
      status: WaitlistOfferStatus.EXPIRED,
      message:
        'This waitlist offer has expired. The tickets have been released to the next eligible person in line.',
      event: offer.event,
    };
  }

  if (offer.status !== WaitlistOfferStatus.PENDING) {
    return {
      valid: false,
      expired: offer.status === WaitlistOfferStatus.EXPIRED,
      status: offer.status,
      message:
        offer.status === WaitlistOfferStatus.ACCEPTED
          ? 'This waitlist offer has already been claimed and purchased.'
          : 'This waitlist offer is no longer valid.',
      event: offer.event,
    };
  }

  const effectiveExpiry = isActivelyCheckingOut ? offer.order!.expiresAt : offer.expiresAt;
  const timeRemainingSeconds = Math.max(
    0,
    Math.floor((effectiveExpiry.getTime() - now.getTime()) / 1000)
  );

  return {
    valid: true,
    expired: false,
    status: offer.status,
    offer: {
      id: offer.id,
      token: rawToken,
      ticketTierId: offer.ticketTierId,
      tierName: offer.ticketTier.name,
      quantity: offer.quantity,
      unitPriceInCents: offer.ticketTier.priceInCents,
      totalInCents: offer.ticketTier.priceInCents * offer.quantity,
      currency: offer.ticketTier.currency,
      expiresAt: offer.expiresAt,
      timeRemainingSeconds,
      customerName: offer.entry.customerName,
      customerEmail: offer.entry.customerEmail,
      status: offer.status,
      ticketTier: offer.ticketTier,
      event: offer.event,
    },
  };
}

/**
 * Handles explicit declining of a waitlist offer by the customer.
 * Releases the reserved tickets and immediately triggers waitlist advancement.
 */
export async function declineWaitlistOffer(rawToken: string) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new BadRequestError('Offer token is required');
  }

  const tokenHash = hashOfferToken(rawToken);

  const offer = await prisma.ticketWaitlistOffer.findUnique({
    where: { tokenHash },
  });

  if (!offer) {
    throw new NotFoundError('Waitlist offer not found');
  }

  if (offer.status !== WaitlistOfferStatus.PENDING) {
    throw new BadRequestError(`Offer cannot be declined because it is already ${offer.status}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.ticketWaitlistOffer.update({
      where: { id: offer.id },
      data: { status: WaitlistOfferStatus.DECLINED },
    });

    await tx.ticketWaitlistEntry.update({
      where: { id: offer.entryId },
      data: { status: WaitlistEntryStatus.DECLINED },
    });

    await tx.ticketTier.update({
      where: { id: offer.ticketTierId },
      data: {
        reservedQuantity: { decrement: offer.quantity },
      },
    });
  });

  // Advance queue to next eligible customer immediately
  await processWaitlistForTier(offer.ticketTierId).catch(() => { });

  return {
    success: true,
    message: 'Offer declined. Thank you for notifying us.',
  };
}

/**
 * Sweeps all expired pending waitlist offers, restores inventory, and advances the waitlist.
 * Safe to run concurrently or periodically.
 */
export async function sweepExpiredOffers(): Promise<{
  expiredOffersCount: number;
  advancedTiersCount: number;
}> {
  const now = new Date();

  const expiredOffers = await prisma.ticketWaitlistOffer.findMany({
    where: {
      status: WaitlistOfferStatus.PENDING,
      expiresAt: { lt: now },
    },
    select: {
      id: true,
      entryId: true,
      ticketTierId: true,
      quantity: true,
      orderId: true,
      order: {
        select: {
          id: true,
          status: true,
          expiresAt: true,
        },
      },
    },
  });

  if (expiredOffers.length === 0) {
    return { expiredOffersCount: 0, advancedTiersCount: 0 };
  }

  const affectedTierIds = new Set<string>();

  for (const offer of expiredOffers) {
    // If the customer has initiated checkout and their checkout reservation hold is still active,
    // do NOT expire the offer: allow them to finish checkout within their checkout hold window.
    if (offer.order && offer.order.status === OrderStatus.PENDING && offer.order.expiresAt > now) {
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Atomic conditional update to guard against concurrent worker sweeps
        const updated = await tx.ticketWaitlistOffer.updateMany({
          where: {
            id: offer.id,
            status: WaitlistOfferStatus.PENDING,
          },
          data: { status: WaitlistOfferStatus.EXPIRED },
        });

        if (updated.count > 0) {
          await tx.ticketWaitlistEntry.update({
            where: { id: offer.entryId },
            data: { status: WaitlistEntryStatus.EXPIRED },
          });

          // Only decrement reservedQuantity if checkout was never initiated.
          // If checkout was initiated, releaseExpiredReservations() handles restoring
          // reservedQuantity when the order expires, preventing double-decrements.
          if (!offer.orderId) {
            await tx.ticketTier.update({
              where: { id: offer.ticketTierId },
              data: {
                reservedQuantity: { decrement: offer.quantity },
              },
            });

            affectedTierIds.add(offer.ticketTierId);
          }
        }
      });
    } catch (err) {
      console.error(`Error expiring waitlist offer ${offer.id}:`, err);
    }
  }

  // Advance waitlist for all affected tiers
  let advancedCount = 0;
  for (const tierId of affectedTierIds) {
    try {
      const res = await processWaitlistForTier(tierId);
      if (res.offersCreated > 0) {
        advancedCount++;
      }
    } catch (err) {
      console.error(`Error advancing waitlist for tier ${tierId}:`, err);
    }
  }

  return {
    expiredOffersCount: affectedTierIds.size > 0 ? expiredOffers.length : 0,
    advancedTiersCount: advancedCount,
  };
}

/**
 * Retrieves waitlist entries, offers, and summary metrics for an organizer's event.
 */
export async function getOrganizerWaitlist(
  eventId: string,
  organizerId: string,
  ticketTierId?: string
) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, organizerId: true, title: true },
  });

  if (!event) {
    throw new NotFoundError('Event not found');
  }

  if (event.organizerId !== organizerId) {
    throw new ForbiddenError('You do not have permission to view waitlist data for this event');
  }

  const whereClause: Prisma.TicketWaitlistEntryWhereInput = {
    eventId,
    ...(ticketTierId ? { ticketTierId } : {}),
  };

  const [entries, tiers] = await Promise.all([
    prisma.ticketWaitlistEntry.findMany({
      where: whereClause,
      include: {
        ticketTier: {
          select: {
            id: true,
            name: true,
            priceInCents: true,
            waitlistEnabled: true,
          },
        },
        offers: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            quantity: true,
            status: true,
            expiresAt: true,
            claimedAt: true,
            notificationSentAt: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.ticketTier.findMany({
      where: { eventId },
      select: {
        id: true,
        name: true,
        waitlistEnabled: true,
        totalCapacity: true,
        soldQuantity: true,
        reservedQuantity: true,
      },
    }),
  ]);

  // Aggregate tier summary stats
  const tierSummaries = tiers.map((tier) => {
    const tierEntries = entries.filter((e) => e.ticketTierId === tier.id);
    return {
      tierId: tier.id,
      tierName: tier.name,
      waitlistEnabled: tier.waitlistEnabled,
      totalCapacity: tier.totalCapacity,
      soldQuantity: tier.soldQuantity,
      reservedQuantity: tier.reservedQuantity,
      waitingCount: tierEntries.filter((e) => e.status === WaitlistEntryStatus.WAITING).length,
      offeredCount: tierEntries.filter((e) => e.status === WaitlistEntryStatus.OFFERED).length,
      purchasedCount: tierEntries.filter((e) => e.status === WaitlistEntryStatus.PURCHASED).length,
      expiredCount: tierEntries.filter((e) => e.status === WaitlistEntryStatus.EXPIRED).length,
      declinedCount: tierEntries.filter((e) => e.status === WaitlistEntryStatus.DECLINED).length,
    };
  });

  return {
    entries,
    tierSummaries,
  };
}

/**
 * Safely cancels active waitlist entries and pending offers for a list of event IDs (e.g. on event or occurrence cancellation).
 * Unrelated occurrences/events are completely unaffected.
 */
export async function cancelWaitlistForEventIds(eventIds: string[], tx?: Prisma.TransactionClient): Promise<void> {
  if (eventIds.length === 0) return;
  const db = tx ?? prisma;

  const tiers = await db.ticketTier.findMany({
    where: { eventId: { in: eventIds } },
    select: { id: true },
  });
  if (tiers.length === 0) return;
  const tierIds = tiers.map((t) => t.id);

  // 1. Mark pending offers as CANCELLED
  await db.ticketWaitlistOffer.updateMany({
    where: {
      ticketTierId: { in: tierIds },
      status: WaitlistOfferStatus.PENDING,
    },
    data: {
      status: WaitlistOfferStatus.CANCELLED,
    },
  });

  // 2. Mark WAITING and OFFERED entries as CANCELLED
  await db.ticketWaitlistEntry.updateMany({
    where: {
      ticketTierId: { in: tierIds },
      status: { in: [WaitlistEntryStatus.WAITING, WaitlistEntryStatus.OFFERED] },
    },
    data: {
      status: WaitlistEntryStatus.CANCELLED,
    },
  });

  // 3. Recalculate reservedQuantity for each tier
  for (const tierId of tierIds) {
    const reservations = await db.ticketReservation.aggregate({
      where: {
        ticketTierId: tierId,
        expiresAt: { gt: new Date() },
      },
      _sum: { quantity: true },
    });
    const activeResQty = reservations._sum.quantity ?? 0;
    await db.ticketTier.update({
      where: { id: tierId },
      data: { reservedQuantity: activeResQty },
    });
  }
}
