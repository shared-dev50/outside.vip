import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../db/prisma.js';
import {
  VISITOR_COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  ATTRIBUTION_WINDOW_MS,
} from '../modules/promotions/promotions.constants.js';
import {
  deriveCanonicalVisitorId,
  hashVisitorId,
  upsertVisitorAttribution,
  pruneExpiredPromotionClicks,
} from '../modules/promotions/promotions.service.js';

describe('Promotions & Short-Link Resolver System (Stage 1)', () => {
  const testRunId = Date.now();
  const createdUserIds: string[] = [];
  const createdEventIds: string[] = [];
  const createdTeamMemberIds: string[] = [];
  const createdPromotionLinkIds: string[] = [];

  let organizerId: string;
  let hostUserId: string;
  let adminUserId: string;
  let event1Id: string;
  let event2Id: string;
  let hostMemberId: string;
  let adminMemberId: string;

  let hostLink1Id: string;
  let campaignLink1Id: string;
  let campaignLink2Id: string;
  let draftEventId: string;
  let draftCampaignLinkId: string;

  const primaryHostSlug = `test-host-${testRunId}`;
  const historicalHostSlug = `test-host-old-${testRunId}`;
  const primaryCampaignSlug = `test-camp-${testRunId}`;
  const event2CampaignSlug = `test-evt2-${testRunId}`;
  const draftCampaignSlug = `test-draft-${testRunId}`;

  beforeAll(async () => {
    // 1. Create Organizer
    const org = await prisma.user.create({
      data: {
        email: `org_promo_${testRunId}@outside.vip`,
        name: 'Promo Organizer',
        role: 'ORGANIZER',
      },
    });
    organizerId = org.id;
    createdUserIds.push(org.id);

    // 2. Create Host User
    const hostUser = await prisma.user.create({
      data: {
        email: `host_promo_${testRunId}@outside.vip`,
        name: 'Promo Host User',
        role: 'ATTENDEE',
      },
    });
    hostUserId = hostUser.id;
    createdUserIds.push(hostUser.id);

    // 3. Create Admin User (for team role testing)
    const adminUser = await prisma.user.create({
      data: {
        email: `admin_promo_${testRunId}@outside.vip`,
        name: 'Promo Admin User',
        role: 'ATTENDEE',
      },
    });
    adminUserId = adminUser.id;
    createdUserIds.push(adminUser.id);

    // 4. Create Event 1
    const evt1 = await prisma.event.create({
      data: {
        organizerId,
        title: `Promo Fest 1 ${testRunId}`,
        description: 'Promo Fest 1 Description',
        coverImageUrl: 'https://example.com/cover1.jpg',
        venueAddress: '123 Arena Way',
        slug: `promo-fest-1-${testRunId}`,
        category: 'MUSIC',
        status: 'PUBLISHED',
        startAt: new Date(Date.now() + 86400000 * 7),
        endAt: new Date(Date.now() + 86400000 * 8),
        venueName: 'Main Arena',
        city: 'Nairobi',
        country: 'KE',
      },
    });
    event1Id = evt1.id;
    createdEventIds.push(evt1.id);

    // 5. Create Event 2 (for multi-event isolation testing)
    const evt2 = await prisma.event.create({
      data: {
        organizerId,
        title: `Promo Fest 2 ${testRunId}`,
        description: 'Promo Fest 2 Description',
        coverImageUrl: 'https://example.com/cover2.jpg',
        venueAddress: '456 Beach Blvd',
        slug: `promo-fest-2-${testRunId}`,
        category: 'FESTIVAL',
        status: 'PUBLISHED',
        startAt: new Date(Date.now() + 86400000 * 14),
        endAt: new Date(Date.now() + 86400000 * 15),
        venueName: 'Beachfront Club',
        city: 'Mombasa',
        country: 'KE',
      },
    });
    event2Id = evt2.id;
    createdEventIds.push(evt2.id);

    // 6. Create EventTeamMember for Host
    const hostMember = await prisma.eventTeamMember.create({
      data: {
        eventId: event1Id,
        userId: hostUserId,
        role: 'HOST',
        status: 'ACTIVE',
      },
    });
    hostMemberId = hostMember.id;
    createdTeamMemberIds.push(hostMember.id);

    // 7. Create EventTeamMember for Admin (for role validation test)
    const adminMember = await prisma.eventTeamMember.create({
      data: {
        eventId: event1Id,
        userId: adminUserId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    adminMemberId = adminMember.id;
    createdTeamMemberIds.push(adminMember.id);

    // 8. Create Host PromotionLink on Event 1 with primary and historical slugs
    const hostLink = await prisma.promotionLink.create({
      data: {
        eventId: event1Id,
        type: 'HOST',
        status: 'ACTIVE',
        name: 'Alex Host Link',
        hostMemberId: hostMember.id,
        createdById: organizerId,
        slugRegistry: {
          create: [
            { slug: primaryHostSlug, isPrimary: true },
            { slug: historicalHostSlug, isPrimary: false },
          ],
        },
      },
    });
    hostLink1Id = hostLink.id;
    createdPromotionLinkIds.push(hostLink.id);

    // 9. Create Campaign PromotionLink on Event 1
    const campLink1 = await prisma.promotionLink.create({
      data: {
        eventId: event1Id,
        type: 'CAMPAIGN',
        status: 'ACTIVE',
        name: 'Instagram Campaign',
        createdById: organizerId,
        slugRegistry: {
          create: [{ slug: primaryCampaignSlug, isPrimary: true }],
        },
      },
    });
    campaignLink1Id = campLink1.id;
    createdPromotionLinkIds.push(campLink1.id);

    // 10. Create Campaign PromotionLink on Event 2
    const campLink2 = await prisma.promotionLink.create({
      data: {
        eventId: event2Id,
        type: 'CAMPAIGN',
        status: 'ACTIVE',
        name: 'TikTok Campaign Event 2',
        createdById: organizerId,
        slugRegistry: {
          create: [{ slug: event2CampaignSlug, isPrimary: true }],
        },
      },
    });
    campaignLink2Id = campLink2.id;
    createdPromotionLinkIds.push(campLink2.id);

    // 11. Create Draft Event and Campaign PromotionLink (for unpublished crawler test)
    const draftEvt = await prisma.event.create({
      data: {
        organizerId,
        title: `Draft Fest ${testRunId}`,
        description: 'Super Confidential Draft Details',
        coverImageUrl: 'https://example.com/draft-poster.jpg',
        venueAddress: '789 Secret Cave',
        slug: `draft-fest-${testRunId}`,
        category: 'MUSIC',
        status: 'DRAFT',
        startAt: new Date(Date.now() + 86400000 * 30),
        endAt: new Date(Date.now() + 86400000 * 31),
        venueName: 'Secret Venue',
        city: 'Nairobi',
        country: 'KE',
      },
    });
    draftEventId = draftEvt.id;
    createdEventIds.push(draftEvt.id);

    const draftCampLink = await prisma.promotionLink.create({
      data: {
        eventId: draftEventId,
        type: 'CAMPAIGN',
        status: 'ACTIVE',
        name: 'Draft Campaign Link',
        createdById: organizerId,
        slugRegistry: {
          create: [{ slug: draftCampaignSlug, isPrimary: true }],
        },
      },
    });
    draftCampaignLinkId = draftCampLink.id;
    createdPromotionLinkIds.push(draftCampLink.id);
  });

  afterAll(async () => {
    // Clean up created records in reverse relational order
    if (createdPromotionLinkIds.length > 0) {
      await prisma.promotionClick.deleteMany({
        where: { promotionLinkId: { in: createdPromotionLinkIds } },
      });
      await prisma.promotionVisitorDay.deleteMany({
        where: { promotionLinkId: { in: createdPromotionLinkIds } },
      });
      await prisma.promotionVisitorAttribution.deleteMany({
        where: { promotionLinkId: { in: createdPromotionLinkIds } },
      });
      await prisma.promotionDailyAggregate.deleteMany({
        where: { promotionLinkId: { in: createdPromotionLinkIds } },
      });
      // Archive links first so the deferred constraint trigger permits slug deletion during teardown
      await prisma.promotionLink.updateMany({
        where: { id: { in: createdPromotionLinkIds } },
        data: { status: 'ARCHIVED' },
      });
      await prisma.promotionSlugRegistry.deleteMany({
        where: { promotionLinkId: { in: createdPromotionLinkIds } },
      });
      await prisma.promotionLink.deleteMany({
        where: { id: { in: createdPromotionLinkIds } },
      });
    }

    if (createdTeamMemberIds.length > 0) {
      await prisma.eventTeamMember.deleteMany({
        where: { id: { in: createdTeamMemberIds } },
      });
    }

    if (createdEventIds.length > 0) {
      await prisma.event.deleteMany({
        where: { id: { in: createdEventIds } },
      });
    }

    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  });

  describe('1. Promotional Link Resolution & HTTP 302 Redirection', () => {
    it('resolves active primary slug with HTTP 302 redirect, sets host-only cookie, and forwards whitelisted UTMs', async () => {
      const res = await request(app)
        .get(`/r/${primaryHostSlug}?utm_source=instagram&utm_medium=bio&utm_campaign=summer&bad_tracker=evil123`)
        .expect(302);

      // Verify redirect target contains event slug and whitelisted params, but strips bad_tracker
      expect(res.header.location).toContain(`/events/promo-fest-1-${testRunId}`);
      expect(res.header.location).toContain('utm_source=instagram');
      expect(res.header.location).toContain('utm_medium=bio');
      expect(res.header.location).toContain('utm_campaign=summer');
      expect(res.header.location).not.toContain('bad_tracker');

      // Verify Set-Cookie header contains host-only outside_vid with no Domain attribute
      const cookieHeader = res.header['set-cookie'];
      expect(cookieHeader).toBeDefined();
      const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
      expect(rawCookie).toContain(`${VISITOR_COOKIE_NAME}=`);
      expect(rawCookie).toContain('Path=/');
      expect(rawCookie).toContain('HttpOnly');
      expect(rawCookie).toContain('SameSite=Lax');
      expect(rawCookie).toContain(`Max-Age=${COOKIE_MAX_AGE_SECONDS}`);
      expect(rawCookie.toLowerCase()).not.toContain('domain=');
    });

    it('resolves historical slug alias from PromotionSlugRegistry (isPrimary = false) and redirects to target event', async () => {
      const res = await request(app)
        .get(`/r/${historicalHostSlug}`)
        .expect(302);

      expect(res.header.location).toContain(`/events/promo-fest-1-${testRunId}`);
    });

    it('resolves through the /api/r/:slug proxy route identically', async () => {
      const res = await request(app)
        .get(`/api/r/${primaryCampaignSlug}`)
        .expect(302);

      expect(res.header.location).toContain(`/events/promo-fest-1-${testRunId}`);
    });

    it('returns 404 for an unregistered or non-existent slug', async () => {
      const res = await request(app)
        .get(`/r/unregistered-slug-${testRunId}`)
        .expect(404);

      expect(res.body.error).toBe('Promotion link not found');
    });
  });

  describe('2. Visitor Identity & Multi-Event Attribution Persistence', () => {
    it('preserves existing outside_vid cookie, derives stable canonicalVisitorId, and records persistent attribution', async () => {
      const customVid = 'vid_test_session_token_1234567890abcdef';
      const expectedCanonicalId = deriveCanonicalVisitorId(customVid);
      const expectedHash = hashVisitorId(customVid);

      const res = await request(app)
        .get(`/r/${primaryHostSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${customVid}`)
        .expect(302);

      // Verify the existing cookie was echoed/retained
      const cookieHeader = res.header['set-cookie'];
      expect(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader).toContain(customVid);

      // Verify PostgreSQL PromotionVisitorAttribution row
      const attribution = await prisma.promotionVisitorAttribution.findUnique({
        where: {
          canonicalVisitorId_eventId: {
            canonicalVisitorId: expectedCanonicalId,
            eventId: event1Id,
          },
        },
      });

      expect(attribution).not.toBeNull();
      expect(attribution?.canonicalVisitorId).toBe(expectedCanonicalId);
      expect(attribution?.promotionLinkId).toBe(hostLink1Id);
      expect(attribution?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify PostgreSQL PromotionVisitorDay row
      const todayUtc = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      const visitorDay = await prisma.promotionVisitorDay.findUnique({
        where: {
          promotionLinkId_canonicalVisitorId_visitDate: {
            promotionLinkId: hostLink1Id,
            canonicalVisitorId: expectedCanonicalId,
            visitDate: todayUtc,
          },
        },
      });

      expect(visitorDay).not.toBeNull();
      expect(visitorDay?.clickCount).toBe(1);
    });

    it('preserves multi-event attribution independence when a visitor visits Event 1 then Event 2', async () => {
      const multiVid = 'vid_multi_event_token_abcdef1234567890';
      const multiHash = hashVisitorId(multiVid);

      // Click link for Event 1
      await request(app)
        .get(`/r/${primaryHostSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${multiVid}`)
        .expect(302);

      // Click link for Event 2
      await request(app)
        .get(`/r/${event2CampaignSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${multiVid}`)
        .expect(302);

      // Verify Event 1 attribution is intact
      const multiCanonicalId = deriveCanonicalVisitorId(multiVid);
      const attrEvent1 = await prisma.promotionVisitorAttribution.findUnique({
        where: {
          canonicalVisitorId_eventId: {
            canonicalVisitorId: multiCanonicalId,
            eventId: event1Id,
          },
        },
      });
      expect(attrEvent1).not.toBeNull();
      expect(attrEvent1?.promotionLinkId).toBe(hostLink1Id);

      // Verify Event 2 attribution is intact and independent
      const attrEvent2 = await prisma.promotionVisitorAttribution.findUnique({
        where: {
          canonicalVisitorId_eventId: {
            canonicalVisitorId: multiCanonicalId,
            eventId: event2Id,
          },
        },
      });
      expect(attrEvent2).not.toBeNull();
      expect(attrEvent2?.promotionLinkId).toBe(campaignLink2Id);
    });

    it('updates last-click attribution winner for the same event when visitor clicks a second link', async () => {
      const sameEventVid = 'vid_last_click_same_event_9876543210';
      const sameEventCanonicalId = deriveCanonicalVisitorId(sameEventVid);

      // 1. First click Host link for Event 1
      await request(app)
        .get(`/r/${primaryHostSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${sameEventVid}`)
        .expect(302);

      let currentAttr = await prisma.promotionVisitorAttribution.findUnique({
        where: {
          canonicalVisitorId_eventId: {
            canonicalVisitorId: sameEventCanonicalId,
            eventId: event1Id,
          },
        },
      });
      expect(currentAttr?.promotionLinkId).toBe(hostLink1Id);

      // 2. Second click Campaign link for Event 1 (last-click winner)
      await request(app)
        .get(`/r/${primaryCampaignSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${sameEventVid}`)
        .expect(302);

      currentAttr = await prisma.promotionVisitorAttribution.findUnique({
        where: {
          canonicalVisitorId_eventId: {
            canonicalVisitorId: sameEventCanonicalId,
            eventId: event1Id,
          },
        },
      });
      expect(currentAttr?.promotionLinkId).toBe(campaignLink1Id);
    });
  });

  describe('3. Bot Filtering & Click Deduplication', () => {
    it('redirects bots without inserting PromotionClick, PromotionVisitorAttribution, or PromotionVisitorDay records and renders preview HTML without cookies', async () => {
      const botVid = 'vid_bot_crawler_token_1122334455667788';
      const botCanonicalId = deriveCanonicalVisitorId(botVid);

      const res = await request(app)
        .get(`/r/${primaryCampaignSlug}`)
        .set('User-Agent', 'Twitterbot/1.0')
        .expect(302);

      // Verify 302 redirect location points to public event
      expect(res.header.location).toContain(`/events/promo-fest-1-${testRunId}`);

      // Verify NO outside_vid Set-Cookie header is returned for bots
      const setCookie = res.header['set-cookie'];
      if (setCookie) {
        const joined = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
        expect(joined).not.toContain(VISITOR_COOKIE_NAME);
      } else {
        expect(setCookie).toBeUndefined();
      }

      // Verify crawler HTML body contains Open Graph & Twitter Card tags
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain(`Promo Fest 1 ${testRunId} | Outside.vip`);
      expect(res.text).toContain('<meta property="og:type" content="website" />');
      expect(res.text).toContain(
        `/events/promo-fest-1-${testRunId}`
      );
      expect(res.text).toContain('<link rel="canonical" href="');
      expect(res.text).toContain('<meta property="og:url" content="');
      expect(res.text).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(res.text).toContain(
        `<meta http-equiv="refresh" content="0; url=/events/promo-fest-1-${testRunId}" />`
      );

      // Verify no attribution was created
      const botAttr = await prisma.promotionVisitorAttribution.findUnique({
        where: {
          canonicalVisitorId_eventId: {
            canonicalVisitorId: botCanonicalId,
            eventId: event1Id,
          },
        },
      });
      expect(botAttr).toBeNull();

      // Verify no click record was created
      const clickCount = await prisma.promotionClick.count({
        where: {
          promotionLinkId: campaignLink1Id,
          userAgent: 'Twitterbot/1.0',
        },
      });
      expect(clickCount).toBe(0);

      // Verify no visitor-day record was created
      const dayCount = await prisma.promotionVisitorDay.count({
        where: {
          promotionLinkId: campaignLink1Id,
          canonicalVisitorId: botCanonicalId,
        },
      });
      expect(dayCount).toBe(0);
    });

    it('redirects crawler for unpublished (DRAFT) event without returning metadata, cookies, or attribution records', async () => {
      const res = await request(app)
        .get(`/r/${draftCampaignSlug}`)
        .set('User-Agent', 'Twitterbot/1.0')
        .expect(302);

      // Verify redirect points to the draft event slug
      expect(res.header.location).toContain(`/events/draft-fest-${testRunId}`);

      // Verify NO outside_vid Set-Cookie header is returned
      const setCookie = res.header['set-cookie'];
      if (setCookie) {
        const joined = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
        expect(joined).not.toContain(VISITOR_COOKIE_NAME);
      } else {
        expect(setCookie).toBeUndefined();
      }

      // Verify response body does NOT contain social preview metadata tags
      expect(res.text).not.toContain('<meta property="og:title"');
      expect(res.text).not.toContain('<meta name="twitter:title"');
      expect(res.text).not.toContain('Draft Fest');
      expect(res.text).not.toContain('Super Confidential Draft Details');
      expect(res.text).not.toContain('draft-poster.jpg');

      // Verify following redirect to /events/:slug with crawler returns 404 (no leak)
      const destRes = await request(app)
        .get(`/events/draft-fest-${testRunId}`)
        .set('User-Agent', 'Twitterbot/1.0')
        .expect(404);

      expect(destRes.text).toContain('Event Not Found');
      expect(destRes.text).not.toContain('Draft Fest');
      expect(destRes.text).not.toContain('Super Confidential Draft Details');

      // Verify no click, attribution, or visitor-day records exist
      const clickCount = await prisma.promotionClick.count({
        where: { promotionLinkId: draftCampaignLinkId },
      });
      expect(clickCount).toBe(0);

      const attrCount = await prisma.promotionVisitorAttribution.count({
        where: { promotionLinkId: draftCampaignLinkId },
      });
      expect(attrCount).toBe(0);

      const dayCount = await prisma.promotionVisitorDay.count({
        where: { promotionLinkId: draftCampaignLinkId },
      });
      expect(dayCount).toBe(0);
    });

    it('deduplicates rapid repeat clicks from the same visitor within 15 minutes', async () => {
      const dedupVid = `vid_dedup_test_${Date.now()}`;
      const canonicalId = deriveCanonicalVisitorId(dedupVid);

      // 1. Initial click
      await request(app)
        .get(`/r/${primaryCampaignSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${dedupVid}`)
        .expect(302);

      const firstClicks = await prisma.promotionClick.count({
        where: {
          promotionLinkId: campaignLink1Id,
          canonicalVisitorId: canonicalId,
        },
      });
      expect(firstClicks).toBe(1);

      // 2. Immediate second click
      await request(app)
        .get(`/r/${primaryCampaignSlug}`)
        .set('Cookie', `${VISITOR_COOKIE_NAME}=${dedupVid}`)
        .expect(302);

      const secondClicks = await prisma.promotionClick.count({
        where: {
          promotionLinkId: campaignLink1Id,
          canonicalVisitorId: canonicalId,
        },
      });
      // Click count is still 1 because the second click was deduplicated within 15 minutes
      expect(secondClicks).toBe(1);
    });
  });

  describe('4. Database Invariants, Triggers & Retention Guardrails', () => {
    it('enforces deferred constraint trigger: rejects deleting primary slug while link is ACTIVE', async () => {
      await expect(
        prisma.promotionSlugRegistry.delete({
          where: { slug: primaryCampaignSlug },
        })
      ).rejects.toThrow(/Active PromotionLink .* must have exactly one primary slug in PromotionSlugRegistry, found 0/);
    });

    it('enforces partial unique index: rejects inserting a second primary slug for the same link', async () => {
      await expect(
        prisma.promotionSlugRegistry.create({
          data: {
            slug: `second-primary-${testRunId}`,
            promotionLinkId: hostLink1Id,
            isPrimary: true,
          },
        })
      ).rejects.toThrow();
    });

    it('enforces CHECK constraint: rejects CAMPAIGN link with hostMemberId set', async () => {
      await expect(
        prisma.promotionLink.create({
          data: {
            eventId: event1Id,
            type: 'CAMPAIGN',
            status: 'ACTIVE',
            name: 'Invalid Campaign with Host',
            hostMemberId: hostMemberId,
            createdById: organizerId,
          },
        })
      ).rejects.toThrow();
    });

    it('enforces CHECK constraint: rejects HOST link with null hostMemberId', async () => {
      await expect(
        prisma.promotionLink.create({
          data: {
            eventId: event1Id,
            type: 'HOST',
            status: 'ACTIVE',
            name: 'Invalid Host without Member',
            hostMemberId: null,
            createdById: organizerId,
          },
        })
      ).rejects.toThrow();
    });

    it('enforces validation trigger: rejects HOST link referencing an EventTeamMember with role ADMIN', async () => {
      await expect(
        prisma.promotionLink.create({
          data: {
            eventId: event1Id,
            type: 'HOST',
            status: 'ACTIVE',
            name: 'Host link pointing to admin member',
            hostMemberId: adminMemberId,
            createdById: organizerId,
          },
        })
      ).rejects.toThrow(/must reference an EventTeamMember with role HOST/);
    });

    it('enforces protection trigger: prevents mutating EventTeamMember role from HOST to ADMIN when a link exists', async () => {
      await expect(
        prisma.eventTeamMember.update({
          where: { id: hostMemberId },
          data: { role: 'ADMIN' },
        })
      ).rejects.toThrow(/Cannot change EventTeamMember .* role from HOST to ADMIN while dependent PromotionLinks exist/);
    });

    it('enforces retention guardrail (onDelete: Restrict): rejects hard-deleting an Event that has PromotionVisitorDay records', async () => {
      await expect(
        prisma.event.delete({
          where: { id: event1Id },
        })
      ).rejects.toThrow();
    });
  });

  describe('5. Targeted Implementation Corrections: HMAC Rotation, Cookie Lifetime & Click Retention', () => {
    describe('Item 1: HMAC Rotation and Attribution Uniqueness', () => {
      it('upgrades visitorIdHash in place across HMAC key versions without creating duplicate attribution records', async () => {
        const rotationVid = `vid_hmac_rotation_${Date.now()}`;
        const canonicalId = deriveCanonicalVisitorId(rotationVid);
        const legacyHash = `v1:legacy_hash_${Date.now()}`;
        const currentHash = hashVisitorId(rotationVid);

        // 1. Seed attribution record under legacy v1 hash
        const initialClickedAt = new Date(Date.now() - 3600000); // 1 hour ago
        await prisma.promotionVisitorAttribution.create({
          data: {
            canonicalVisitorId: canonicalId,
            visitorIdHash: legacyHash,
            eventId: event1Id,
            promotionLinkId: hostLink1Id,
            clickedAt: initialClickedAt,
            expiresAt: new Date(initialClickedAt.getTime() + ATTRIBUTION_WINDOW_MS),
          },
        });

        // 2. Visitor returns and clicks a different campaign link under current HMAC key version
        await request(app)
          .get(`/r/${primaryCampaignSlug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=${rotationVid}`)
          .expect(302);

        // 3. Verify exactly ONE attribution record exists for this canonical visitor and event
        const totalRecords = await prisma.promotionVisitorAttribution.count({
          where: {
            canonicalVisitorId: canonicalId,
            eventId: event1Id,
          },
        });
        expect(totalRecords).toBe(1);

        // 4. Verify record was updated in place: hash upgraded, link updated to campaign link
        const updated = await prisma.promotionVisitorAttribution.findUnique({
          where: {
            canonicalVisitorId_eventId: {
              canonicalVisitorId: canonicalId,
              eventId: event1Id,
            },
          },
        });
        expect(updated).not.toBeNull();
        expect(updated?.visitorIdHash).toBe(currentHash);
        expect(updated?.promotionLinkId).toBe(campaignLink1Id);
        expect(updated?.clickedAt.getTime()).toBeGreaterThan(initialClickedAt.getTime());
      });

      it('enforces database-level uniqueness on (canonicalVisitorId, eventId), rejecting duplicate records', async () => {
        const vid = `vid_db_unique_check_${Date.now()}`;
        const canonicalId = deriveCanonicalVisitorId(vid);

        await prisma.promotionVisitorAttribution.create({
          data: {
            canonicalVisitorId: canonicalId,
            visitorIdHash: 'v1:hash_a',
            eventId: event1Id,
            promotionLinkId: hostLink1Id,
            expiresAt: new Date(Date.now() + ATTRIBUTION_WINDOW_MS),
          },
        });

        // Attempting to create a second record for the same canonical visitor and event MUST fail
        await expect(
          prisma.promotionVisitorAttribution.create({
            data: {
              canonicalVisitorId: canonicalId,
              visitorIdHash: 'v2:hash_b',
              eventId: event1Id,
              promotionLinkId: campaignLink1Id,
              expiresAt: new Date(Date.now() + ATTRIBUTION_WINDOW_MS),
            },
          })
        ).rejects.toThrow();
      });

      it('prevents delayed older requests from overwriting newer clicks across key versions', async () => {
        const vid = `vid_delayed_req_${Date.now()}`;
        const canonicalId = deriveCanonicalVisitorId(vid);

        const newerTime = new Date();
        const olderTime = new Date(Date.now() - 7200000); // 2 hours prior

        // Seed with newer click
        await upsertVisitorAttribution({
          rawVid: vid,
          eventId: event1Id,
          promotionLinkId: campaignLink1Id,
          clickedAt: newerTime,
        });

        // Delayed older request arrives with earlier timestamp
        await upsertVisitorAttribution({
          rawVid: vid,
          eventId: event1Id,
          promotionLinkId: hostLink1Id,
          clickedAt: olderTime,
        });

        const record = await prisma.promotionVisitorAttribution.findUnique({
          where: {
            canonicalVisitorId_eventId: {
              canonicalVisitorId: canonicalId,
              eventId: event1Id,
            },
          },
        });

        // Winning link remains the newer click (campaignLink1Id) and timestamp remains newerTime
        expect(record?.promotionLinkId).toBe(campaignLink1Id);
        expect(record?.clickedAt.getTime()).toBe(newerTime.getTime());
      });

      it('handles concurrent attribution upserts safely without duplicates or deadlocks', async () => {
        const vid = `vid_concurrent_${Date.now()}`;
        const canonicalId = deriveCanonicalVisitorId(vid);

        // Run 5 simultaneous upserts
        await Promise.all([
          upsertVisitorAttribution({ rawVid: vid, eventId: event1Id, promotionLinkId: hostLink1Id }),
          upsertVisitorAttribution({ rawVid: vid, eventId: event1Id, promotionLinkId: campaignLink1Id }),
          upsertVisitorAttribution({ rawVid: vid, eventId: event1Id, promotionLinkId: hostLink1Id }),
          upsertVisitorAttribution({ rawVid: vid, eventId: event1Id, promotionLinkId: campaignLink1Id }),
          upsertVisitorAttribution({ rawVid: vid, eventId: event1Id, promotionLinkId: hostLink1Id }),
        ]);

        const count = await prisma.promotionVisitorAttribution.count({
          where: {
            canonicalVisitorId: canonicalId,
            eventId: event1Id,
          },
        });
        expect(count).toBe(1);
      });
    });

    describe('Item 2: Cookie Lifetime & Identity Continuity', () => {
      it('renews 365-day sliding window Max-Age for returning visitor while keeping attribution window at 30 days', async () => {
        const returningVid = `returning_vid_${Date.now()}_abcdef1234567890`;
        const canonicalId = deriveCanonicalVisitorId(returningVid);

        const res = await request(app)
          .get(`/r/${primaryCampaignSlug}`)
          .set('Cookie', `${VISITOR_COOKIE_NAME}=${returningVid}`)
          .expect(302);

        // 1. Cookie sliding window renewed to 365 days (31536000 seconds)
        const setCookie = res.header['set-cookie'];
        const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        expect(rawCookie).toContain(`outside_vid=${returningVid}`);
        expect(rawCookie).toContain('Max-Age=31536000');

        // 2. Attribution record validity is strictly 30 days from click
        const attr = await prisma.promotionVisitorAttribution.findUnique({
          where: {
            canonicalVisitorId_eventId: {
              canonicalVisitorId: canonicalId,
              eventId: event1Id,
            },
          },
        });
        expect(attr).not.toBeNull();
        const validityWindowMs = attr!.expiresAt.getTime() - attr!.clickedAt.getTime();
        expect(validityWindowMs).toBe(30 * 24 * 60 * 60 * 1000);

        // 3. Raw token is never stored in DB
        const rawTokenMatch = await prisma.promotionVisitorAttribution.findFirst({
          where: {
            canonicalVisitorId: returningVid,
          },
        });
        expect(rawTokenMatch).toBeNull();
      });

      it('generates a fresh 128-bit identity when outside_vid cookie is missing', async () => {
        const res = await request(app)
          .get(`/r/${primaryCampaignSlug}`)
          .expect(302);

        const setCookie = res.header['set-cookie'];
        const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        expect(rawCookie).toMatch(/outside_vid=[a-f0-9]{32}/);
        expect(rawCookie).toContain('Max-Age=31536000');
      });
    });

    describe('Item 3: Raw Click Retention & Pruning', () => {
      it('prunes raw PromotionClick logs older than 90 days while preserving PromotionVisitorDay and PromotionVisitorAttribution', async () => {
        const pruneVid = `vid_prune_test_${Date.now()}`;
        const canonicalId = deriveCanonicalVisitorId(pruneVid);
        const hash = hashVisitorId(pruneVid);

        // 1. Establish persistent attribution and visitor day
        await upsertVisitorAttribution({
          rawVid: pruneVid,
          eventId: event1Id,
          promotionLinkId: hostLink1Id,
        });

        // 2. Insert clicks: one 100 days old, one 120 days old, and one 10 days old
        const oldClick1 = await prisma.promotionClick.create({
          data: {
            eventId: event1Id,
            promotionLinkId: hostLink1Id,
            canonicalVisitorId: canonicalId,
            visitorIdHash: hash,
            clickedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
          },
        });

        const oldClick2 = await prisma.promotionClick.create({
          data: {
            eventId: event1Id,
            promotionLinkId: hostLink1Id,
            canonicalVisitorId: canonicalId,
            visitorIdHash: hash,
            clickedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
          },
        });

        const recentClick = await prisma.promotionClick.create({
          data: {
            eventId: event1Id,
            promotionLinkId: hostLink1Id,
            canonicalVisitorId: canonicalId,
            visitorIdHash: hash,
            clickedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          },
        });

        // 3. Execute pruning with 90-day retention threshold
        const pruneResult = await pruneExpiredPromotionClicks(90);
        expect(pruneResult.deletedCount).toBeGreaterThanOrEqual(2);

        // 4. Verify old clicks are deleted from PromotionClick
        const foundOld1 = await prisma.promotionClick.findUnique({
          where: { id: oldClick1.id },
        });
        const foundOld2 = await prisma.promotionClick.findUnique({
          where: { id: oldClick2.id },
        });
        expect(foundOld1).toBeNull();
        expect(foundOld2).toBeNull();

        // 5. Verify recent click is retained
        const foundRecent = await prisma.promotionClick.findUnique({
          where: { id: recentClick.id },
        });
        expect(foundRecent).not.toBeNull();

        // 6. Verify PromotionVisitorAttribution is completely preserved and untouched
        const preservedAttr = await prisma.promotionVisitorAttribution.findUnique({
          where: {
            canonicalVisitorId_eventId: {
              canonicalVisitorId: canonicalId,
              eventId: event1Id,
            },
          },
        });
        expect(preservedAttr).not.toBeNull();
        expect(preservedAttr?.canonicalVisitorId).toBe(canonicalId);

        // 7. Verify PromotionVisitorDay is completely preserved and untouched
        const preservedDay = await prisma.promotionVisitorDay.findFirst({
          where: {
            canonicalVisitorId: canonicalId,
            promotionLinkId: hostLink1Id,
          },
        });
        expect(preservedDay).not.toBeNull();
      });
    });
  });
});
