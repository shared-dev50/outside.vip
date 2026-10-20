import { Request, Response, NextFunction } from 'express';
import { EventStatus, TicketTierStatus, OrderStatus, TicketStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { createEventSchema, updateEventSchema, payoutDetailsInputSchema, PayoutDetailsInput } from './organizer.schema.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../utils/errors.js';
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

      // Clean orders array before returning
      const { orders: _, ...rest } = event;
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
        payoutDetails: true,
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

    res.json({
      success: true,
      data: {
        event: {
          ...event,
          payoutDetails: sanitizedPayout,
          organizer: sanitizedOrganizer,
        },
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

    // Auto-generate unique slug
    const baseSlug = slugify(input.title) || 'event';
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
          payoutDetailsId,
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
            })),
          },
        },
        include: {
          ticketTiers: true,
          payoutDetails: true,
        },
      });
    });

    res.status(201).json({
      success: true,
      data: {
        event: {
          ...event,
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
      include: { ticketTiers: true },
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
          ...(payoutDetailsId ? { payoutDetailsId } : {}),
        },
      });

      // 2. Manage ticket tiers if provided
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
          payoutDetails: true,
        },
      });
    });

    // Safely delete replaced Cloudinary asset only if DB commit succeeded and no other event uses it
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

    res.json({
      success: true,
      data: {
        event: {
          ...updatedEvent,
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

    // 1. Find ticket by ticketToken
    const ticket = await prisma.ticket.findUnique({
      where: { ticketToken: token },
      include: {
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
      },
    });

    // 2. Token not found
    if (!ticket) {
      let targetEvent = null;
      if (eventIdOrSlug) {
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
        data: {
          result: 'INVALID_TOKEN',
          message: 'Invalid ticket token. No ticket found with this credential.',
        },
      });
      return;
    }

    // 3. Authorization check: organizer must own the event unless admin
    if (!isAdmin && ticket.event.organizerId !== scannerUserId) {
      throw new ForbiddenError('You do not have permission to check in attendees for this event');
    }

    // 4. Check if ticket is for the scanned event (if specified)
    if (eventIdOrSlug) {
      const isTargetEvent =
        ticket.eventId === eventIdOrSlug || ticket.event.slug === eventIdOrSlug;

      if (!isTargetEvent) {
        await prisma.checkInLog.create({
          data: {
            ticketId: ticket.id,
            eventId: ticket.eventId,
            scannedToken: token,
            scannedByUserId: scannerUserId,
            result: 'WRONG_EVENT',
            notes: `Ticket belongs to event '${ticket.event.title}', not the selected gate.`,
          },
        });

        res.status(400).json({
          success: false,
          data: {
            result: 'WRONG_EVENT',
            message: `Ticket belongs to "${ticket.event.title}", not this event gate.`,
            ticket: {
              id: ticket.id,
              attendeeName: ticket.attendeeName,
              eventTitle: ticket.event.title,
            },
          },
        });
        return;
      }
    }

    // 5. Check if ticket is cancelled / refunded
    if (ticket.status === 'CANCELLED' || ticket.order.status === 'CANCELLED' || ticket.order.status === 'REFUNDED') {
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: token,
          scannedByUserId: scannerUserId,
          result: 'CANCELLED_TICKET',
          notes: 'Ticket or parent order was cancelled/refunded.',
        },
      });

      res.status(400).json({
        success: false,
        data: {
          result: 'CANCELLED_TICKET',
          message: 'This ticket has been cancelled or refunded and is not valid for entry.',
        },
      });
      return;
    }

    // 6. Check duplicate check-in
    if (ticket.status === 'CHECKED_IN') {
      await prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: token,
          scannedByUserId: scannerUserId,
          result: 'ALREADY_CHECKED_IN',
          notes: `Attempted re-entry. Originally checked in at ${ticket.checkedInAt?.toISOString()}`,
        },
      });

      res.status(409).json({
        success: false,
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
      res.status(400).json({
        success: false,
        data: {
          result: 'UNPAID_ORDER',
          message: 'Order is not completed or paid. Admission denied.',
        },
      });
      return;
    }

    // 8. Atomic Check-in
    const [updatedTicket] = await prisma.$transaction([
      prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          status: 'CHECKED_IN',
          checkedInAt: new Date(),
          checkedInByUserId: scannerUserId,
        },
      }),
      prisma.checkInLog.create({
        data: {
          ticketId: ticket.id,
          eventId: ticket.eventId,
          scannedToken: token,
          scannedByUserId: scannerUserId,
          result: 'SUCCESS',
        },
      }),
    ]);

    const totalCheckedIn = await prisma.ticket.count({
      where: {
        eventId: ticket.eventId,
        status: 'CHECKED_IN',
      },
    });

    res.json({
      success: true,
      data: {
        result: 'SUCCESS',
        message: 'Valid admission pass verified.',
        ticket: {
          id: updatedTicket.id,
          attendeeName: ticket.attendeeName,
          attendeeEmail: ticket.attendeeEmail,
          tierName: ticket.ticketTier.name,
          orderNumber: ticket.order.orderNumber,
          checkedInAt: updatedTicket.checkedInAt,
          eventTitle: ticket.event.title,
        },
        totalCheckedIn,
      },
    });
  } catch (error) {
    next(error);
  }
}


