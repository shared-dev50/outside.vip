import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { EventStatus, TicketTierStatus, OrderStatus, TicketStatus, RecurrenceFrequency, Role, EventStaffStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  createEventSchema,
  updateEventSchema,
  payoutDetailsInputSchema,
  PayoutDetailsInput,
  earningsPreviewInputSchema,
  organizerWorkspaceSchema,
  organizerOrdersQuerySchema,
} from './organizer.schema.js';
import { calculateCombinedEarnings } from '../checkout/checkout.financials.js';
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError, UnauthorizedError } from '../../utils/errors.js';
import { getRedisClient } from '../../lib/redis.js';
import { invalidateUserAuthCache } from '../../lib/session.service.js';
import { calculateOccurrences, formatOccurrenceSlugSuffix } from '../events/recurrence.service.js';
import { assertStripeReadyForPaidPublishing } from '../finance/finance.service.js';
import { recordAdminAuditLog } from '../../lib/auditLogger.js';
import {
  isCloudinaryConfigured,
  generateSignedUploadParams,
  uploadImageBuffer,
  deleteCloudinaryAsset,
  generateThumbnailUrl,
} from '../../lib/cloudinary.js';
import {
  maskAccountNumber,
  getAccountNumberLast4,
  encryptAccountNumber,
  sanitizePayoutDetails,
} from '../../lib/payoutCrypto.js';
import { extractYouTubeVideoId, normalizeYouTubeUrl } from '../../utils/youtube.js';
import { hashEventPassword } from '../events/passwordAccess.service.js';
import { cancelWaitlistForEventIds, processWaitlistForTier } from '../waitlist/waitlist.service.js';
import { verifyAndNormalizeLocation } from '../places/places.service.js';
import {
  resolveEventAuthorization,
  hasEventPermission,
  parseAdminPermissions,
  EventAdminPermissions,
} from '../eventTeam/eventTeam.permissions.js';

