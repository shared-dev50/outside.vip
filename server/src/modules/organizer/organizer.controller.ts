import { Request, Response, NextFunction } from 'express';
import { EventStatus, TicketTierStatus, OrderStatus, TicketStatus, RecurrenceFrequency } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { createEventSchema, updateEventSchema, payoutDetailsInputSchema, PayoutDetailsInput, earningsPreviewInputSchema } from './organizer.schema.js';
import { calculateCombinedEarnings } from '../checkout/checkout.financials.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../utils/errors.js';
import { calculateOccurrences, formatOccurrenceSlugSuffix } from '../events/recurrence.service.js';
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

export async function getDashboardStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizerId = req.user!.userId;

    // Count events by status
    const [totalEvents, publishedEvents, draftEvents] = await Promise.all([
      prisma.event.count({ where: { organizerId } }),
      prisma.event.count({ where: { organizerId, status: EventStatus.PUBLISHED } }),
      prisma.event.count({ where: { organizerId, status: EventStatus.DRAFT } }),
    ]);

    // Count tickets sold for organizer's events
    const ticketsSoldCount = await prisma.ticket.count({
      where: {
        event: { organizerId },
        status: { in: [TicketStatus.ISSUED, TicketStatus.CHECKED_IN] },
      },
    });

    // Sum actual gross revenue from COMPLETED orders for organizer's events
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

    const events = await prisma.event.findMany({
      where: { organizerId },
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

    const enhanced = events.map((event) => {
      const totalCapacity = event.ticketTiers.reduce((acc, t) => acc + t.totalCapacity, 0);
      const ticketsSold = event.ticketTiers.reduce((acc, t) => acc + t.soldQuantity, 0);
      const revenueInCents = event.orders.reduce((acc, o) => acc + o.totalInCents, 0);

      // Clean orders array and sensitive fields before returning
      const { orders: _, passwordHash: __, ...rest } = event;
      return {
        ...rest,
        totalCapacity,
        ticketsSold,
        revenueInCents,
        revenueFormatted: `$${(revenueInCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      };
    });

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
      throw new ForbiddenError('You do not have permission to view or edit this event');
    }

    const effectivePayout = event.payoutDetails || event.organizer?.payoutDetails || null;
    const sanitizedPayout = sanitizePayoutDetails(effectivePayout);
    const sanitizedOrganizer = {
      ...event.organizer,
      payoutDetails: sanitizePayoutDetails(event.organizer?.payoutDetails),
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
              venueName: input.venueName,
              venueAddress: input.venueAddress,
              city: input.city,
              country: input.country,
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
          venueName: input.venueName,
          venueAddress: input.venueAddress,
          city: input.city,
          country: input.country,
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
    const input = updateEventSchema.parse(req.body);

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

    if (existingEvent.organizerId !== organizerId && req.user!.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have permission to edit this event');
    }

    // Preserve existing legacy Base64 if untouched, but reject newly uploaded Base64 strings
    if (input.coverImageUrl && input.coverImageUrl.startsWith('data:image/')) {
      if (input.coverImageUrl !== existingEvent.coverImageUrl) {
        throw new BadRequestError(
          'Base64 image data cannot be newly uploaded. Please use the Cloudinary upload flow.'
        );
      }
    }

    // Validate date order if both or either updated
    const startAtDate = input.startAt ? new Date(input.startAt) : existingEvent.startAt;
    const endAtDate = input.endAt ? new Date(input.endAt) : existingEvent.endAt;
    if (endAtDate.getTime() <= startAtDate.getTime()) {
      throw new BadRequestError('Event end time must be after the start time');
    }

    // YouTube URL normalization & validation
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

    // Password protection handling
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

    // Limits
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

    const updatedEvent = await prisma.$transaction(async (tx) => {
      let payoutDetailsId = existingEvent.payoutDetailsId;
      if (input.payoutDetails) {
        const savedPayout = await saveOrganizerPayoutDetails(tx, organizerId, input.payoutDetails);
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
              ...(input.venueName !== undefined && { venueName: input.venueName }),
              ...(input.venueAddress !== undefined && { venueAddress: input.venueAddress }),
              ...(input.city !== undefined && { city: input.city }),
              ...(input.country !== undefined && { country: input.country }),
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
                  status: tier.status,
                  waitlistEnabled: tier.waitlistEnabled ?? false,
                })),
              });
            }
          }
        }
      }

      // 1. Update event details
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
          ...(input.venueName !== undefined && { venueName: input.venueName }),
          ...(input.venueAddress !== undefined && { venueAddress: input.venueAddress }),
          ...(input.city !== undefined && { city: input.city }),
          ...(input.country !== undefined && { country: input.country }),
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
          ...(payoutDetailsId ? { payoutDetailsId } : {}),
        },
      });

      // 2. Manage gallery images if provided
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

      // 3. Manage features if provided
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

      // 4. Manage ticket tiers if provided
      if (input.ticketTiers) {
        const incomingTierIds = new Set(input.ticketTiers.filter((t) => t.id).map((t) => t.id));

        // Check for tiers removed in this update
        for (const existingTier of existingEvent.ticketTiers) {
          if (!incomingTierIds.has(existingTier.id)) {
            if (existingTier.soldQuantity > 0) {
              // Preserve historical sales! Deactivate instead of deleting
              await tx.ticketTier.update({
                where: { id: existingTier.id },
                data: { status: TicketTierStatus.HIDDEN },
              });
            } else {
              // Safe to delete unused tier
              await tx.ticketTier.delete({ where: { id: existingTier.id } });
            }
          }
        }

        // Upsert incoming tiers
        for (const tier of input.ticketTiers) {
          if (tier.id) {
            // Update existing tier
            await tx.ticketTier.update({
              where: { id: tier.id },
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
                status: tier.status,
                ...(tier.waitlistEnabled !== undefined && { waitlistEnabled: tier.waitlistEnabled }),
              },
            });
          } else {
            // Create new tier
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
          payoutDetails: sanitizePayoutDetails(updatedEvent?.payoutDetails),
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

    // Comprehensive Publishing Validation
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

      for (const occ of seriesOccurrences) {
        if (!occ.title || occ.title.trim().length < 2) {
          throw new BadRequestError(`Occurrence #${occ.occurrenceIndex || 1} has an invalid title`);
        }
        if (!occ.venueName) {
          throw new BadRequestError(`Occurrence #${occ.occurrenceIndex || 1} requires venue name`);
        }
        const activeTiers = occ.ticketTiers.filter(
          (t) => t.status !== TicketTierStatus.HIDDEN && t.totalCapacity > 0
        );
        if (activeTiers.length === 0) {
          throw new BadRequestError(`Occurrence #${occ.occurrenceIndex || 1} requires at least one active ticket tier`);
        }
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
      throw new ForbiddenError('You do not have permission to cancel this event');
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
      throw new ForbiddenError('You do not have permission to delete this event');
    }

    if (event.tickets.length > 0 || event.orders.length > 0) {
      throw new BadRequestError(
        'Cannot delete an event with existing orders or tickets. You can unpublish or archive it instead to preserve attendee records.'
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
  try {
    const rawToken = req.body.token;
    const eventIdOrSlug = req.body.eventId;

    if (!rawToken || typeof rawToken !== 'string') {
      throw new BadRequestError('Ticket token is required');
    }

    const token = rawToken.trim();
    const scannerUserId = req.user!.userId;
    const isAdmin = req.user!.role === 'ADMIN';

    const ticketInclude = {
      event: {
        select: {
          id: true,
          slug: true,
          title: true,
          organizerId: true,
        },
      },
      ticketTier: {
        select: {
          name: true,
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

    // 2. Token not found
    if (!ticket) {
      console.warn(`[CheckIn] Rejected INVALID_TOKEN: token=${maskedToken}, user=${scannerUserId}`);
      let targetEvent = null;
      if (eventIdOrSlug && eventIdOrSlug !== 'all' && eventIdOrSlug !== 'all_events') {
        targetEvent = await prisma.event.findFirst({
          where: {
            OR: [{ id: eventIdOrSlug }, { slug: eventIdOrSlug }],
          },
          select: { id: true },
        });
      }

      if (targetEvent) {
        await prisma.checkInLog.create({
          data: {
            eventId: targetEvent.id,
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

    // 3. Authorization check: organizer must own the event unless admin
    if (!isAdmin && ticket.event.organizerId !== scannerUserId) {
      console.warn(`[CheckIn] Rejected FORBIDDEN: user=${scannerUserId} does not own event ${ticket.event.id}`);
      throw new ForbiddenError('You do not have permission to check in attendees for this event');
    }

    // 4. Check if ticket is for the scanned event (if gate specified and not "all")
    if (eventIdOrSlug && eventIdOrSlug !== 'all' && eventIdOrSlug !== 'all_events') {
      const isTargetEvent =
        ticket.eventId === eventIdOrSlug || ticket.event.slug === eventIdOrSlug;

      if (!isTargetEvent) {
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

    // 5. Check if ticket is cancelled / refunded
    if (ticket.status === 'CANCELLED' || ticket.order.status === 'CANCELLED' || ticket.order.status === 'REFUNDED') {
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

    // 6. Check duplicate check-in
    if (ticket.status === 'CHECKED_IN') {
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

    // 7. Verify order is completed
    if (ticket.order.status !== 'COMPLETED') {
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

    // 8. Atomic Check-in with race condition protection
    const checkInTime = new Date();
    const updateResult = await prisma.ticket.updateMany({
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

    if (updateResult.count === 0) {
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

    await prisma.checkInLog.create({
      data: {
        ticketId: ticket.id,
        eventId: ticket.eventId,
        scannedToken: ticket.ticketToken,
        scannedByUserId: scannerUserId,
        result: 'SUCCESS',
      },
    });

    const totalCheckedIn = await prisma.ticket.count({
      where: {
        eventId: ticket.eventId,
        status: 'CHECKED_IN',
      },
    });

    console.log(`[CheckIn] SUCCESS: token=${maskedToken}, attendee="${ticket.attendeeName}", event="${ticket.event.title}"`);

    res.json({
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
        },
        totalCheckedIn,
      },
    });
  } catch (error) {
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



