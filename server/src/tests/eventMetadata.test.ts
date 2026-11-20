import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildEventSocialMetadata,
  renderCrawlerHtml,
  escapeHtml,
} from '../modules/events/eventMetadata.service.js';
import { isBotUserAgent } from '../modules/promotions/promotions.constants.js';
import {
  handlePublicEventCrawler,
  getEventSocialMetadata,
} from '../modules/events/events.controller.js';
import { prisma } from '../db/prisma.js';
import { EventStatus } from '@prisma/client';
import { NotFoundError } from '../utils/errors.js';

describe('Outside.vip — Event Social Preview Metadata & Crawler Handling', () => {
  const publicEvent = {
    id: 'evt_123',
    slug: 'safari-sound-clash',
    title: 'Safari Sound Clash 2026',
    tagline: 'The biggest outdoor bass music festival in East Africa.',
    description: '<p>Join thousands of music lovers under the stars at Carnivore Grounds Nairobi.</p>',
    coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
    isPasswordProtected: false,
    status: EventStatus.PUBLISHED,
  };

  // =========================================================================
  // 1. Social Metadata Builder
  // =========================================================================
  describe('1. Social Metadata Builder', () => {
    it('builds complete Open Graph and Twitter Card metadata for public events', () => {
      const meta = buildEventSocialMetadata(publicEvent, { baseUrl: 'https://outside.vip' });

      expect(meta.title).toBe('Safari Sound Clash 2026 | Outside.vip');
      expect(meta.description).toBe('The biggest outdoor bass music festival in East Africa.');
      expect(meta.imageUrl).toBe('https://images.unsplash.com/photo-1514525253161-7a46d19cd819');
      expect(meta.url).toBe('https://outside.vip/events/safari-sound-clash');
      expect(meta.type).toBe('website');
      expect(meta.twitterCard).toBe('summary_large_image');
      expect(meta.siteName).toBe('Outside.vip');
    });

    it('converts relative image paths to absolute URLs', () => {
      const eventWithRelativeImage = {
        ...publicEvent,
        coverImageUrl: '/uploads/posters/carnivore-2026.jpg',
      };

      const meta = buildEventSocialMetadata(eventWithRelativeImage, {
        baseUrl: 'https://outside.vip',
      });

      expect(meta.imageUrl).toBe('https://outside.vip/uploads/posters/carnivore-2026.jpg');
    });

    it('falls back to default brand asset when coverImageUrl is missing or null', () => {
      const eventWithoutImage = {
        ...publicEvent,
        coverImageUrl: '' as any,
      };

      const meta = buildEventSocialMetadata(eventWithoutImage, {
        baseUrl: 'https://outside.vip',
      });

      expect(meta.imageUrl).toBe('https://outside.vip/android-chrome-512x512.png');
    });

    it('sanitizes HTML tags and collapses whitespace in descriptions', () => {
      const eventWithHtml = {
        ...publicEvent,
        tagline: null,
        description: '<div><strong>Exclusive Event!</strong>   Lots of    spaces.\n\nNewlines here.</div>',
      };

      const meta = buildEventSocialMetadata(eventWithHtml, { baseUrl: 'https://outside.vip' });

      expect(meta.description).not.toContain('<div>');
      expect(meta.description).not.toContain('<strong>');
      expect(meta.description).toContain('Exclusive Event! Lots of spaces. Newlines here.');
    });

    it('masks title and description for private password-protected events', () => {
      const privateEvent = {
        ...publicEvent,
        title: 'Secret VIP Birthday Party',
        tagline: 'Private estate in Karen.',
        description: 'Super confidential details.',
        isPasswordProtected: true,
      };

      const meta = buildEventSocialMetadata(privateEvent, { baseUrl: 'https://outside.vip' });

      // Confidential event title and description MUST NOT be exposed to crawlers
      expect(meta.title).toBe('Private Event | Outside.vip');
      expect(meta.description).toContain('This event is private and password protected');
      expect(meta.description).not.toContain('Secret VIP Birthday Party');
      expect(meta.description).not.toContain('Private estate in Karen');
      expect(meta.imageUrl).toBe('https://outside.vip/android-chrome-512x512.png');
    });
  });

  // =========================================================================
  // 2. Crawler-Readable HTML Document Rendering & Refresh Tag Control
  // =========================================================================
  describe('2. Crawler-Readable HTML Rendering & Refresh Behavior', () => {
    it('renders standards-compliant HTML containing all required Open Graph and Twitter Card tags', () => {
      const meta = buildEventSocialMetadata(publicEvent, { baseUrl: 'https://outside.vip' });
      const html = renderCrawlerHtml(meta, {
        redirectUrl: 'https://outside.vip/events/safari-sound-clash',
      });

      // HTML Document structure
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('<title>Safari Sound Clash 2026 | Outside.vip</title>');

      // Open Graph Tags
      expect(html).toContain('<meta property="og:type" content="website" />');
      expect(html).toContain('<meta property="og:url" content="https://outside.vip/events/safari-sound-clash" />');
      expect(html).toContain('<meta property="og:title" content="Safari Sound Clash 2026 | Outside.vip" />');
      expect(html).toContain('<meta property="og:description" content="The biggest outdoor bass music festival in East Africa." />');
      expect(html).toContain('<meta property="og:image" content="https://images.unsplash.com/photo-1514525253161-7a46d19cd819" />');
      expect(html).toContain('<meta property="og:site_name" content="Outside.vip" />');

      // Twitter Card Tags
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html).toContain('<meta name="twitter:title" content="Safari Sound Clash 2026 | Outside.vip" />');
      expect(html).toContain('<meta name="twitter:description" content="The biggest outdoor bass music festival in East Africa." />');
      expect(html).toContain('<meta name="twitter:image" content="https://images.unsplash.com/photo-1514525253161-7a46d19cd819" />');

      // Canonical Link
      expect(html).toContain('<link rel="canonical" href="https://outside.vip/events/safari-sound-clash" />');
    });

    it('renders http-equiv refresh ONLY when redirectUrl is explicitly provided', () => {
      const meta = buildEventSocialMetadata(publicEvent, { baseUrl: 'https://outside.vip' });
      const htmlWithRedirect = renderCrawlerHtml(meta, {
        redirectUrl: 'https://outside.vip/events/safari-sound-clash',
      });

      expect(htmlWithRedirect).toContain(
        '<meta http-equiv="refresh" content="0; url=https://outside.vip/events/safari-sound-clash" />'
      );
    });

    it('OMITS http-equiv refresh completely when redirectUrl is omitted (prevents event-page self-redirect loops)', () => {
      const meta = buildEventSocialMetadata(publicEvent, { baseUrl: 'https://outside.vip' });
      const htmlWithoutRedirect = renderCrawlerHtml(meta);

      expect(htmlWithoutRedirect).not.toContain('http-equiv="refresh"');
      expect(htmlWithoutRedirect).not.toContain('http-equiv');
    });

    it('safely escapes HTML characters in titles and descriptions to prevent XSS injection', () => {
      const unsafeMeta = {
        title: 'Rock & Roll <script>alert("hacked")</script>',
        description: 'Tickets for "VIP" & \'Backstage\' <img src=x onerror=alert(1)>',
        imageUrl: 'https://outside.vip/img.jpg?a=1&b=2',
        url: 'https://outside.vip/events/test',
        type: 'website',
        twitterCard: 'summary_large_image' as const,
        siteName: 'Outside.vip & Co',
      };

      const html = renderCrawlerHtml(unsafeMeta);

      // Must escape dangerous HTML tokens
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(&quot;hacked&quot;)&lt;/script&gt;');
      expect(html).toContain('&quot;VIP&quot;');
      expect(html).toContain('&#39;Backstage&#39;');
      expect(html).toContain('&amp; Co');
    });

    it('escapeHtml helper handles empty and undefined strings cleanly', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null as any)).toBe('');
      expect(escapeHtml(undefined as any)).toBe('');
    });
  });

  // =========================================================================
  // 3. Social Crawler & Bot Detection Pattern Matching
  // =========================================================================
  describe('3. Social Crawler & Bot Detection', () => {
    it('identifies social crawlers and search engine bots accurately', () => {
      const bots = [
        'Twitterbot/1.0',
        'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'facebookexternalhit/1.1',
        'WhatsApp/2.21.12.21 A',
        'TelegramBot (like TwitterBot)',
        'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
        'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
        'Discordbot/2.0; +https://discordapp.com',
        'Snapchat/11.0 (iPhone; iOS 14.4; Scale/3.00)',
        'Pinterest/0.2 (+http://www.pinterest.com/bot.html)',
        'Meta-ExternalAgent/1.0 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
        'Applebot/0.1',
      ];

      bots.forEach((ua) => {
        expect(isBotUserAgent(ua)).toBe(true);
      });
    });

    it('does NOT flag legitimate human web browsers as bots', () => {
      const humans = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
        'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
      ];

      humans.forEach((ua) => {
        expect(isBotUserAgent(ua)).toBe(false);
      });
    });

    it('returns false for empty or non-string user agents', () => {
      expect(isBotUserAgent(null)).toBe(false);
      expect(isBotUserAgent(undefined)).toBe(false);
      expect(isBotUserAgent('')).toBe(false);
    });
  });

  // =========================================================================
  // 4. Vercel Rewrite Regex Validation (No PCRE inline (?i) flag)
  // =========================================================================
  describe('4. Vercel Rewrite Regex Validation', () => {
    const vercelRegex = new RegExp(
      '.*([bB][oO][tT]|[cC][rR][aA][wW][lL]|[sS][pP][iI][dD][eE][rR]|[sS][lL][uU][rR][pP]|[fF]acebook[eE]xternal[hH]it|[wW]hats[aA]pp|[tT]elegram[bB]ot|[tT]witter[bB]ot|[lL]inked[iI]n[bB]ot|[sS]lack[bB]ot|[dD]iscord[bB]ot|[bB]ing[pP]review|[gG]oogle-[sS]tructured-[dD]ata-[tT]esting-[tT]ool|[aA]pple[bB]ot|[sS]napchat|[pP]interest|[mM]eta-[eE]xternal[aA]gent).*'
    );

    it('matches all known crawler user agents without requiring PCRE flags', () => {
      const crawlers = [
        'Twitterbot/1.0',
        'twitterbot/1.0',
        'facebookexternalhit/1.1',
        'FacebookExternalHit/1.1',
        'WhatsApp/2.21.12.21 A',
        'whatsapp/2.21.12.21 A',
        'TelegramBot (like TwitterBot)',
        'LinkedInBot/1.0',
        'Slackbot-LinkExpanding 1.0',
        'Discordbot/2.0',
        'BingPreview/1.0b',
        'Googlebot/2.1',
        'bingbot/2.0',
        'Applebot/0.1',
        'applebot/0.1',
        'Snapchat/11.0',
        'Pinterest/0.2',
        'Meta-ExternalAgent/1.0',
        'meta-externalagent/1.0',
        'Slurp',
        'slurp',
        'Baiduspider/2.0',
        'google-structured-data-testing-tool',
        'YandexBot/3.0',
      ];

      for (const ua of crawlers) {
        expect(vercelRegex.test(ua), `Expected crawler "${ua}" to match Vercel regex`).toBe(true);
      }
    });

    it('never matches normal human browser User-Agent strings', () => {
      const browsers = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.101 Mobile Safari/537.36',
      ];

      for (const ua of browsers) {
        expect(vercelRegex.test(ua), `Expected browser "${ua}" NOT to match Vercel regex`).toBe(false);
      }
    });
  });

  // =========================================================================
  // 5. Unpublished / Draft Event Privacy & Protection
  // =========================================================================
  describe('5. Unpublished / Draft Event Protection', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('handlePublicEventCrawler returns 404 HTML without event metadata when event is DRAFT', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_draft_1',
        slug: 'super-secret-draft',
        title: 'Super Secret Draft Party',
        tagline: 'Should not leak',
        description: 'Classified details',
        coverImageUrl: 'https://outside.vip/secret.jpg',
        isPasswordProtected: false,
        status: EventStatus.DRAFT,
      } as any);

      let statusCode = 0;
      let contentType = '';
      let sentBody = '';

      const req: any = { params: { slug: 'super-secret-draft' } };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        type: (type: string) => {
          contentType = type;
          return res;
        },
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };
      const next = vi.fn();

      await handlePublicEventCrawler(req, res, next);

      expect(statusCode).toBe(404);
      expect(contentType).toBe('html');
      expect(sentBody).toContain('Event Not Found');
      expect(sentBody).not.toContain('Super Secret Draft Party');
      expect(sentBody).not.toContain('Classified details');
      expect(sentBody).not.toContain('https://outside.vip/secret.jpg');
    });

    it('handlePublicEventCrawler returns 404 HTML when event is ARCHIVED', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_archived_1',
        slug: 'old-party',
        title: 'Old Party 2020',
        tagline: 'Archived',
        description: 'Past event',
        coverImageUrl: null,
        isPasswordProtected: false,
        status: EventStatus.ARCHIVED,
      } as any);

      let statusCode = 0;
      let sentBody = '';
      const req: any = { params: { slug: 'old-party' } };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        type: () => res,
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };
      const next = vi.fn();

      await handlePublicEventCrawler(req, res, next);

      expect(statusCode).toBe(404);
      expect(sentBody).toContain('Event Not Found');
      expect(sentBody).not.toContain('Old Party 2020');
    });

    it('handlePublicEventCrawler returns 404 HTML when event is CANCELLED', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_cancelled_1',
        slug: 'cancelled-event',
        title: 'Cancelled Festival 2026',
        tagline: 'Cancelled',
        description: 'No longer taking place',
        coverImageUrl: null,
        isPasswordProtected: false,
        status: EventStatus.CANCELLED,
      } as any);

      let statusCode = 0;
      let sentBody = '';
      const req: any = { params: { slug: 'cancelled-event' } };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        type: () => res,
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };
      const next = vi.fn();

      await handlePublicEventCrawler(req, res, next);

      expect(statusCode).toBe(404);
      expect(sentBody).toContain('Event Not Found');
      expect(sentBody).not.toContain('Cancelled Festival 2026');
    });

    it('handlePublicEventCrawler returns 404 HTML when event does not exist', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce(null);

      let statusCode = 0;
      let sentBody = '';
      const req: any = { params: { slug: 'non-existent' } };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        type: () => res,
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };
      const next = vi.fn();

      await handlePublicEventCrawler(req, res, next);

      expect(statusCode).toBe(404);
      expect(sentBody).toContain('Event Not Found');
    });

    it('handlePublicEventCrawler returns 200 HTML with metadata and NO refresh tag for PUBLISHED events', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_published_1',
        slug: 'safari-sound-clash',
        title: 'Safari Sound Clash 2026',
        tagline: 'Bass Festival',
        description: 'Carnivore Nairobi',
        coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819',
        isPasswordProtected: false,
        status: EventStatus.PUBLISHED,
      } as any);

      let statusCode = 0;
      let contentType = '';
      let sentBody = '';
      const req: any = { params: { slug: 'safari-sound-clash' } };
      const res: any = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        type: (type: string) => {
          contentType = type;
          return res;
        },
        send: (body: string) => {
          sentBody = body;
          return res;
        },
      };
      const next = vi.fn();

      await handlePublicEventCrawler(req, res, next);

      expect(statusCode).toBe(200);
      expect(contentType).toBe('html');
      expect(sentBody).toContain('Safari Sound Clash 2026');
      expect(sentBody).toContain('og:title');
      // Crucial: direct event crawler responses MUST NOT include a self-referencing refresh tag
      expect(sentBody).not.toContain('http-equiv="refresh"');
    });

    it('getEventSocialMetadata throws NotFoundError when event is DRAFT', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_draft_2',
        slug: 'confidential-event',
        title: 'Confidential Event',
        status: EventStatus.DRAFT,
      } as any);

      const req: any = { params: { slug: 'confidential-event' } };
      const res: any = { json: vi.fn() };
      let capturedError: any = null;
      const next = (err: any) => {
        capturedError = err;
      };

      await getEventSocialMetadata(req, res, next);

      expect(capturedError).toBeInstanceOf(NotFoundError);
      expect(capturedError?.message).toBe('Event not found');
    });

    it('getEventSocialMetadata throws NotFoundError when event is ARCHIVED', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_arch_2',
        slug: 'archived-event',
        title: 'Archived Event',
        status: EventStatus.ARCHIVED,
      } as any);

      const req: any = { params: { slug: 'archived-event' } };
      const res: any = { json: vi.fn() };
      let capturedError: any = null;
      const next = (err: any) => {
        capturedError = err;
      };

      await getEventSocialMetadata(req, res, next);

      expect(capturedError).toBeInstanceOf(NotFoundError);
      expect(capturedError?.message).toBe('Event not found');
    });

    it('getEventSocialMetadata throws NotFoundError when event is CANCELLED', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_canc_2',
        slug: 'cancelled-event',
        title: 'Cancelled Event',
        status: EventStatus.CANCELLED,
      } as any);

      const req: any = { params: { slug: 'cancelled-event' } };
      const res: any = { json: vi.fn() };
      let capturedError: any = null;
      const next = (err: any) => {
        capturedError = err;
      };

      await getEventSocialMetadata(req, res, next);

      expect(capturedError).toBeInstanceOf(NotFoundError);
      expect(capturedError?.message).toBe('Event not found');
    });

    it('getEventSocialMetadata returns metadata when event is PUBLISHED', async () => {
      vi.spyOn(prisma.event, 'findFirst').mockResolvedValueOnce({
        id: 'evt_pub_2',
        slug: 'live-event',
        title: 'Live Event 2026',
        tagline: 'Great vibes',
        description: 'Come through',
        coverImageUrl: 'https://outside.vip/live.jpg',
        isPasswordProtected: false,
        status: EventStatus.PUBLISHED,
      } as any);

      const req: any = { params: { slug: 'live-event' } };
      let jsonPayload: any = null;
      const res: any = {
        json: (payload: any) => {
          jsonPayload = payload;
        },
      };
      const next = vi.fn();

      await getEventSocialMetadata(req, res, next);

      expect(jsonPayload).not.toBeNull();
      expect(jsonPayload.success).toBe(true);
      expect(jsonPayload.metadata.title).toBe('Live Event 2026 | Outside.vip');
      expect(next).not.toHaveBeenCalled();
    });
  });
});