async function saveOrganizerPayoutDetails(
  tx: any,
  userId: string,
  payoutInput: PayoutDetailsInput
) {
  const existingPayout = await tx.organizerPayoutDetails.findUnique({
    where: { userId },
  });

  let masked = existingPayout?.accountNumberMasked || '••••';
  let last4 = existingPayout?.accountNumberLast4 || '';
  let encrypted = existingPayout?.accountNumberEncrypted || null;

  if (payoutInput.accountNumber && !payoutInput.accountNumber.startsWith('••••')) {
    masked = maskAccountNumber(payoutInput.accountNumber);
    last4 = getAccountNumberLast4(payoutInput.accountNumber);
    encrypted = encryptAccountNumber(payoutInput.accountNumber);
  }

  return tx.organizerPayoutDetails.upsert({
    where: { userId },
    create: {
      userId,
      orgType: payoutInput.orgType,
      orgTypeOther: payoutInput.orgType === 'Other' ? payoutInput.orgTypeOther : null,
      registeredName: payoutInput.registeredName,
      registrationNumber: payoutInput.registrationNumber || null,
      country: payoutInput.country,
      address: payoutInput.address || null,
      contactPersonName: payoutInput.contactPersonName,
      contactEmail: payoutInput.contactEmail,
      accountHolderName: payoutInput.accountHolderName,
      bankName: payoutInput.bankName,
      bankCountry: payoutInput.bankCountry,
      accountCurrency: payoutInput.accountCurrency || 'USD',
      accountNumberMasked: masked,
      accountNumberLast4: last4,
      accountNumberEncrypted: encrypted,
      bankBranch: payoutInput.bankBranch || null,
      swiftBic: payoutInput.swiftBic || null,
      routingCode: payoutInput.routingCode || null,
    },
    update: {
      orgType: payoutInput.orgType,
      orgTypeOther: payoutInput.orgType === 'Other' ? payoutInput.orgTypeOther : null,
      registeredName: payoutInput.registeredName,
      registrationNumber: payoutInput.registrationNumber || null,
      country: payoutInput.country,
      address: payoutInput.address || null,
      contactPersonName: payoutInput.contactPersonName,
      contactEmail: payoutInput.contactEmail,
      accountHolderName: payoutInput.accountHolderName,
      bankName: payoutInput.bankName,
      bankCountry: payoutInput.bankCountry,
      accountCurrency: payoutInput.accountCurrency || 'USD',
      accountNumberMasked: masked,
      accountNumberLast4: last4,
      ...(encrypted ? { accountNumberEncrypted: encrypted } : {}),
      bankBranch: payoutInput.bankBranch || null,
      swiftBic: payoutInput.swiftBic || null,
      routingCode: payoutInput.routingCode || null,
    },
  });
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Ensures the verified user has an OrganizerProfile workspace and updates non-admin role to ORGANIZER.
 * Preserves all existing attendee capabilities and orders.
 */
export async function ensureOrganizerWorkspaceForUser(
  userId: string,
  preferredDisplayName?: string
) {
  try {
    if (!prisma.organizerProfile || typeof prisma.organizerProfile.findUnique !== 'function') {
      return null;
    }

    const existingProfile = await prisma.organizerProfile.findUnique({
      where: { userId },
    });

    if (existingProfile) {
      return existingProfile;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    if (!user) {
      return null;
    }

    const displayName = (preferredDisplayName || user.name || 'Organizer').trim();
    const baseSlug = slugify(displayName) || 'organizer';
    let slug = baseSlug;
    let counter = 1;
    while (await prisma.organizerProfile.findUnique({ where: { slug } })) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const createdProfile = await prisma.organizerProfile.create({
      data: {
        userId: user.id,
        displayName,
        slug,
      },
    });

    if (user.role === Role.ATTENDEE) {
      await prisma.user.update({
        where: { id: user.id },
        data: { role: Role.ORGANIZER },
      });
      await invalidateUserAuthCache(user.id).catch(() => {});
    }

    return createdProfile;
  } catch {
    return null;
  }
}

export async function getOrganizerWorkspace(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const profile = await prisma.organizerProfile.findUnique({
      where: { userId },
    });

    res.json({
      success: true,
      data: {
        organizer: profile,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function upsertOrganizerWorkspace(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const input = organizerWorkspaceSchema.parse(req.body);

    const existing = await prisma.organizerProfile.findUnique({
      where: { userId },
    });

    let profile;
    if (existing) {
      profile = await prisma.organizerProfile.update({
        where: { userId },
        data: {
          displayName: input.displayName,
          ...(input.bio !== undefined && { bio: input.bio }),
          ...(input.websiteUrl !== undefined && { websiteUrl: input.websiteUrl }),
          ...(input.instagramHandle !== undefined && { instagramHandle: input.instagramHandle }),
          ...(input.twitterHandle !== undefined && { twitterHandle: input.twitterHandle }),
          ...(input.logoUrl !== undefined && { logoUrl: input.logoUrl }),
        },
      });
    } else {
      const baseSlug = slugify(input.displayName) || 'organizer';
      let slug = baseSlug;
      let counter = 1;
      while (await prisma.organizerProfile.findUnique({ where: { slug } })) {
        counter++;
        slug = `${baseSlug}-${counter}`;
      }

      profile = await prisma.organizerProfile.create({
        data: {
          userId,
          displayName: input.displayName,
          slug,
          bio: input.bio ?? null,
          websiteUrl: input.websiteUrl ?? null,
          instagramHandle: input.instagramHandle ?? null,
          twitterHandle: input.twitterHandle ?? null,
          logoUrl: input.logoUrl ?? null,
        },
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (user && user.role === Role.ATTENDEE) {
      await prisma.user.update({
        where: { id: userId },
        data: { role: Role.ORGANIZER },
      });
      await invalidateUserAuthCache(userId).catch(() => {});
    }

    res.status(existing ? 200 : 201).json({
      success: true,
      data: {
        organizer: profile,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getDashboardStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;

    const [totalEvents, publishedEvents, draftEvents] = await Promise.all([
      prisma.event.count({ where: { organizerId } }),
      prisma.event.count({ where: { organizerId, status: EventStatus.PUBLISHED } }),
      prisma.event.count({ where: { organizerId, status: EventStatus.DRAFT } }),
    ]);

    const ticketsSoldCount = await prisma.ticket.count({
      where: {
        event: { organizerId },
        status: { in: [TicketStatus.ISSUED, TicketStatus.CHECKED_IN] },
      },
    });

    const completedOrders = await prisma.order.findMany({
      where: {
        event: { organizerId },
        status: OrderStatus.COMPLETED,
      },
      select: { totalInCents: true },
    });

    const grossRevenueInCents = completedOrders.reduce((sum, order) => sum + order.totalInCents, 0);

    res.json({
      success: true,
      data: {
        totalEvents,
        publishedEvents,
        draftEvents,
        ticketsSold: ticketsSoldCount,
        grossRevenueInCents,
        grossRevenueFormatted: `$${(grossRevenueInCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        currency: 'USD',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function listOrganizerEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const isPlatformAdmin = req.user!.role === Role.ADMIN;

    // SEC-14 Part A: Include events where the user holds an active EventTeamMember ADMIN membership
    // without weakening authorization or exposing owner-only payout details.
    const adminMembershipsByEventId = new Map<string, EventAdminPermissions>();
    if (prisma.eventTeamMember && typeof prisma.eventTeamMember.findMany === 'function') {
      try {
        const memberships = await prisma.eventTeamMember.findMany({
          where: {
            userId: organizerId,
            role: 'ADMIN',
            status: 'ACTIVE',
          },
          select: {
            eventId: true,
            role: true,
            status: true,
            permissions: true,
          },
        });
        if (Array.isArray(memberships)) {
          for (const membership of memberships) {
            if (membership.role === 'ADMIN' && membership.status === 'ACTIVE') {
              adminMembershipsByEventId.set(
                membership.eventId,
                parseAdminPermissions(membership.permissions)
              );
            }
          }
        }
      } catch {
        // Ignore if eventTeamMember is unavailable in isolated unit test mocks
      }
    }

    const adminEventIds = Array.from(adminMembershipsByEventId.keys());
    const where: Prisma.EventWhereInput =
      adminEventIds.length > 0
        ? {
            OR: [{ organizerId }, { id: { in: adminEventIds } }],
          }
        : { organizerId };

    const events = await prisma.event.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        ticketTiers: {
          select: {
            id: true,
            name: true,
            priceInCents: true,
            totalCapacity: true,
            soldQuantity: true,
            status: true,
          },
        },
        orders: {
          where: { status: OrderStatus.COMPLETED },
          select: { totalInCents: true },
        },
      },
    });

    const seenEventIds = new Set<string>();
    const enhanced = [];

    for (const event of events) {
      if (seenEventIds.has(event.id)) {
        continue;
      }
      seenEventIds.add(event.id);

      const isOwner = event.organizerId === organizerId;
      const adminPerms = adminMembershipsByEventId.get(event.id);
      const canSeeOrderFinancials =
        isOwner || isPlatformAdmin || Boolean(adminPerms?.canViewOrders);

      const totalCapacity = event.ticketTiers.reduce((acc, t) => acc + t.totalCapacity, 0);
      const ticketsSold = event.ticketTiers.reduce((acc, t) => acc + t.soldQuantity, 0);
      const revenueInCents = canSeeOrderFinancials
        ? event.orders.reduce((acc, o) => acc + o.totalInCents, 0)
        : 0;

      // Clean orders array and sensitive/owner-only fields before returning
      const { orders: _, passwordHash: __, ...rest } = event;
      const accessRole: 'OWNER' | 'ADMIN' = isOwner ? 'OWNER' : 'ADMIN';
      enhanced.push({
        ...rest,
        isOwner,
        accessRole,
        permissions: isOwner ? null : (adminPerms ?? null),
        payoutDetails: null,
        payoutDetailsId: isOwner ? event.payoutDetailsId : null,
        totalCapacity,
        ticketsSold,
        revenueInCents,
        revenueFormatted: `$${(revenueInCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      });
    }

    res.json({
      success: true,
      data: { events: enhanced },
    });
  } catch (error) {
    next(error);
  }
}

export async function getOrganizerEventById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        ticketTiers: {
          orderBy: { priceInCents: 'asc' },
        },
        galleryImages: {
          orderBy: { displayOrder: 'asc' },
        },
        features: {
          orderBy: { displayOrder: 'asc' },
        },
        payoutDetails: true,
        series: {
          include: {
            events: {
              orderBy: { startAt: 'asc' },
              select: {
                id: true,
                slug: true,
                occurrenceIndex: true,
                startAt: true,
                endAt: true,
                status: true,
                isCustomized: true,
              },
            },
          },
        },
        organizer: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            organizer: true,
            payoutDetails: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    if (event.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      const authCtx = await resolveEventAuthorization(id, req.user!);
      if (authCtx.isHost || (!authCtx.isOwner && !authCtx.isAdmin)) {
        throw new ForbiddenError(
          'Event hosts are restricted to personal promotional links and traffic and cannot access organizer event details.'
        );
      }
    }

    const isOwner = event.organizerId === organizerId;
    const effectivePayout = isOwner ? (event.payoutDetails || event.organizer?.payoutDetails || null) : null;
    const sanitizedPayout = isOwner ? sanitizePayoutDetails(effectivePayout) : null;
    const sanitizedOrganizer = {
      ...event.organizer,
      payoutDetails: isOwner ? sanitizePayoutDetails(event.organizer?.payoutDetails) : null,
    };

    const tierIds = event.ticketTiers.map((t) => t.id);
    let waitlistStats: Record<string, { waiting: number; offered: number }> = {};
    if (tierIds.length > 0) {
      const [waitingCounts, offeredCounts] = await Promise.all([
        prisma.ticketWaitlistEntry.groupBy({
          by: ['ticketTierId'],
          where: { ticketTierId: { in: tierIds }, status: 'WAITING' },
          _count: { id: true },
        }),
        prisma.ticketWaitlistEntry.groupBy({
          by: ['ticketTierId'],
          where: { ticketTierId: { in: tierIds }, status: 'OFFERED' },
          _count: { id: true },
        }),
      ]);
      for (const w of waitingCounts) {
        waitlistStats[w.ticketTierId] = {
          waiting: w._count.id,
          offered: waitlistStats[w.ticketTierId]?.offered ?? 0,
        };
      }
      for (const o of offeredCounts) {
        waitlistStats[o.ticketTierId] = {
          waiting: waitlistStats[o.ticketTierId]?.waiting ?? 0,
          offered: o._count.id,
        };
      }
    }

    const enrichedTicketTiers = event.ticketTiers.map((tier) => ({
      ...tier,
      waitlistWaitingCount: waitlistStats[tier.id]?.waiting ?? 0,
      waitlistOfferedCount: waitlistStats[tier.id]?.offered ?? 0,
    }));

    const sanitizedEvent = {
      ...event,
      ticketTiers: enrichedTicketTiers,
      passwordHash: undefined,
      payoutDetails: sanitizedPayout,
      payoutDetailsId: isOwner ? event.payoutDetailsId : null,
      organizer: sanitizedOrganizer,
    };

    res.json({
      success: true,
      data: {
        event: sanitizedEvent,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getUploadSignature(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isCloudinaryConfigured()) {
      throw new BadRequestError(
        'Cloudinary is not configured on the server. Please configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
      );
    }

    const signParams = generateSignedUploadParams();
    res.json({
      success: true,
      data: signParams,
    });
  } catch (error) {
    next(error);
  }
}

export async function handleDirectUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file || !req.file.buffer) {
      throw new BadRequestError('No image file uploaded.');
    }

    if (!isCloudinaryConfigured()) {
      throw new BadRequestError(
        'Cloudinary is not configured on the server. Please configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
      );
    }

    const uploadResult = await uploadImageBuffer(req.file.buffer);

    res.json({
      success: true,
      data: {
        secure_url: uploadResult.secure_url,
        public_id: uploadResult.public_id,
        thumbnailUrl: uploadResult.thumbnailUrl,
        format: uploadResult.format,
        width: uploadResult.width,
        height: uploadResult.height,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function createOrganizerEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const input = createEventSchema.parse(req.body);

    await ensureOrganizerWorkspaceForUser(organizerId);

    // Saving drafts does not require Stripe onboarding.
    // Publishing a paid event directly on creation requires a ready Stripe Connect Express account.
    if (input.status === EventStatus.PUBLISHED) {
      const activeTiers = input.ticketTiers.filter(
        (t) => t.status !== TicketTierStatus.HIDDEN && t.totalCapacity > 0
      );
      if (activeTiers.length === 0) {
        throw new BadRequestError(
          'At least one active ticket tier with positive capacity is required to publish'
        );
      }
      const hasPaidTier = activeTiers.some((t) => (t.priceInCents ?? 0) > 0);
      if (hasPaidTier) {
        await assertStripeReadyForPaidPublishing(organizerId);
      }
    }

    const baseSlug = slugify(input.title) || 'event';

    let youtubeVideoId: string | null = null;
    let youtubeVideoUrl: string | null = null;
    if (input.youtubeVideoUrl) {
      const vid = extractYouTubeVideoId(input.youtubeVideoUrl);
      if (vid) {
        youtubeVideoId = vid;
        youtubeVideoUrl = normalizeYouTubeUrl(vid);
      }
    }

    let passwordHash: string | null = null;
    if (input.isPasswordProtected && input.password) {
      passwordHash = await hashEventPassword(input.password);
    }

    const normalizedLocation = await verifyAndNormalizeLocation({
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      city: input.city,
      country: input.country,
      latitude: input.latitude,
      longitude: input.longitude,
      placeId: input.placeId,
    });

    // Duplicate prevention: If the exact same organizer submitted an event with identical title and start time within the last 15 seconds, return existing event
    if (!input.recurrence) {
      const recentDuplicate = await prisma.event.findFirst({
        where: {
          organizerId,
          title: input.title,
          startAt: new Date(input.startAt),
          createdAt: {
            gte: new Date(Date.now() - 15000),
          },
        },
        include: {
          ticketTiers: true,
          galleryImages: { orderBy: { displayOrder: 'asc' } },
          features: { orderBy: { displayOrder: 'asc' } },
          payoutDetails: true,
        },
      });

      if (recentDuplicate) {
        res.status(200).json({
          success: true,
          data: { event: recentDuplicate },
        });
        return;
      }
    }

    if (input.recurrence) {
      const occurrences = calculateOccurrences({
        baseStartAt: input.startAt,
        baseEndAt: input.endAt,
        timezone: input.timezone,
        rule: input.recurrence,
      });

      const result = await prisma.$transaction(async (tx) => {
        let payoutDetailsId: string | null = null;
        if (input.payoutDetails) {
          const savedPayout = await saveOrganizerPayoutDetails(tx, organizerId, input.payoutDetails);
          payoutDetailsId = savedPayout.id;
        } else {
          const existingPayout = await tx.organizerPayoutDetails.findUnique({
            where: { userId: organizerId },
          });
          if (existingPayout) {
            payoutDetailsId = existingPayout.id;
          }
        }

        const series = await tx.eventSeries.create({
          data: {
            organizerId,
            title: input.title,
            frequency: input.recurrence!.frequency,
            interval: input.recurrence!.interval ?? 1,
            byWeekday: input.recurrence!.byWeekday ?? [],
            startDate: new Date(input.startAt),
            endDate: input.recurrence!.endDate ? new Date(input.recurrence!.endDate) : null,
            count: input.recurrence!.count ?? occurrences.length,
            timezone: input.timezone,
            showOnExplore: input.showOnExplore,
            hideGuestCount: input.hideGuestCount,
            isPasswordProtected: input.isPasswordProtected,
            passwordHash,
            youtubeVideoId,
            youtubeVideoUrl,
          },
        });

        const createdEvents = [];
        for (const occ of occurrences) {
          const occSuffix = occ.occurrenceIndex === 1 ? '' : `-${formatOccurrenceSlugSuffix(occ.startAt, input.timezone)}`;
          const candidateBaseSlug = `${baseSlug}${occSuffix}`;
          let occSlug = candidateBaseSlug;
          let counter = 1;
          while (await tx.event.findUnique({ where: { slug: occSlug } })) {
            counter++;
            occSlug = `${candidateBaseSlug}-${counter}`;
          }

          const created = await tx.event.create({
            data: {
              slug: occSlug,
              seriesId: series.id,
              occurrenceIndex: occ.occurrenceIndex,
              isCustomized: false,
              organizerId,
              title: input.title,
              tagline: input.tagline,
              description: input.description,
              category: input.category,
              status: input.status,
              coverImageUrl: input.coverImageUrl,
              coverImagePublicId: input.coverImagePublicId || null,
              thumbnailUrl:
                input.thumbnailUrl ||
                (input.coverImagePublicId ? generateThumbnailUrl(input.coverImageUrl) : null),
              venueName: normalizedLocation.venueName,
              venueAddress: normalizedLocation.venueAddress,
              city: normalizedLocation.city,
              country: normalizedLocation.country,
              latitude: normalizedLocation.latitude,
              longitude: normalizedLocation.longitude,
              placeId: normalizedLocation.placeId,
              startAt: occ.startAt,
              endAt: occ.endAt,
              timezone: input.timezone,
              ageRestriction: input.ageRestriction,
              dressCode: input.dressCode,
              showOnExplore: input.showOnExplore,
              hideGuestCount: input.hideGuestCount,
              isPasswordProtected: input.isPasswordProtected,
              passwordHash,
              youtubeVideoId,
              youtubeVideoUrl,
              payoutDetailsId,
              galleryImages: {
                create: (input.galleryImages || []).map((img, i) => ({
                  imageUrl: img.imageUrl,
                  publicId: img.publicId || null,
                  displayOrder: img.displayOrder !== undefined ? img.displayOrder : i,
                })),
              },
              features: {
                create: (input.features || []).map((feat, i) => ({
                  name: feat.name,
                  type: feat.type,
                  imageUrl: feat.imageUrl || null,
                  imagePublicId: feat.imagePublicId || null,
                  description: feat.description || null,
                  displayOrder: feat.displayOrder !== undefined ? feat.displayOrder : i,
                })),
              },
              ticketTiers: {
                create: input.ticketTiers.map((tier) => {
                  const shiftMs = occ.startAt.getTime() - occurrences[0].startAt.getTime();
                  return {
                    name: tier.name,
                    description: tier.description,
                    priceInCents: tier.priceInCents,
                    currency: tier.currency,
                    totalCapacity: tier.totalCapacity,
                    minPerOrder: tier.minPerOrder,
                    maxPerOrder: tier.maxPerOrder,
                    salesStartAt: tier.salesStartAt
                      ? new Date(new Date(tier.salesStartAt).getTime() + shiftMs)
                      : null,
                    salesEndAt: tier.salesEndAt
                      ? new Date(new Date(tier.salesEndAt).getTime() + shiftMs)
                      : null,
                    validityStartAt: tier.validityStartAt
                      ? new Date(new Date(tier.validityStartAt).getTime() + shiftMs)
                      : null,
                    validityEndAt: tier.validityEndAt
                      ? new Date(new Date(tier.validityEndAt).getTime() + shiftMs)
                      : null,
                    status: tier.status,
                    waitlistEnabled: tier.waitlistEnabled ?? false,
                  };
                }),
              },
            },
            include: {
              ticketTiers: true,
              galleryImages: { orderBy: { displayOrder: 'asc' } },
              features: { orderBy: { displayOrder: 'asc' } },
              payoutDetails: true,
            },
          });
          createdEvents.push(created);
        }

        return {
          primaryEvent: createdEvents[0],
          series,
          occurrences: createdEvents,
        };
      });

      res.status(201).json({
        success: true,
        data: {
          event: {
            ...result.primaryEvent,
            passwordHash: undefined,
            payoutDetails: sanitizePayoutDetails(result.primaryEvent.payoutDetails),
            series: {
              ...result.series,
              passwordHash: undefined,
              occurrencesCount: result.occurrences.length,
              occurrences: result.occurrences.map((e) => ({
                id: e.id,
                slug: e.slug,
                startAt: e.startAt,
                endAt: e.endAt,
                occurrenceIndex: e.occurrenceIndex,
                status: e.status,
              })),
            },
          },
        },
      });
      return;
    }

    let slug = baseSlug;
    let counter = 1;
    while (await prisma.event.findUnique({ where: { slug } })) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const event = await prisma.$transaction(async (tx) => {
      let payoutDetailsId: string | null = null;
      if (input.payoutDetails) {
        const savedPayout = await saveOrganizerPayoutDetails(tx, organizerId, input.payoutDetails);
        payoutDetailsId = savedPayout.id;
      } else {
        const existingPayout = await tx.organizerPayoutDetails.findUnique({
          where: { userId: organizerId },
        });
        if (existingPayout) {
          payoutDetailsId = existingPayout.id;
        }
      }

      return tx.event.create({
        data: {
          slug,
          organizerId,
          title: input.title,
          tagline: input.tagline,
          description: input.description,
          category: input.category,
          status: input.status,
          coverImageUrl: input.coverImageUrl,
          coverImagePublicId: input.coverImagePublicId || null,
          thumbnailUrl:
            input.thumbnailUrl ||
            (input.coverImagePublicId ? generateThumbnailUrl(input.coverImageUrl) : null),
          venueName: normalizedLocation.venueName,
          venueAddress: normalizedLocation.venueAddress,
          city: normalizedLocation.city,
          country: normalizedLocation.country,
          latitude: normalizedLocation.latitude,
          longitude: normalizedLocation.longitude,
          placeId: normalizedLocation.placeId,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          timezone: input.timezone,
          ageRestriction: input.ageRestriction,
          dressCode: input.dressCode,
          showOnExplore: input.showOnExplore,
          hideGuestCount: input.hideGuestCount,
          isPasswordProtected: input.isPasswordProtected,
          passwordHash,
          youtubeVideoId,
          youtubeVideoUrl,
          payoutDetailsId,
          galleryImages: {
            create: (input.galleryImages || []).map((img, i) => ({
              imageUrl: img.imageUrl,
              publicId: img.publicId || null,
              displayOrder: img.displayOrder !== undefined ? img.displayOrder : i,
            })),
          },
          features: {
            create: (input.features || []).map((feat, i) => ({
              name: feat.name,
              type: feat.type,
              imageUrl: feat.imageUrl || null,
              imagePublicId: feat.imagePublicId || null,
              description: feat.description || null,
              displayOrder: feat.displayOrder !== undefined ? feat.displayOrder : i,
            })),
          },
          ticketTiers: {
            create: input.ticketTiers.map((tier) => ({
              name: tier.name,
              description: tier.description,
              priceInCents: tier.priceInCents,
              currency: tier.currency,
              totalCapacity: tier.totalCapacity,
              minPerOrder: tier.minPerOrder,
              maxPerOrder: tier.maxPerOrder,
              salesStartAt: tier.salesStartAt ? new Date(tier.salesStartAt) : null,
              salesEndAt: tier.salesEndAt ? new Date(tier.salesEndAt) : null,
              validityStartAt: tier.validityStartAt ? new Date(tier.validityStartAt) : null,
              validityEndAt: tier.validityEndAt ? new Date(tier.validityEndAt) : null,
              status: tier.status,
              waitlistEnabled: tier.waitlistEnabled ?? false,
            })),
          },
        },
        include: {
          ticketTiers: true,
          galleryImages: { orderBy: { displayOrder: 'asc' } },
          features: { orderBy: { displayOrder: 'asc' } },
          payoutDetails: true,
        },
      });
    });

    res.status(201).json({
      success: true,
      data: {
        event: {
          ...event,
          passwordHash: undefined,
          payoutDetails: sanitizePayoutDetails(event.payoutDetails),
        },
      },
    });
  } catch (error) {
    if (req.body?.coverImagePublicId) {
      deleteCloudinaryAsset(req.body.coverImagePublicId).catch((err) =>
        console.error('Failed to cleanup orphan Cloudinary asset on event creation failure:', err)
      );
    }
    next(error);
  }
}

export async function updateOrganizerEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  let existingEvent: any = null;
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    existingEvent = await prisma.event.findUnique({
      where: { id },
      include: {
        ticketTiers: true,
        galleryImages: { orderBy: { displayOrder: 'asc' } },
        features: { orderBy: { displayOrder: 'asc' } },
      },
    });

    if (!existingEvent) {
      throw new NotFoundError('Event not found');
    }

    const isOwner = existingEvent.organizerId === organizerId;

    // SEC-02: Only the actual Event Owner may submit or modify payoutDetails or payoutDetailsId
    const hasPayoutPayload = Boolean(
      req.body &&
        typeof req.body === 'object' &&
        (Object.prototype.hasOwnProperty.call(req.body, 'payoutDetails') ||
          Object.prototype.hasOwnProperty.call(req.body, 'payoutDetailsId'))
    );

    if (!isOwner && hasPayoutPayload) {
      throw new ForbiddenError('Only the event owner can submit or modify payout details.');
    }

    const input = updateEventSchema.parse(req.body);

    const enforceStatusTransitionAuth = async (
      targetEventId: string,
      currentStatus: EventStatus,
      requestedStatus: EventStatus | undefined
    ) => {
      if (requestedStatus === undefined || requestedStatus === currentStatus) {
        return;
      }
      if (isOwner || req.user!.role === 'ADMIN') {
        return;
      }
      if (requestedStatus === EventStatus.CANCELLED) {
        await resolveEventAuthorization(targetEventId, req.user!, 'canCancelEvent');
      } else if (requestedStatus === EventStatus.ARCHIVED) {
        await resolveEventAuthorization(targetEventId, req.user!, 'canDeleteEvent');
      } else if (requestedStatus === EventStatus.PUBLISHED) {
        throw new ForbiddenError('You do not have permission to publish this event');
      } else if (requestedStatus === EventStatus.DRAFT) {
        throw new ForbiddenError('You do not have permission to unpublish this event');
      }
    };

    if (!isOwner && req.user!.role !== 'ADMIN') {
      await resolveEventAuthorization(id, req.user!, 'canEditDetails');
      if (input.ticketTiers !== undefined) {
        await resolveEventAuthorization(id, req.user!, 'canManageTickets');
      }
      await enforceStatusTransitionAuth(id, existingEvent.status, input.status);
    }

    // SEC-04: Validate that every supplied ticketTier.id belongs to existingEvent before any database writes
    if (input.ticketTiers !== undefined) {
      const existingTierIds = new Set(existingEvent.ticketTiers.map((t: any) => t.id));
      for (const tier of input.ticketTiers) {
        if (tier.id && !existingTierIds.has(tier.id)) {
          throw new ForbiddenError(
            `Ticket tier '${tier.id}' does not belong to this event.`
          );
        }
      }
    }

    // SEC-03: If applyToFuture is requested on a series, enforce lifecycle & edit permissions across future occurrences
    if (input.applyToFuture && existingEvent.seriesId && !isOwner && req.user!.role !== 'ADMIN') {
      if (input.status === EventStatus.PUBLISHED) {
        throw new ForbiddenError('You do not have permission to publish this event');
      }
      if (input.status === EventStatus.DRAFT) {
        throw new ForbiddenError('You do not have permission to unpublish this event');
      }
      const futureOccurrencesForAuth = await prisma.event.findMany({
        where: {
          seriesId: existingEvent.seriesId,
          startAt: { gte: existingEvent.startAt },
          id: { not: id },
        },
        select: { id: true, status: true },
      });

      for (const occ of futureOccurrencesForAuth) {
        await resolveEventAuthorization(occ.id, req.user!, 'canEditDetails');
        if (input.ticketTiers !== undefined) {
          await resolveEventAuthorization(occ.id, req.user!, 'canManageTickets');
        }
        await enforceStatusTransitionAuth(occ.id, occ.status, input.status);
      }
    }

    if (existingEvent.organizerId !== organizerId && req.user!.role === 'ADMIN') {
      await recordAdminAuditLog({
        actorUserId: organizerId,
        actorEmail: req.user!.email,
        action: 'ADMIN_EVENT_UPDATE_OVERRIDE',
        targetType: 'Event',
        targetId: existingEvent.id,
        metadata: { eventOrganizerId: existingEvent.organizerId },
        ipAddress: req.ip,
      });
    }

    // If transitioning to PUBLISHED or updating tiers on a PUBLISHED event, enforce Stripe readiness for paid tiers
    const nextStatus = input.status ?? existingEvent.status;
    if (
      nextStatus === EventStatus.PUBLISHED &&
      (existingEvent.status !== EventStatus.PUBLISHED || input.ticketTiers !== undefined)
    ) {
      const effectiveTiers = input.ticketTiers ?? existingEvent.ticketTiers;
      const activeTiers = effectiveTiers.filter(
        (t: any) => t.status !== TicketTierStatus.HIDDEN && t.totalCapacity > 0
      );
      const hasPaidTier = activeTiers.some((t: any) => (t.priceInCents ?? 0) > 0);
      if (hasPaidTier) {
        await assertStripeReadyForPaidPublishing(existingEvent.organizerId);
      }
    }

    // Preserve existing legacy Base64 if untouched, but reject newly uploaded Base64 strings
    if (input.coverImageUrl && input.coverImageUrl.startsWith('data:image/')) {
      if (input.coverImageUrl !== existingEvent.coverImageUrl) {
        throw new BadRequestError(
          'Base64 image data cannot be newly uploaded. Please use the Cloudinary upload flow.'
        );
      }
    }

    const startAtDate = input.startAt ? new Date(input.startAt) : existingEvent.startAt;
    const endAtDate = input.endAt ? new Date(input.endAt) : existingEvent.endAt;
    if (endAtDate.getTime() <= startAtDate.getTime()) {
      throw new BadRequestError('Event end time must be after the start time');
    }

    let youtubeVideoId: string | null | undefined = undefined;
    let youtubeVideoUrl: string | null | undefined = undefined;
    if (input.youtubeVideoUrl !== undefined) {
      if (!input.youtubeVideoUrl || input.youtubeVideoUrl.trim() === '') {
        youtubeVideoId = null;
        youtubeVideoUrl = null;
      } else {
        const videoId = extractYouTubeVideoId(input.youtubeVideoUrl.trim());
        if (!videoId) {
          throw new BadRequestError(
            'Invalid YouTube video URL. Please provide a valid YouTube watch, youtu.be, or embed link.'
          );
        }
        youtubeVideoId = videoId;
        youtubeVideoUrl = normalizeYouTubeUrl(videoId);
      }
    }

    let isPasswordProtected: boolean | undefined = undefined;
    let passwordHash: string | null | undefined = undefined;
    if (input.isPasswordProtected !== undefined) {
      if (input.isPasswordProtected) {
        if (input.password) {
          passwordHash = await hashEventPassword(input.password);
          isPasswordProtected = true;
        } else if (existingEvent.isPasswordProtected && existingEvent.passwordHash) {
          isPasswordProtected = true;
          // Keep existing password hash
        } else {
          throw new BadRequestError('Password is required when enabling password protection');
        }
      } else {
        isPasswordProtected = false;
        passwordHash = null;
      }
    } else if (input.password) {
      passwordHash = await hashEventPassword(input.password);
      isPasswordProtected = true;
    }

    if (input.galleryImages && input.galleryImages.length > 10) {
      throw new BadRequestError('A maximum of 10 gallery images is allowed');
    }
    if (input.features && input.features.length > 50) {
      throw new BadRequestError('A maximum of 50 features is allowed');
    }

    // Track removed gallery public IDs for cleanup after transaction
    const oldGalleryPublicIds = (existingEvent.galleryImages || [])
      .map((g: any) => g.publicId)
      .filter(Boolean) as string[];
    const newGalleryPublicIds = new Set(
      (input.galleryImages || []).map((g) => g.publicId).filter(Boolean)
    );
    const removedGalleryPublicIds =
      input.galleryImages !== undefined
        ? oldGalleryPublicIds.filter((pid) => !newGalleryPublicIds.has(pid))
        : [];

    const oldPublicId = existingEvent.coverImagePublicId;
    const isImageReplaced =
      (input.coverImagePublicId !== undefined && input.coverImagePublicId !== oldPublicId) ||
      (input.coverImageUrl !== undefined && input.coverImageUrl !== existingEvent.coverImageUrl && oldPublicId);

    const isLocationUpdated =
      input.venueName !== undefined ||
      input.venueAddress !== undefined ||
      input.city !== undefined ||
      input.country !== undefined ||
      input.latitude !== undefined ||
      input.longitude !== undefined ||
      input.placeId !== undefined;

    let normalizedLocation: {
      venueName?: string;
      venueAddress?: string;
      city?: string;
      country?: string;
      latitude?: number | null;
      longitude?: number | null;
      placeId?: string | null;
    } = {};

    if (isLocationUpdated) {
      if (input.placeId !== undefined) {
        // placeId explicitly provided (either new placeId string or null for manual mode)
        const verified = await verifyAndNormalizeLocation({
          venueName: input.venueName !== undefined ? input.venueName : existingEvent.venueName,
          venueAddress: input.venueAddress !== undefined ? input.venueAddress : existingEvent.venueAddress,
          city: input.city !== undefined ? input.city : existingEvent.city,
          country: input.country !== undefined ? input.country : existingEvent.country,
          latitude: input.latitude,
          longitude: input.longitude,
          placeId: input.placeId,
        });
        normalizedLocation = {
          venueName: verified.venueName,
          venueAddress: verified.venueAddress,
          city: verified.city,
          country: verified.country,
          latitude: verified.latitude,
          longitude: verified.longitude,
          placeId: verified.placeId,
        };
      } else {
        // Backward compatibility: placeId not specified in input (preserve existing coordinates/placeId)
        if (input.latitude !== undefined && input.latitude !== null) {
          if (typeof input.latitude !== 'number' || input.latitude < -90 || input.latitude > 90) {
            throw new BadRequestError('Latitude must be a valid number between -90 and 90');
          }
        }
        if (input.longitude !== undefined && input.longitude !== null) {
          if (typeof input.longitude !== 'number' || input.longitude < -180 || input.longitude > 180) {
            throw new BadRequestError('Longitude must be a valid number between -180 and 180');
          }
        }

        normalizedLocation = {
          ...(input.venueName !== undefined && { venueName: input.venueName.trim() }),
          ...(input.venueAddress !== undefined && { venueAddress: input.venueAddress.trim() }),
          ...(input.city !== undefined && { city: input.city.trim() }),
          ...(input.country !== undefined && { country: input.country.trim() }),
          ...(input.latitude !== undefined && { latitude: input.latitude }),
          ...(input.longitude !== undefined && { longitude: input.longitude }),
        };
      }
    }

    const updatedEvent = await prisma.$transaction(async (tx) => {
      let payoutDetailsId = existingEvent.payoutDetailsId;
      if (isOwner && input.payoutDetails) {
        const savedPayout = await saveOrganizerPayoutDetails(tx, existingEvent.organizerId, input.payoutDetails);
        payoutDetailsId = savedPayout.id;
      }

      // If updating a series and applyToFuture is true, propagate changes to future occurrences
      if (input.applyToFuture && existingEvent.seriesId) {
        if (
          input.recurrence ||
          input.title ||
          youtubeVideoId !== undefined ||
          isPasswordProtected !== undefined ||
          input.showOnExplore !== undefined ||
          input.hideGuestCount !== undefined
        ) {
          await tx.eventSeries.update({
            where: { id: existingEvent.seriesId },
            data: {
              ...(input.title && { title: input.title }),
              ...(input.recurrence?.frequency && { frequency: input.recurrence.frequency }),
              ...(input.recurrence?.interval && { interval: input.recurrence.interval }),
              ...(input.recurrence?.byWeekday && { byWeekday: input.recurrence.byWeekday }),
              ...(input.recurrence?.endDate !== undefined && {
                endDate: input.recurrence.endDate ? new Date(input.recurrence.endDate) : null,
              }),
              ...(input.recurrence?.count !== undefined && { count: input.recurrence.count }),
              ...(input.timezone && { timezone: input.timezone }),
              ...(input.showOnExplore !== undefined && { showOnExplore: input.showOnExplore }),
              ...(input.hideGuestCount !== undefined && { hideGuestCount: input.hideGuestCount }),
              ...(isPasswordProtected !== undefined && { isPasswordProtected }),
              ...(passwordHash !== undefined && { passwordHash }),
              ...(youtubeVideoId !== undefined && { youtubeVideoId }),
              ...(youtubeVideoUrl !== undefined && { youtubeVideoUrl }),
            },
          });
        }

        const futureOccurrences = await tx.event.findMany({
          where: {
            seriesId: existingEvent.seriesId,
            startAt: { gte: existingEvent.startAt },
            id: { not: id },
          },
          include: { ticketTiers: true },
        });

        for (const occ of futureOccurrences) {
          await tx.event.update({
            where: { id: occ.id },
            data: {
              ...(input.title !== undefined && { title: input.title }),
              ...(input.tagline !== undefined && { tagline: input.tagline }),
              ...(input.description !== undefined && { description: input.description }),
              ...(input.category !== undefined && { category: input.category }),
              ...(input.coverImageUrl !== undefined && { coverImageUrl: input.coverImageUrl }),
              ...(input.coverImagePublicId !== undefined && { coverImagePublicId: input.coverImagePublicId }),
              ...(input.thumbnailUrl !== undefined && {
                thumbnailUrl:
                  input.thumbnailUrl ||
                  (input.coverImagePublicId ? generateThumbnailUrl(input.coverImageUrl || occ.coverImageUrl) : null),
              }),
              ...(normalizedLocation.venueName !== undefined && { venueName: normalizedLocation.venueName }),
              ...(normalizedLocation.venueAddress !== undefined && { venueAddress: normalizedLocation.venueAddress }),
              ...(normalizedLocation.city !== undefined && { city: normalizedLocation.city }),
              ...(normalizedLocation.country !== undefined && { country: normalizedLocation.country }),
              ...(normalizedLocation.latitude !== undefined && { latitude: normalizedLocation.latitude }),
              ...(normalizedLocation.longitude !== undefined && { longitude: normalizedLocation.longitude }),
              ...(normalizedLocation.placeId !== undefined && { placeId: normalizedLocation.placeId }),
              ...(input.timezone !== undefined && { timezone: input.timezone }),
              ...(input.ageRestriction !== undefined && { ageRestriction: input.ageRestriction }),
              ...(input.dressCode !== undefined && { dressCode: input.dressCode }),
              ...(input.status !== undefined && { status: input.status }),
              ...(input.showOnExplore !== undefined && { showOnExplore: input.showOnExplore }),
              ...(input.hideGuestCount !== undefined && { hideGuestCount: input.hideGuestCount }),
              ...(isPasswordProtected !== undefined && { isPasswordProtected }),
              ...(passwordHash !== undefined && { passwordHash }),
              ...(youtubeVideoId !== undefined && { youtubeVideoId }),
              ...(youtubeVideoUrl !== undefined && { youtubeVideoUrl }),
            },
          });

          // Sync gallery on future occurrences if updated
          if (input.galleryImages !== undefined) {
            await tx.eventGalleryImage.deleteMany({ where: { eventId: occ.id } });
            if (input.galleryImages.length > 0) {
              await tx.eventGalleryImage.createMany({
                data: input.galleryImages.map((img, i) => ({
                  eventId: occ.id,
                  imageUrl: img.imageUrl,
                  publicId: img.publicId || null,
                  displayOrder: img.displayOrder !== undefined ? img.displayOrder : i,
                })),
              });
            }
          }

          // Sync features on future occurrences if updated
          if (input.features !== undefined) {
            await tx.eventFeature.deleteMany({ where: { eventId: occ.id } });
            if (input.features.length > 0) {
              await tx.eventFeature.createMany({
                data: input.features.map((feat, i) => ({
                  eventId: occ.id,
                  name: feat.name,
                  type: feat.type,
                  imageUrl: feat.imageUrl || null,
                  imagePublicId: feat.imagePublicId || null,
                  description: feat.description || null,
                  displayOrder: feat.displayOrder !== undefined ? feat.displayOrder : i,
                })),
              });
            }
          }

          // Safely sync tiers on future occurrences with 0 sales
          if (input.ticketTiers) {
            const occSales = occ.ticketTiers.reduce((acc: number, t: any) => acc + t.soldQuantity, 0);
            if (occSales === 0) {
              await tx.ticketTier.deleteMany({ where: { eventId: occ.id } });
              await tx.ticketTier.createMany({
                data: input.ticketTiers.map((tier) => ({
                  eventId: occ.id,
                  name: tier.name,
                  description: tier.description,
                  priceInCents: tier.priceInCents,
                  currency: tier.currency,
                  totalCapacity: tier.totalCapacity,
                  minPerOrder: tier.minPerOrder,
                  maxPerOrder: tier.maxPerOrder,
                  salesStartAt: tier.salesStartAt ? new Date(tier.salesStartAt) : null,
                  salesEndAt: tier.salesEndAt ? new Date(tier.salesEndAt) : null,
                  validityStartAt: tier.validityStartAt ? new Date(tier.validityStartAt) : null,
                  validityEndAt: tier.validityEndAt ? new Date(tier.validityEndAt) : null,
                  status: tier.status,
                  waitlistEnabled: tier.waitlistEnabled ?? false,
                })),
              });
            }
          }
        }
      }

      await tx.event.update({
        where: { id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.tagline !== undefined && { tagline: input.tagline }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.category !== undefined && { category: input.category }),
          ...(input.coverImageUrl !== undefined && { coverImageUrl: input.coverImageUrl }),
          ...(input.coverImagePublicId !== undefined && { coverImagePublicId: input.coverImagePublicId }),
          ...(input.thumbnailUrl !== undefined && {
            thumbnailUrl:
              input.thumbnailUrl ||
              (input.coverImagePublicId
                ? generateThumbnailUrl(input.coverImageUrl || existingEvent.coverImageUrl)
                : null),
          }),
          ...(normalizedLocation.venueName !== undefined && { venueName: normalizedLocation.venueName }),
          ...(normalizedLocation.venueAddress !== undefined && { venueAddress: normalizedLocation.venueAddress }),
          ...(normalizedLocation.city !== undefined && { city: normalizedLocation.city }),
          ...(normalizedLocation.country !== undefined && { country: normalizedLocation.country }),
          ...(normalizedLocation.latitude !== undefined && { latitude: normalizedLocation.latitude }),
          ...(normalizedLocation.longitude !== undefined && { longitude: normalizedLocation.longitude }),
          ...(normalizedLocation.placeId !== undefined && { placeId: normalizedLocation.placeId }),
          ...(input.startAt !== undefined && { startAt: new Date(input.startAt) }),
          ...(input.endAt !== undefined && { endAt: new Date(input.endAt) }),
          ...(input.timezone !== undefined && { timezone: input.timezone }),
          ...(input.ageRestriction !== undefined && { ageRestriction: input.ageRestriction }),
          ...(input.dressCode !== undefined && { dressCode: input.dressCode }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.showOnExplore !== undefined && { showOnExplore: input.showOnExplore }),
          ...(input.hideGuestCount !== undefined && { hideGuestCount: input.hideGuestCount }),
          ...(isPasswordProtected !== undefined && { isPasswordProtected }),
          ...(passwordHash !== undefined && { passwordHash }),
          ...(youtubeVideoId !== undefined && { youtubeVideoId }),
          ...(youtubeVideoUrl !== undefined && { youtubeVideoUrl }),
          ...(existingEvent.seriesId && !input.applyToFuture ? { isCustomized: true } : {}),
          ...(isOwner && payoutDetailsId ? { payoutDetailsId } : {}),
        },
      });

      if (input.galleryImages !== undefined) {
        await tx.eventGalleryImage.deleteMany({ where: { eventId: id } });
        if (input.galleryImages.length > 0) {
          await tx.eventGalleryImage.createMany({
            data: input.galleryImages.map((img, i) => ({
              eventId: id,
              imageUrl: img.imageUrl,
              publicId: img.publicId || null,
              displayOrder: img.displayOrder !== undefined ? img.displayOrder : i,
            })),
          });
        }
      }

      if (input.features !== undefined) {
        await tx.eventFeature.deleteMany({ where: { eventId: id } });
        if (input.features.length > 0) {
          await tx.eventFeature.createMany({
            data: input.features.map((feat, i) => ({
              eventId: id,
              name: feat.name,
              type: feat.type,
              imageUrl: feat.imageUrl || null,
              imagePublicId: feat.imagePublicId || null,
              description: feat.description || null,
              displayOrder: feat.displayOrder !== undefined ? feat.displayOrder : i,
            })),
          });
        }
      }

      if (input.ticketTiers) {
        const incomingTierIds = new Set(input.ticketTiers.filter((t) => t.id).map((t) => t.id));

        for (const existingTier of existingEvent.ticketTiers) {
          if (!incomingTierIds.has(existingTier.id)) {
            if (existingTier.soldQuantity > 0) {
              // Preserve historical sales! Deactivate instead of deleting
              await tx.ticketTier.update({
                where: { id: existingTier.id },
                data: { status: TicketTierStatus.HIDDEN },
              });
            } else {
              await tx.ticketTier.delete({ where: { id: existingTier.id } });
            }
          }
        }

        for (const tier of input.ticketTiers) {
          if (tier.id) {
            await tx.ticketTier.update({
              where: { id: tier.id, eventId: id },
              data: {
                name: tier.name,
                description: tier.description,
                priceInCents: tier.priceInCents,
                currency: tier.currency,
                totalCapacity: tier.totalCapacity,
                minPerOrder: tier.minPerOrder,
                maxPerOrder: tier.maxPerOrder,
                salesStartAt: tier.salesStartAt ? new Date(tier.salesStartAt) : null,
                salesEndAt: tier.salesEndAt ? new Date(tier.salesEndAt) : null,
                validityStartAt: tier.validityStartAt ? new Date(tier.validityStartAt) : null,
                validityEndAt: tier.validityEndAt ? new Date(tier.validityEndAt) : null,
                status: tier.status,
                ...(tier.waitlistEnabled !== undefined && { waitlistEnabled: tier.waitlistEnabled }),
              },
            });
          } else {
            await tx.ticketTier.create({
              data: {
                eventId: id,
                name: tier.name,
                description: tier.description,
                priceInCents: tier.priceInCents,
                currency: tier.currency,
                totalCapacity: tier.totalCapacity,
                minPerOrder: tier.minPerOrder,
                maxPerOrder: tier.maxPerOrder,
                salesStartAt: tier.salesStartAt ? new Date(tier.salesStartAt) : null,
                salesEndAt: tier.salesEndAt ? new Date(tier.salesEndAt) : null,
                validityStartAt: tier.validityStartAt ? new Date(tier.validityStartAt) : null,
                validityEndAt: tier.validityEndAt ? new Date(tier.validityEndAt) : null,
                status: tier.status,
                waitlistEnabled: tier.waitlistEnabled ?? false,
              },
            });
          }
        }
      }

      return tx.event.findUnique({
        where: { id },
        include: {
          ticketTiers: {
            orderBy: { priceInCents: 'asc' },
          },
          galleryImages: {
            orderBy: { displayOrder: 'asc' },
          },
          features: {
            orderBy: { displayOrder: 'asc' },
          },
          payoutDetails: true,
          series: {
            include: {
              events: {
                orderBy: { startAt: 'asc' },
                select: {
                  id: true,
                  slug: true,
                  occurrenceIndex: true,
                  startAt: true,
                  endAt: true,
                  status: true,
                  isCustomized: true,
                },
              },
            },
          },
        },
      });
    });

    // Safely delete replaced Cloudinary cover asset only if DB commit succeeded and no other event uses it
    if (isImageReplaced && oldPublicId) {
      const referenceCount = await prisma.event.count({
        where: {
          coverImagePublicId: oldPublicId,
          id: { not: id },
        },
      });
      if (referenceCount === 0) {
        deleteCloudinaryAsset(oldPublicId).catch((err) =>
          console.error(`Failed to delete replaced Cloudinary asset "${oldPublicId}":`, err)
        );
      }
    }

    // Safely delete removed gallery assets
    if (removedGalleryPublicIds.length > 0) {
      for (const pid of removedGalleryPublicIds) {
        const refCount = await prisma.eventGalleryImage.count({ where: { publicId: pid } });
        if (refCount === 0) {
          deleteCloudinaryAsset(pid).catch((err) =>
            console.error(`Failed to delete removed gallery Cloudinary asset "${pid}":`, err)
          );
        }
      }
    }

    if (input.ticketTiers && updatedEvent?.ticketTiers) {
      for (const tier of updatedEvent.ticketTiers) {
        if (tier.waitlistEnabled) {
          processWaitlistForTier(tier.id).catch((err) =>
            console.error(`Failed to process waitlist after updating tier ${tier.id}:`, err)
          );
        }
      }
    }

    res.json({
      success: true,
      data: {
        event: {
          ...updatedEvent,
          passwordHash: undefined,
          payoutDetails: isOwner ? sanitizePayoutDetails(updatedEvent?.payoutDetails) : null,
          payoutDetailsId: isOwner ? (updatedEvent?.payoutDetailsId ?? null) : null,
        },
      },
    });
  } catch (error) {
    if (req.body?.coverImagePublicId && req.body.coverImagePublicId !== existingEvent?.coverImagePublicId) {
      deleteCloudinaryAsset(req.body.coverImagePublicId).catch((err) =>
        console.error('Failed to cleanup orphan Cloudinary asset on update failure:', err)
      );
    }
    next(error);
  }
}

export async function publishEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const event = await prisma.event.findUnique({
      where: { id },
      include: { ticketTiers: true },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    if (event.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to publish this event');
    }

    if (event.organizerId !== organizerId && req.user!.role === 'ADMIN') {
      await recordAdminAuditLog({
        actorUserId: organizerId,
        actorEmail: req.user!.email,
        action: 'ADMIN_EVENT_PUBLISH_OVERRIDE',
        targetType: 'Event',
        targetId: event.id,
        metadata: { eventOrganizerId: event.organizerId },
        ipAddress: req.ip,
      });
    }

    if (!event.title || event.title.trim().length < 2) {
      throw new BadRequestError('Event title must be at least 2 characters to publish');
    }

    if (!event.venueName || event.venueName.trim().length === 0) {
      throw new BadRequestError('Venue name is required before publishing');
    }

    if (!event.city || event.city.trim().length === 0) {
      throw new BadRequestError('City is required before publishing');
    }

    if (!event.coverImageUrl || event.coverImageUrl.trim().length === 0) {
      throw new BadRequestError('Cover artwork image is required before publishing');
    }

    if (new Date(event.endAt).getTime() <= new Date(event.startAt).getTime()) {
      throw new BadRequestError('Event end time must be after start time');
    }

    const activeTiers = event.ticketTiers.filter(
      (t) => t.status !== TicketTierStatus.HIDDEN && t.totalCapacity > 0
    );

    if (activeTiers.length === 0) {
      throw new BadRequestError('At least one active ticket tier with positive capacity is required to publish');
    }

    const publishSeries = req.query.publishSeries === 'true' || req.body?.publishSeries === true;

    if (publishSeries && event.seriesId) {
      // Validate all occurrences before publishing
      const seriesOccurrences = await prisma.event.findMany({
        where: {
          seriesId: event.seriesId,
          startAt: { gte: new Date() },
        },
        include: { ticketTiers: true },
      });

      let seriesHasPaidTier = false;
      for (const occ of seriesOccurrences) {
        if (!occ.title || occ.title.trim().length < 2) {
          throw new BadRequestError(`Occurrence #${occ.occurrenceIndex || 1} has an invalid title`);
        }
        if (!occ.venueName) {
          throw new BadRequestError(`Occurrence #${occ.occurrenceIndex || 1} requires venue name`);
        }
        const occActiveTiers = occ.ticketTiers.filter(
          (t) => t.status !== TicketTierStatus.HIDDEN && t.totalCapacity > 0
        );
        if (occActiveTiers.length === 0) {
          throw new BadRequestError(`Occurrence #${occ.occurrenceIndex || 1} requires at least one active ticket tier`);
        }
        if (occActiveTiers.some((t) => (t.priceInCents ?? 0) > 0)) {
          seriesHasPaidTier = true;
        }
      }

      if (seriesHasPaidTier) {
        await assertStripeReadyForPaidPublishing(event.organizerId);
      }

      await prisma.event.updateMany({
        where: {
          seriesId: event.seriesId,
          startAt: { gte: new Date() },
          status: { not: EventStatus.CANCELLED },
        },
        data: { status: EventStatus.PUBLISHED },
      });

      const updated = await prisma.event.findUnique({
        where: { id },
        include: { ticketTiers: true },
      });

      res.json({
        success: true,
        data: {
          event: updated,
          message: `All ${seriesOccurrences.length} series occurrences successfully published to Outside.vip public discovery!`,
        },
      });
      return;
    }

    // Free events (all active tiers have priceInCents === 0) can be published without Stripe onboarding.
    // Paid events (any active tier has priceInCents > 0) require Stripe Connect readiness.
    const hasPaidTier = activeTiers.some((t) => (t.priceInCents ?? 0) > 0);
    if (hasPaidTier) {
      await assertStripeReadyForPaidPublishing(event.organizerId);
    }

    const updated = await prisma.event.update({
      where: { id },
      data: { status: EventStatus.PUBLISHED },
      include: { ticketTiers: true },
    });

    res.json({
      success: true,
      data: {
        event: updated,
        message: 'Event successfully published to Outside.vip public discovery!',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function unpublishEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const event = await prisma.event.findUnique({
      where: { id },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    if (event.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to unpublish this event');
    }

    if (event.organizerId !== organizerId && req.user!.role === 'ADMIN') {
      await recordAdminAuditLog({
        actorUserId: organizerId,
        actorEmail: req.user!.email,
        action: 'ADMIN_EVENT_UNPUBLISH_OVERRIDE',
        targetType: 'Event',
        targetId: event.id,
        metadata: { eventOrganizerId: event.organizerId },
        ipAddress: req.ip,
      });
    }

    const unpublishSeries = req.query.unpublishSeries === 'true' || req.body?.unpublishSeries === true;
    if (unpublishSeries && event.seriesId) {
      await prisma.event.updateMany({
        where: {
          seriesId: event.seriesId,
          startAt: { gte: new Date() },
          status: EventStatus.PUBLISHED,
        },
        data: { status: EventStatus.DRAFT },
      });

      const updated = await prisma.event.findUnique({
        where: { id },
        include: { ticketTiers: true },
      });

      res.json({
        success: true,
        data: {
          event: updated,
          message: 'All future occurrences in the series reverted to draft status.',
        },
      });
      return;
    }

    const updated = await prisma.event.update({
      where: { id },
      data: { status: EventStatus.DRAFT },
      include: { ticketTiers: true },
    });

    res.json({
      success: true,
      data: {
        event: updated,
        message: 'Event unpublished and reverted to draft status.',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelOrganizerEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const event = await prisma.event.findUnique({
      where: { id },
      include: { series: true },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    if (event.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      await resolveEventAuthorization(id, req.user!, 'canCancelEvent');
    }

    if (event.organizerId !== organizerId && req.user!.role === 'ADMIN') {
      await recordAdminAuditLog({
        actorUserId: organizerId,
        actorEmail: req.user!.email,
        action: 'ADMIN_EVENT_CANCEL_OVERRIDE',
        targetType: 'Event',
        targetId: event.id,
        metadata: { eventOrganizerId: event.organizerId },
        ipAddress: req.ip,
      });
    }

    const updated = await prisma.event.update({
      where: { id },
      data: { status: EventStatus.CANCELLED },
      include: { ticketTiers: true },
    });

    await cancelWaitlistForEventIds([id]);

    res.json({
      success: true,
      data: {
        event: updated,
        message: event.seriesId
          ? `Occurrence #${event.occurrenceIndex || 1} has been cancelled. Other occurrences in the series remain unchanged.`
          : 'Event has been cancelled.',
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelOrganizerSeries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const series = await prisma.eventSeries.findUnique({
      where: { id },
      include: {
        events: {
          where: {
            startAt: { gte: new Date() },
            status: { not: EventStatus.CANCELLED },
          },
        },
      },
    });

    if (!series) {
      throw new NotFoundError('Event series not found');
    }

    if (series.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to cancel this series');
    }

    const updateResult = await prisma.event.updateMany({
      where: {
        seriesId: id,
        startAt: { gte: new Date() },
        status: { not: EventStatus.CANCELLED },
      },
      data: {
        status: EventStatus.CANCELLED,
      },
    });

    const cancelledEventIds = series.events.map((e) => e.id);
    await cancelWaitlistForEventIds(cancelledEventIds);

    res.json({
      success: true,
      data: {
        seriesId: id,
        cancelledCount: updateResult.count,
        message: `Cancelled ${updateResult.count} upcoming occurrence(s) in this series. Past events and history were preserved.`,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getOrganizerSeries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const series = await prisma.eventSeries.findUnique({
      where: { id },
      include: {
        events: {
          orderBy: { startAt: 'asc' },
          include: {
            ticketTiers: {
              select: {
                id: true,
                name: true,
                priceInCents: true,
                totalCapacity: true,
                soldQuantity: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!series) {
      throw new NotFoundError('Event series not found');
    }

    if (series.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to view this series');
    }

    const occurrences = series.events.map((e) => {
      const totalCapacity = e.ticketTiers.reduce((acc, t) => acc + t.totalCapacity, 0);
      const ticketsSold = e.ticketTiers.reduce((acc, t) => acc + t.soldQuantity, 0);
      return {
        id: e.id,
        slug: e.slug,
        occurrenceIndex: e.occurrenceIndex,
        startAt: e.startAt,
        endAt: e.endAt,
        status: e.status,
        isCustomized: e.isCustomized,
        totalCapacity,
        ticketsSold,
      };
    });

    res.json({
      success: true,
      data: {
        series: {
          ...series,
          occurrences,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteOrganizerEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const { id } = req.params;

    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        tickets: true,
        orders: true,
      },
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    if (event.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      await resolveEventAuthorization(id, req.user!, 'canDeleteEvent');
    }

    if (event.organizerId !== organizerId && req.user!.role === 'ADMIN') {
      await recordAdminAuditLog({
        actorUserId: organizerId,
        actorEmail: req.user!.email,
        action: 'ADMIN_EVENT_DELETE_OVERRIDE',
        targetType: 'Event',
        targetId: event.id,
        metadata: { eventOrganizerId: event.organizerId },
        ipAddress: req.ip,
      });
    }

    if (event.tickets.length > 0 || event.orders.length > 0) {
      throw new BadRequestError(
        'Cannot delete an event with existing orders or tickets. You can unpublish or archive it instead to preserve attendee records.'
      );
    }

    const [
      promotionLinksCount,
      promotionClicksCount,
      promotionVisitorDaysCount,
      promotionAttributionsCount,
    ] = await Promise.all([
      prisma.promotionLink ? prisma.promotionLink.count({ where: { eventId: id } }) : Promise.resolve(0),
      prisma.promotionClick ? prisma.promotionClick.count({ where: { eventId: id } }) : Promise.resolve(0),
      prisma.promotionVisitorDay
        ? prisma.promotionVisitorDay.count({ where: { eventId: id } })
        : Promise.resolve(0),
      prisma.promotionVisitorAttribution
        ? prisma.promotionVisitorAttribution.count({ where: { eventId: id } })
        : Promise.resolve(0),
    ]);

    if (
      promotionLinksCount > 0 ||
      promotionClicksCount > 0 ||
      promotionVisitorDaysCount > 0 ||
      promotionAttributionsCount > 0
    ) {
      throw new ConflictError(
        'Cannot delete an event with existing promotional links or traffic analytics history. Please unpublish or archive the event instead to preserve promotional links and historical analytics.',
        'EVENT_HAS_PROMOTIONAL_HISTORY'
      );
    }

    const assetToDelete = event.coverImagePublicId;

    await prisma.event.delete({ where: { id } });

    // Safely delete Cloudinary asset only after DB deletion succeeded and if no other event uses it
    if (assetToDelete) {
      const remainingReferences = await prisma.event.count({
        where: { coverImagePublicId: assetToDelete },
      });
      if (remainingReferences === 0) {
        deleteCloudinaryAsset(assetToDelete).catch((err) =>
          console.error(`Failed to delete Cloudinary asset "${assetToDelete}" after event deletion:`, err)
        );
      }
    }

    res.json({
      success: true,
      data: { message: 'Event successfully deleted.' },
    });
  } catch (error) {
    next(error);
  }
}

export async function getOrganizerPayoutDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const payoutDetails = await prisma.organizerPayoutDetails.findUnique({
      where: { userId: organizerId },
    });

    res.json({
      success: true,
      data: {
        payoutDetails: sanitizePayoutDetails(payoutDetails),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateOrganizerPayoutDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;
    const input = payoutDetailsInputSchema.parse(req.body);

    const saved = await saveOrganizerPayoutDetails(prisma, organizerId, input);

    res.json({
      success: true,
      data: {
        payoutDetails: sanitizePayoutDetails(saved),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function checkInTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  const lockId = randomUUID();
  let idemRedisKey: string | null = null;
  let redisClient: ReturnType<typeof getRedisClient> | null = null;

  try {
    const rawToken = req.body.token;
    const eventIdOrSlug = req.body.eventId;

    // Header & body key extraction and strict conflict validation
    const h1 = req.headers['idempotency-key'];
    const h2 = req.headers['x-idempotency-key'];
    const b1 = req.body?.idempotencyKey;

    // Reject empty string or whitespace-only keys
    if (typeof h1 === 'string' && h1.trim().length === 0) {
      throw new BadRequestError('Idempotency key cannot be empty or whitespace.', 'INVALID_IDEMPOTENCY_KEY');
    }
    if (typeof h2 === 'string' && h2.trim().length === 0) {
      throw new BadRequestError('Idempotency key cannot be empty or whitespace.', 'INVALID_IDEMPOTENCY_KEY');
    }
    if (typeof b1 === 'string' && b1.trim().length === 0) {
      throw new BadRequestError('Idempotency key cannot be empty or whitespace.', 'INVALID_IDEMPOTENCY_KEY');
    }

    const rawKeys = [
      typeof h1 === 'string' && h1.trim() ? h1.trim() : null,
      typeof h2 === 'string' && h2.trim() ? h2.trim() : null,
      typeof b1 === 'string' && b1.trim() ? b1.trim() : null,
    ].filter((k): k is string => k !== null);

    const uniqueKeys = Array.from(new Set(rawKeys));
    if (uniqueKeys.length > 1) {
      throw new BadRequestError(
        'Conflicting idempotency keys provided in request headers and body.',
        'IDEMPOTENCY_KEY_CONFLICT'
      );
    }

    const idempotencyKey = uniqueKeys[0] || undefined;
    if (idempotencyKey) {
      if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        throw new BadRequestError(
          'Idempotency key must be between 8 and 128 characters.',
          'INVALID_IDEMPOTENCY_KEY'
        );
      }
      const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9_\-.:]{8,128}$/;
      if (!IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
        throw new BadRequestError(
          'Idempotency key contains invalid characters. Only alphanumeric, underscore, hyphen, colon, and period are permitted.',
          'INVALID_IDEMPOTENCY_KEY'
        );
      }
    }

    if (!rawToken || typeof rawToken !== 'string') {
      throw new BadRequestError('Ticket token is required');
    }

    const token = rawToken.trim();
    const scannerUserId = req.user!.userId;
    const isAdmin = req.user!.role === 'ADMIN';
    const isOrganizerRole = req.user!.role === 'ORGANIZER' || isAdmin;

    if (!isOrganizerRole) {
      let hasStaffAccess = false;
      try {
        if (eventIdOrSlug && eventIdOrSlug !== 'all' && eventIdOrSlug !== 'all_events') {
          const staffRecord = await prisma.eventStaff.findFirst({
            where: {
              userId: scannerUserId,
              status: 'ACTIVE',
              event: {
                OR: [{ id: eventIdOrSlug }, { slug: eventIdOrSlug }],
              },
            },
            select: { id: true },
          });
          hasStaffAccess = !!staffRecord;
        } else {
          const anyStaffRecord = await prisma.eventStaff.findFirst({
            where: {
              userId: scannerUserId,
              status: 'ACTIVE',
            },
            select: { id: true },
          });
          hasStaffAccess = !!anyStaffRecord;
        }
      } catch (err: any) {
        if (err?.code !== 'P2021') throw err;
      }

      if (!hasStaffAccess) {
        throw new ForbiddenError('You do not have permission to check in attendees for this event');
      }
    }

    const assertIdempotencyReplayAuthorized = async (record: any): Promise<void> => {
      if (isAdmin) {
        return;
      }

      // Post-deployment organizer-owned check-in replays explicitly carry authorizedVia === 'OWNER'.
      // Never trust missing legacy metadata as proof of authorization (S2R-04).
      if (isOrganizerRole && record?.authorizedVia === 'OWNER') {
        return;
      }

      let targetEventId: string | null =
        typeof record?.resolvedEventId === 'string' && record.resolvedEventId.trim()
          ? record.resolvedEventId.trim()
          : null;

      if (!targetEventId && typeof record?.ticketId === 'string' && record.ticketId.trim()) {
        const ticketRow = await prisma.ticket.findUnique({
          where: { id: record.ticketId.trim() },
          select: { eventId: true },
        });
        targetEventId = ticketRow?.eventId ?? null;
      }

      if (!targetEventId && typeof record?.eventId === 'string' && record.eventId.trim()) {
        const ev = await prisma.event.findFirst({
          where: { OR: [{ id: record.eventId.trim() }, { slug: record.eventId.trim() }] },
          select: { id: true },
        });
        targetEventId = ev?.id ?? null;
      }

      if (!targetEventId) {
        throw new ForbiddenError('You do not have permission to check in attendees for this event');
      }

      // For legacy ORGANIZER records lacking authorizedVia, allow replay if the organizer
      // currently owns the target event; otherwise require an ACTIVE EventStaff assignment.
      if (isOrganizerRole && !record?.authorizedVia) {
        const ownedEvent = await prisma.event.findFirst({
          where: {
            id: targetEventId,
            organizerId: scannerUserId,
          },
          select: { id: true },
        });
        if (ownedEvent) {
          return;
        }
      }

      const staffMember = await prisma.eventStaff.findUnique({
        where: {
          eventId_userId: {
            eventId: targetEventId,
            userId: scannerUserId,
          },
        },
        select: { status: true },
      });

      if (!staffMember || staffMember.status !== 'ACTIVE') {
        throw new ForbiddenError('You do not have permission to check in attendees for this event');
      }
    };

    // Safe check-in retry idempotency via Redis
    if (idempotencyKey) {
      redisClient = getRedisClient();
      idemRedisKey = `checkin_idem:${scannerUserId}:${idempotencyKey}`;

      const existingRaw = await redisClient.get(idemRedisKey);
      if (existingRaw) {
        const record = JSON.parse(existingRaw);

        // Strict event match: both must be identical normalized strings
        const currentEventNormalized = (eventIdOrSlug || '').trim();
        const recordedEventNormalized = (record.eventId || '').trim();
        if (currentEventNormalized !== recordedEventNormalized) {
          throw new BadRequestError(
            'Idempotency key was previously used with a different ticket or event.',
            'IDEMPOTENCY_KEY_MISMATCH'
          );
        }

        // Token match: case-insensitive and prefix-insensitive
        const normCurrent = token.toLowerCase();
        const normRecorded = (record.token || '').toLowerCase();
        const normCurrentPrefixed = normCurrent.startsWith('tkt_sec_') ? normCurrent : `tkt_sec_${normCurrent}`;
        const normRecordedPrefixed = normRecorded.startsWith('tkt_sec_') ? normRecorded : `tkt_sec_${normRecorded}`;

        if (normCurrentPrefixed !== normRecordedPrefixed) {
          throw new BadRequestError(
            'Idempotency key was previously used with a different ticket or event.',
            'IDEMPOTENCY_KEY_MISMATCH'
          );
        }

        if (record.status === 'COMPLETED') {
          await assertIdempotencyReplayAuthorized(record);
          res.status(record.responseStatus).json(record.responseBody);
          return;
        }

        if (record.status === 'PENDING') {
          let waitCount = 0;
          while (waitCount < 60) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            const pollRaw = await redisClient.get(idemRedisKey);
            if (pollRaw) {
              const pollRecord = JSON.parse(pollRaw);
              if (pollRecord.status === 'COMPLETED') {
                await assertIdempotencyReplayAuthorized(pollRecord);
                res.status(pollRecord.responseStatus).json(pollRecord.responseBody);
                return;
              }
            } else {
              break;
            }
            waitCount++;
          }
          if (waitCount >= 60) {
            throw new ConflictError(
              'A check-in operation with this idempotency key is currently processing. Please retry in a moment.',
              'IDEMPOTENCY_CONCURRENT_REQUEST'
            );
          }
        }
      }

      const acquiredLock = await redisClient.setNxPx(
        idemRedisKey,
        JSON.stringify({
          lockId,
          scannerUserId,
          token,
          eventId: (eventIdOrSlug || '').trim(),
          status: 'PENDING',
          createdAt: Date.now(),
        }),
        25_000
      );

      if (!acquiredLock) {
        let waitCount = 0;
        while (waitCount < 60) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const pollRaw = await redisClient.get(idemRedisKey);
          if (pollRaw) {
            const pollRecord = JSON.parse(pollRaw);
            if (pollRecord.status === 'COMPLETED') {
              await assertIdempotencyReplayAuthorized(pollRecord);
              res.status(pollRecord.responseStatus).json(pollRecord.responseBody);
              return;
            }
          }
          waitCount++;
        }
        throw new ConflictError(
          'A check-in operation with this idempotency key is currently processing. Please retry in a moment.',
          'IDEMPOTENCY_CONCURRENT_REQUEST'
        );
      }
    }

    const ticketInclude = {
      event: {
        select: {
          id: true,
          slug: true,
          title: true,
          organizerId: true,
          timezone: true,
          startAt: true,
          endAt: true,
        },
      },
      ticketTier: {
        select: {
          name: true,
          validityStartAt: true,
          validityEndAt: true,
        },
      },
      order: {
        select: {
          orderNumber: true,
          status: true,
          customerName: true,
          customerEmail: true,
        },
      },
      checkedInByUser: {
        select: {
          name: true,
          email: true,
        },
      },
    };

    // 1. Find ticket by ticketToken (fast index match)
    let ticket = await prisma.ticket.findUnique({
      where: { ticketToken: token },
      include: ticketInclude,
    });

    // 1b. Fallback: if user manually entered token without "tkt_sec_" prefix
    if (!ticket && !token.startsWith('tkt_')) {
      ticket = await prisma.ticket.findUnique({
        where: { ticketToken: `tkt_sec_${token}` },
        include: ticketInclude,
      });
    }

    // 1c. Fallback: case-insensitive match for manual entry casing mistakes
    if (!ticket) {
      ticket = await prisma.ticket.findFirst({
        where: {
          OR: [
            { ticketToken: { equals: token, mode: 'insensitive' } },
            { ticketToken: { equals: `tkt_sec_${token}`, mode: 'insensitive' } },
          ],
        },
        include: ticketInclude,
      });
    }

    // Masked token for non-sensitive audit logging
    const actualToken = ticket?.ticketToken || token;
    const maskedToken = actualToken.length > 10
      ? `${actualToken.slice(0, 7)}...${actualToken.slice(-4)}`
      : '***';

    if (!ticket) {
      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(`[CheckIn] Rejected INVALID_TOKEN: token=${maskedToken}, user=${scannerUserId}`);

      // Fix foreign-event audit-log pollution:
      // Only write to CheckInLog if the authenticated scanner actually owns this event, is active staff, or is platform admin.
      // Never allow an unauthorized user or ordinary attendee to write check-in records against another organizer's event.
      let authorizedEvent: { id: string } | null = null;
      if (eventIdOrSlug && eventIdOrSlug !== 'all' && eventIdOrSlug !== 'all_events') {
        if (isAdmin) {
          authorizedEvent = await prisma.event.findFirst({
            where: {
              AND: [{ OR: [{ id: eventIdOrSlug }, { slug: eventIdOrSlug }] }],
            },
            select: { id: true },
          });
        } else {
          authorizedEvent = await prisma.event.findFirst({
            where: {
              AND: [
                { OR: [{ id: eventIdOrSlug }, { slug: eventIdOrSlug }] },
                { organizerId: scannerUserId },
              ],
            },
            select: { id: true },
          });

          if (!authorizedEvent) {
            try {
              const staffAssignment = await prisma.eventStaff.findFirst({
                where: {
                  userId: scannerUserId,
                  status: EventStaffStatus.ACTIVE,
                  event: {
                    OR: [{ id: eventIdOrSlug }, { slug: eventIdOrSlug }],
                  },
                },
                select: { eventId: true },
              });
              if (staffAssignment) {
                authorizedEvent = { id: staffAssignment.eventId };
              }
            } catch (err: any) {
              if (err?.code !== 'P2021') throw err;
            }
          }
        }
      }

      if (authorizedEvent) {
        await prisma.checkInLog.create({
          data: {
            eventId: authorizedEvent.id,
            scannedToken: token,
            scannedByUserId: scannerUserId,
            result: 'INVALID_TOKEN',
            notes: 'Scanned credential does not exist in system',
          },
        });
      }

      res.status(404).json({
        success: false,
        error: {
          message: 'Invalid ticket token. No ticket found with this credential.',
          statusCode: 404,
          code: 'INVALID_TOKEN',
        },
        data: {
          result: 'INVALID_TOKEN',
          message: 'Invalid ticket token. No ticket found with this credential.',
        },
      });
      return;
    }

    // 3. Authorization check: organizer must own the event, or user is admin, or active staff
    const isOwner = ticket.event.organizerId === scannerUserId;
    let isStaff = false;

    if (!isAdmin && !isOwner) {
      let staffMember: { status: string } | null = null;
      try {
        staffMember = await prisma.eventStaff.findUnique({
          where: {
            eventId_userId: {
              eventId: ticket.eventId,
              userId: scannerUserId,
            },
          },
          select: { status: true },
        });
      } catch (err: any) {
        if (err?.code !== 'P2021') throw err;
      }

      if (!staffMember || staffMember.status !== 'ACTIVE') {
        if (idemRedisKey && redisClient) {
          await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
        }
        console.warn(`[CheckIn] Rejected FORBIDDEN: user=${scannerUserId} does not own or have staff access to event ${ticket.event.id}`);
        throw new ForbiddenError('You do not have permission to check in attendees for this event');
      }
      isStaff = true;
    }

    // 4. Check if ticket is for the scanned event (if gate specified and not "all")
    if (eventIdOrSlug && eventIdOrSlug !== 'all' && eventIdOrSlug !== 'all_events') {
      const isTargetEvent =
        ticket.eventId === eventIdOrSlug || ticket.event.slug === eventIdOrSlug;

      if (!isTargetEvent) {
        if (idemRedisKey && redisClient) {
          await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
        }
        console.warn(
          `[CheckIn] Rejected WRONG_EVENT: token=${maskedToken}, ticketEvent="${ticket.event.title}" (${ticket.event.slug}), gate="${eventIdOrSlug}"`
        );
        await prisma.checkInLog.create({
          data: {
            ticketId: ticket.id,
            eventId: ticket.eventId,
            scannedToken: ticket.ticketToken,
            scannedByUserId: scannerUserId,
            result: 'WRONG_EVENT',
            notes: `Ticket belongs to event '${ticket.event.title}', not the selected gate.`,
          },
        });

        res.status(400).json({
          success: false,
          error: {
            message: `Ticket belongs to "${ticket.event.title}", not this event gate.`,
            statusCode: 400,
            code: 'WRONG_EVENT',
            details: {
              eventTitle: ticket.event.title,
              eventId: ticket.eventId,
              eventSlug: ticket.event.slug,
            },
          },
          data: {
            result: 'WRONG_EVENT',
            message: `Ticket belongs to "${ticket.event.title}", not this event gate.`,
            ticket: {
              id: ticket.id,
              attendeeName: ticket.attendeeName,
              tierName: ticket.ticketTier.name,
              eventTitle: ticket.event.title,
              eventId: ticket.eventId,
              eventSlug: ticket.event.slug,
            },
          },
        });
        return;
      }
    }

    if (ticket.status === 'CANCELLED' || ticket.order.status === 'CANCELLED' || ticket.order.status === 'REFUNDED') {
      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(`[CheckIn] Rejected CANCELLED_TICKET: token=${maskedToken}, ticketStatus=${ticket.status}, orderStatus=${ticket.order.status}`);
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: ticket.ticketToken,
          scannedByUserId: scannerUserId,
          result: 'CANCELLED_TICKET',
          notes: 'Ticket or parent order was cancelled/refunded.',
        },
      });

      res.status(400).json({
        success: false,
        error: {
          message: 'This ticket has been cancelled or refunded and is not valid for entry.',
          statusCode: 400,
          code: 'CANCELLED_TICKET',
        },
        data: {
          result: 'CANCELLED_TICKET',
          message: 'This ticket has been cancelled or refunded and is not valid for entry.',
        },
      });
      return;
    }

    if (ticket.status === 'CHECKED_IN') {
      // Recovery of committed check-in if this exact scanner committed with this exact idempotencyKey:
      if (idempotencyKey && ticket.checkedInByUserId === scannerUserId) {
        const matchingSuccessLog = await prisma.checkInLog.findFirst({
          where: {
            ticketId: ticket.id,
            scannedByUserId: scannerUserId,
            result: 'SUCCESS',
            notes: `idem:${idempotencyKey}`,
          },
          orderBy: { createdAt: 'desc' },
        });

        if (matchingSuccessLog) {
          const totalCheckedIn = await prisma.ticket.count({
            where: {
              eventId: ticket.eventId,
              status: 'CHECKED_IN',
            },
          });

          const recoveredPayload = {
            success: true,
            data: {
              result: 'SUCCESS' as const,
              message: 'Valid admission pass verified.',
              ticket: {
                id: ticket.id,
                attendeeName: ticket.attendeeName,
                attendeeEmail: ticket.attendeeEmail,
                tierName: ticket.ticketTier.name,
                orderNumber: ticket.order.orderNumber,
                checkedInAt: ticket.checkedInAt || matchingSuccessLog.createdAt,
                eventTitle: ticket.event.title,
                validityStartAt: ticket.ticketTier.validityStartAt,
                validityEndAt: ticket.ticketTier.validityEndAt,
              },
              totalCheckedIn,
            },
          };

          if (idemRedisKey && redisClient) {
            await redisClient.completeIdempotencyLock(
              idemRedisKey,
              lockId,
              JSON.stringify({
                scannerUserId,
                token,
                eventId: (eventIdOrSlug || '').trim(),
                resolvedEventId: ticket.eventId,
                authorizedVia: isStaff ? 'STAFF' : isOwner ? 'OWNER' : 'ADMIN',
                ticketId: ticket.id,
                status: 'COMPLETED',
                responseStatus: 200,
                responseBody: recoveredPayload,
                createdAt: Date.now(),
              }),
              86_400_000
            );
          }

          res.json(recoveredPayload);
          return;
        }
      }

      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(`[CheckIn] Rejected ALREADY_CHECKED_IN: token=${maskedToken}, checkedInAt=${ticket.checkedInAt}`);
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: ticket.ticketToken,
          scannedByUserId: scannerUserId,
          result: 'ALREADY_CHECKED_IN',
          notes: `Attempted re-entry. Originally checked in at ${ticket.checkedInAt?.toISOString()}`,
        },
      });

      res.status(409).json({
        success: false,
        error: {
          message: 'This ticket has already been used and cannot be re-admitted.',
          statusCode: 409,
          code: 'ALREADY_CHECKED_IN',
        },
        data: {
          result: 'ALREADY_CHECKED_IN',
          message: 'This ticket has already been used and cannot be re-admitted.',
          ticket: {
            id: ticket.id,
            attendeeName: ticket.attendeeName,
            tierName: ticket.ticketTier.name,
            orderNumber: ticket.order.orderNumber,
            checkedInAt: ticket.checkedInAt,
            checkedBy: ticket.checkedInByUser?.name || 'Gate Staff',
          },
        },
      });
      return;
    }

    if (ticket.order.status !== 'COMPLETED') {
      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(`[CheckIn] Rejected UNPAID_ORDER: token=${maskedToken}, orderStatus=${ticket.order.status}`);
      res.status(400).json({
        success: false,
        error: {
          message: 'Order is not completed or paid. Admission denied.',
          statusCode: 400,
          code: 'UNPAID_ORDER',
        },
        data: {
          result: 'UNPAID_ORDER',
          message: 'Order is not completed or paid. Admission denied.',
        },
      });
      return;
    }

    const now = new Date();
    const validityStart = ticket.ticketTier.validityStartAt;
    const validityEnd = ticket.ticketTier.validityEndAt;

    if (validityStart && now < validityStart) {
      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(
        `[CheckIn] Rejected TICKET_NOT_YET_VALID: token=${maskedToken}, validityStart=${validityStart.toISOString()}, now=${now.toISOString()}`
      );
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: ticket.ticketToken,
          scannedByUserId: scannerUserId,
          result: 'TICKET_NOT_YET_VALID',
          notes: `Ticket scanned before validity window begins (${validityStart.toISOString()})`,
        },
      });

      const formattedStart = (() => {
        try {
          return new Intl.DateTimeFormat('en-US', {
            timeZone: ticket.event.timezone || 'UTC',
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(validityStart);
        } catch {
          return validityStart.toISOString();
        }
      })();

      res.status(400).json({
        success: false,
        error: {
          message: `Ticket is not yet valid for entry. Admission begins on ${formattedStart}.`,
          statusCode: 400,
          code: 'TICKET_NOT_YET_VALID',
        },
        data: {
          result: 'TICKET_NOT_YET_VALID',
          message: `Ticket is not yet valid for entry. Admission begins on ${formattedStart}.`,
          ticket: {
            id: ticket.id,
            attendeeName: ticket.attendeeName,
            tierName: ticket.ticketTier.name,
            validityStartAt: validityStart,
            validityEndAt: validityEnd,
          },
        },
      });
      return;
    }

    if (validityEnd && now > validityEnd) {
      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(
        `[CheckIn] Rejected TICKET_EXPIRED: token=${maskedToken}, validityEnd=${validityEnd.toISOString()}, now=${now.toISOString()}`
      );
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: ticket.ticketToken,
          scannedByUserId: scannerUserId,
          result: 'TICKET_EXPIRED',
          notes: `Ticket scanned after validity window expired (${validityEnd.toISOString()})`,
        },
      });

      const formattedEnd = (() => {
        try {
          return new Intl.DateTimeFormat('en-US', {
            timeZone: ticket.event.timezone || 'UTC',
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(validityEnd);
        } catch {
          return validityEnd.toISOString();
        }
      })();

      res.status(400).json({
        success: false,
        error: {
          message: `Ticket validity expired on ${formattedEnd}. Entry is no longer permitted.`,
          statusCode: 400,
          code: 'TICKET_EXPIRED',
        },
        data: {
          result: 'TICKET_EXPIRED',
          message: `Ticket validity expired on ${formattedEnd}. Entry is no longer permitted.`,
          ticket: {
            id: ticket.id,
            attendeeName: ticket.attendeeName,
            tierName: ticket.ticketTier.name,
            validityStartAt: validityStart,
            validityEndAt: validityEnd,
          },
        },
      });
      return;
    }

    // 8. Atomic Check-in with race condition protection & staff row lock
    let checkInTime = new Date();
    let updateResult: { count: number };

    if (isStaff) {
      updateResult = await prisma.$transaction(async (tx) => {
        const staffRows = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM "EventStaff"
          WHERE "eventId" = ${ticket.eventId} AND "userId" = ${scannerUserId}
          FOR SHARE
        `;

        if (!staffRows || staffRows.length === 0 || staffRows[0].status !== 'ACTIVE') {
          throw new ForbiddenError(
            'Your staff scanning access for this event has been revoked or is inactive.'
          );
        }

        checkInTime = new Date();
        const res = await tx.ticket.updateMany({
          where: {
            id: ticket.id,
            status: 'ISSUED',
          },
          data: {
            status: 'CHECKED_IN',
            checkedInAt: checkInTime,
            checkedInByUserId: scannerUserId,
          },
        });

        if (res.count > 0) {
          await tx.checkInLog.create({
            data: {
              ticketId: ticket.id,
              eventId: ticket.eventId,
              scannedToken: ticket.ticketToken,
              scannedByUserId: scannerUserId,
              result: 'SUCCESS',
              notes: idempotencyKey ? `idem:${idempotencyKey}` : undefined,
            },
          });
        }

        return res;
      });
    } else {
      checkInTime = new Date();
      updateResult = await prisma.ticket.updateMany({
        where: {
          id: ticket.id,
          status: 'ISSUED',
        },
        data: {
          status: 'CHECKED_IN',
          checkedInAt: checkInTime,
          checkedInByUserId: scannerUserId,
        },
      });

      if (updateResult.count > 0) {
        await prisma.checkInLog.create({
          data: {
            ticketId: ticket.id,
            eventId: ticket.eventId,
            scannedToken: ticket.ticketToken,
            scannedByUserId: scannerUserId,
            result: 'SUCCESS',
            notes: idempotencyKey ? `idem:${idempotencyKey}` : undefined,
          },
        });
      }
    }

    if (updateResult.count === 0) {
      if (idemRedisKey && redisClient) {
        await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
      }
      console.warn(`[CheckIn] Concurrent duplicate check-in prevented: token=${maskedToken}`);
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: ticket.ticketToken,
          scannedByUserId: scannerUserId,
          result: 'ALREADY_CHECKED_IN',
          notes: 'Attempted concurrent re-entry. Ticket was already checked in.',
        },
      });

      res.status(409).json({
        success: false,
        error: {
          message: 'This ticket has already been used and cannot be re-admitted.',
          statusCode: 409,
          code: 'ALREADY_CHECKED_IN',
        },
        data: {
          result: 'ALREADY_CHECKED_IN',
          message: 'This ticket has already been used and cannot be re-admitted.',
          ticket: {
            id: ticket.id,
            attendeeName: ticket.attendeeName,
            tierName: ticket.ticketTier.name,
            orderNumber: ticket.order.orderNumber,
          },
        },
      });
      return;
    }

    const totalCheckedIn = await prisma.ticket.count({
      where: {
        eventId: ticket.eventId,
        status: 'CHECKED_IN',
      },
    });

    console.log(`[CheckIn] SUCCESS: token=${maskedToken}, attendee="${ticket.attendeeName}", event="${ticket.event.title}"`);

    const responsePayload = {
      success: true,
      data: {
        result: 'SUCCESS',
        message: 'Valid admission pass verified.',
        ticket: {
          id: ticket.id,
          attendeeName: ticket.attendeeName,
          attendeeEmail: ticket.attendeeEmail,
          tierName: ticket.ticketTier.name,
          orderNumber: ticket.order.orderNumber,
          checkedInAt: checkInTime,
          eventTitle: ticket.event.title,
          validityStartAt: ticket.ticketTier.validityStartAt,
          validityEndAt: ticket.ticketTier.validityEndAt,
        },
        totalCheckedIn,
      },
    };

    if (idemRedisKey && redisClient) {
      await redisClient.completeIdempotencyLock(
        idemRedisKey,
        lockId,
        JSON.stringify({
          scannerUserId,
          token,
          eventId: (eventIdOrSlug || '').trim(),
          resolvedEventId: ticket.eventId,
          authorizedVia: isStaff ? 'STAFF' : isOwner ? 'OWNER' : 'ADMIN',
          ticketId: ticket.id,
          status: 'COMPLETED',
          responseStatus: 200,
          responseBody: responsePayload,
          createdAt: Date.now(),
        }),
        86_400_000
      );
    }

    res.json(responsePayload);
  } catch (error) {
    if (idemRedisKey && redisClient) {
      await redisClient.delLockIfMatches(idemRedisKey, lockId).catch(() => {});
    }
    next(error);
  }
}

export async function getOrganizerEarningsPreview(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = earningsPreviewInputSchema.parse(req.body);
    const result = calculateCombinedEarnings(input.tiers);
    res.json({
      success: true,
      data: {
        preview: result,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getOrganizerOrders(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required to access organizer orders');
    }

    const isAdmin = req.user.role === Role.ADMIN;
    const isOrganizerRole = req.user.role === Role.ORGANIZER;
    const organizerId = req.user.userId;

    const query = organizerOrdersQuerySchema.parse(req.query);
    const { status: statuses, eventId, search, page, limit, sortBy, sortOrder } = query;

    let targetEventId: string | undefined = undefined;
    let isTargetEventOwner = false;
    let isAuthorizedEventAdminForTarget = false;

    if (eventId) {
      const event = await prisma.event.findFirst({
        where: {
          OR: [{ id: eventId }, { slug: eventId }],
        },
        select: { id: true, organizerId: true },
      });

      if (!event) {
        throw new NotFoundError('Event not found');
      }

      if (event.organizerId === organizerId) {
        isTargetEventOwner = true;
      } else if (!isAdmin) {
        try {
          await resolveEventAuthorization(event.id, req.user, 'canViewOrders');
          isAuthorizedEventAdminForTarget = true;
        } catch (err) {
          if (err instanceof ForbiddenError) {
            throw new ForbiddenError(
              `You do not have permission to view orders for this event. ${err.message}`
            );
          }
          throw err;
        }
      }

      targetEventId = event.id;
    }

    const andConditions: Prisma.OrderWhereInput[] = [];

    if (!isAdmin) {
      if (targetEventId) {
        if (isTargetEventOwner) {
          andConditions.push({ event: { organizerId } });
        } else if (!isAuthorizedEventAdminForTarget) {
          throw new ForbiddenError('You do not have permission to view orders for this event');
        }
        andConditions.push({ eventId: targetEventId });
      } else {
        let authorizedAdminEventIds: string[] = [];
        if (prisma.eventTeamMember && typeof prisma.eventTeamMember.findMany === 'function') {
          try {
            const memberships = await prisma.eventTeamMember.findMany({
              where: {
                userId: organizerId,
                role: 'ADMIN',
                status: 'ACTIVE',
              },
              select: {
                eventId: true,
                role: true,
                permissions: true,
              },
            });
            if (Array.isArray(memberships)) {
              authorizedAdminEventIds = memberships
                .filter((m) => hasEventPermission(m, 'canViewOrders'))
                .map((m) => m.eventId);
            }
          } catch {
            authorizedAdminEventIds = [];
          }
        }

        if (authorizedAdminEventIds.length === 0) {
          if (!isOrganizerRole) {
            throw new ForbiddenError(
              `Access denied. Role ${req.user.role} is not permitted for this action.`
            );
          }
          andConditions.push({ event: { organizerId } });
        } else if (isOrganizerRole) {
          andConditions.push({
            OR: [
              { event: { organizerId } },
              { eventId: { in: authorizedAdminEventIds } },
            ],
          });
        } else {
          andConditions.push({ eventId: { in: authorizedAdminEventIds } });
        }
      }
    } else if (targetEventId) {
      andConditions.push({ eventId: targetEventId });
    }

    if (statuses && statuses.length > 0) {
      if (statuses.length === 1) {
        andConditions.push({ status: statuses[0] });
      } else {
        andConditions.push({ status: { in: statuses } });
      }
    }

    if (search) {
      andConditions.push({
        OR: [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
          { customerPhone: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.OrderWhereInput = andConditions.length > 0 ? { AND: andConditions } : {};
    const skip = (page - 1) * limit;

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ [sortBy]: sortOrder }, { id: 'desc' }],
        select: {
          id: true,
          orderNumber: true,
          status: true,
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          totalInCents: true,
          currency: true,
          platformFeeInCents: true,
          organizerNetInCents: true,
          paymentProvider: true,
          paymentReference: true,
          createdAt: true,
          updatedAt: true,
          eventId: true,
          event: {
            select: {
              id: true,
              title: true,
              slug: true,
              startAt: true,
              endAt: true,
              venueName: true,
              city: true,
              country: true,
            },
          },
          items: {
            select: {
              id: true,
              ticketTierId: true,
              quantity: true,
              unitPriceInCents: true,
              subtotalInCents: true,
              ticketTier: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          _count: {
            select: { tickets: true },
          },
        },
      }),
    ]);

    const formattedOrders = orders.map((order) => {
      const ticketQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
      const paymentStatus = order.status === OrderStatus.COMPLETED ? 'PAID' : order.status;

      return {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        totalInCents: order.totalInCents,
        currency: order.currency,
        platformFeeInCents: order.platformFeeInCents,
        organizerNetInCents: order.organizerNetInCents,
        paymentProvider: order.paymentProvider,
        paymentReference: isAdmin ? order.paymentReference : undefined,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        eventId: order.eventId,
        event: order.event,
        items: order.items.map((item) => ({
          id: item.id,
          ticketTierId: item.ticketTierId,
          tierName: item.ticketTier.name,
          quantity: item.quantity,
          unitPriceInCents: item.unitPriceInCents,
          subtotalInCents: item.subtotalInCents,
        })),
        ticketQuantity,
        ticketsCount: order._count.tickets,
      };
    });

    const totalPages = Math.ceil(total / limit);
    const pagination = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };

    res.json({
      success: true,
      data: {
        orders: formattedOrders,
        pagination,
      },
    });
  } catch (error) {
    next(error);
  }
}




