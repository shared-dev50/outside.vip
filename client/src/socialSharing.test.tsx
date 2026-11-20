import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  buildPromotionalShareUrl,
  getPlatformShareDetails,
  SocialPlatform,
  copyTextToClipboard,
} from './lib/socialSharing';
import { SocialShareModal } from './components/promotions/SocialShareModal';

describe('Outside.vip — Stage 5 Implementation 2: Social Sharing & Promotional URLs', () => {
  const mockEvent = {
    title: 'Neon Nights Festival',
    slug: 'neon-nights-fest',
    city: 'Nairobi',
    tagline: 'The ultimate electronic dance music experience.',
    coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745',
    category: 'MUSIC',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Promotional Share URL & UTM Conventions
  // =========================================================================
  describe('1. Promotional Share URL & UTM Conventions', () => {
    it('generates standard UTM parameters for X (Twitter)', () => {
      const url = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'vip-host-sam',
        platform: 'x',
        event: mockEvent,
      });

      expect(url).toContain('https://outside.vip/r/vip-host-sam?');
      expect(url).toContain('utm_source=x');
      expect(url).toContain('utm_medium=social');
      expect(url).toContain('utm_campaign=neon-nights-fest');
    });

    it('generates standard UTM parameters for TikTok', () => {
      const url = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'vip-host-sam',
        platform: 'tiktok',
        event: mockEvent,
      });

      expect(url).toContain('utm_source=tiktok');
      expect(url).toContain('utm_medium=social');
      expect(url).toContain('utm_campaign=neon-nights-fest');
    });

    it('generates standard UTM parameters for Instagram', () => {
      const url = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'summer-campaign',
        platform: 'instagram',
        event: mockEvent,
      });

      expect(url).toContain('utm_source=instagram');
      expect(url).toContain('utm_medium=social');
      expect(url).toContain('utm_campaign=neon-nights-fest');
    });

    it('generates standard UTM parameters for Snapchat', () => {
      const url = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'snap-drop',
        platform: 'snapchat',
        event: mockEvent,
      });

      expect(url).toContain('utm_source=snapchat');
      expect(url).toContain('utm_medium=social');
      expect(url).toContain('utm_campaign=neon-nights-fest');
    });

    it('generates standard UTM parameters for WhatsApp and Facebook', () => {
      const waUrl = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'chat-blast',
        platform: 'whatsapp',
        event: mockEvent,
      });
      expect(waUrl).toContain('utm_source=whatsapp');
      expect(waUrl).toContain('utm_medium=social');

      const fbUrl = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'fb-promo',
        platform: 'facebook',
        event: mockEvent,
      });
      expect(fbUrl).toContain('utm_source=facebook');
      expect(fbUrl).toContain('utm_medium=social');
    });

    it('handles custom campaignIdentifier and optional contentIdentifier cleanly', () => {
      const url = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'partner-promo',
        platform: 'x',
        event: mockEvent,
        campaignIdentifier: 'custom-summer-bash',
        contentIdentifier: 'host-dave',
      });

      expect(url).toContain('utm_campaign=custom-summer-bash');
      expect(url).toContain('utm_content=host-dave');
    });

    it('sanitizes special characters in campaign names to preserve URL safety', () => {
      const url = buildPromotionalShareUrl({
        baseUrl: 'https://outside.vip',
        slug: 'special-link',
        platform: 'x',
        event: mockEvent,
        campaignIdentifier: 'Summer Kickoff 2026! @Nairobi',
      });

      // Special characters should be replaced with hyphens
      expect(url).toContain('utm_campaign=summer-kickoff-2026---nairobi');
      expect(url).not.toContain(' ');
      expect(url).not.toContain('@');
      expect(url).not.toContain('!');
    });
  });

  // =========================================================================
  // 2. Platform-Specific Sharing Details & Guidance Copy
  // =========================================================================
  describe('2. Platform-Specific Sharing Details & Guidance Copy', () => {
    it('provides X composer intent with pre-filled text, event URL, and rich preview explanation', () => {
      const details = getPlatformShareDetails({
        baseUrl: 'https://outside.vip',
        slug: 'promo-1',
        platform: 'x',
        event: mockEvent,
      });

      expect(details.platform).toBe('x');
      expect(details.name).toContain('X');
      expect(details.composerUrl).toBeDefined();
      expect(details.composerUrl).toContain('https://twitter.com/intent/tweet?');
      expect(details.composerUrl).toContain(encodeURIComponent(details.shareUrl));
      expect(details.supportsDirectShare).toBe(true);
      expect(details.captionTip).toContain('X automatically displays a rich poster preview');
    });

    it('provides TikTok guidance copy, bio instruction, and acknowledges no web preview', () => {
      const details = getPlatformShareDetails({
        baseUrl: 'https://outside.vip',
        slug: 'promo-1',
        platform: 'tiktok',
        event: mockEvent,
      });

      expect(details.platform).toBe('tiktok');
      expect(details.name).toBe('TikTok');
      expect(details.composerUrl).toBeUndefined();
      expect(details.promotionalText).toContain('#outsidevip');
      expect(details.promotionalText).toContain('link in bio');
      expect(details.captionTip).toContain('TikTok does not automatically generate link previews');
      expect(details.supportsDirectShare).toBe(false);
    });

    it('provides Instagram guidance copy explaining non-clickable feed captions and Story stickers', () => {
      const details = getPlatformShareDetails({
        baseUrl: 'https://outside.vip',
        slug: 'promo-1',
        platform: 'instagram',
        event: mockEvent,
      });

      expect(details.platform).toBe('instagram');
      expect(details.name).toBe('Instagram');
      expect(details.composerUrl).toBeUndefined();
      expect(details.promotionalText).toContain('Story sticker');
      expect(details.captionTip).toContain('Instagram does not support clickable links in feed post captions');
      expect(details.captionTip).toContain('Link');
    });

    it('provides Snapchat guidance copy with paperclip attachment instructions', () => {
      const details = getPlatformShareDetails({
        baseUrl: 'https://outside.vip',
        slug: 'promo-1',
        platform: 'snapchat',
        event: mockEvent,
      });

      expect(details.platform).toBe('snapchat');
      expect(details.name).toBe('Snapchat');
      expect(details.captionTip).toContain('Paperclip icon');
    });

    it('provides WhatsApp wa.me composer link and status tip', () => {
      const details = getPlatformShareDetails({
        baseUrl: 'https://outside.vip',
        slug: 'promo-1',
        platform: 'whatsapp',
        event: mockEvent,
      });

      expect(details.composerUrl).toContain('https://wa.me/?text=');
      expect(details.supportsDirectShare).toBe(true);
      expect(details.captionTip).toContain('WhatsApp will fetch the event poster preview');
    });

    it('provides Facebook sharer link and Open Graph tip', () => {
      const details = getPlatformShareDetails({
        baseUrl: 'https://outside.vip',
        slug: 'promo-1',
        platform: 'facebook',
        event: mockEvent,
      });

      expect(details.composerUrl).toContain('https://www.facebook.com/sharer/sharer.php?u=');
      expect(details.supportsDirectShare).toBe(true);
      expect(details.captionTip).toContain('Facebook automatically reads our Open Graph metadata');
    });
  });

  // =========================================================================
  // 3. SocialShareModal Component Rendering & Interaction
  // =========================================================================
  describe('3. SocialShareModal Component Rendering & Interaction', () => {
    it('renders the modal when open with event title, slug, and platform tabs', () => {
      const html = renderToString(
        <SocialShareModal
          isOpen={true}
          onClose={() => {}}
          event={mockEvent}
          link={{ id: 'link_1', slug: 'neon-fest-host' }}
          isHost={true}
        />
      );

      // Header verification
      expect(html).toContain('Share Personal Host Link');
      expect(html).toContain('/r/neon-fest-host');
      expect(html).toContain('Neon Nights Festival');

      // Platform buttons
      expect(html).toContain('X (Twitter)');
      expect(html).toContain('TikTok');
      expect(html).toContain('Instagram');
      expect(html).toContain('Snapchat');
      expect(html).toContain('WhatsApp');
      expect(html).toContain('Facebook');

      // Default active platform is X
      expect(html).toContain('Share Configuration');
      expect(html).toContain('utm_source=x');
      expect(html).toContain('Composer');
      expect(html).toContain('X (formerly Twitter)');

      // Artwork thumbnail
      expect(html).toContain('Event Artwork');
      expect(html).toContain('Copy Poster Link');

      // Zero-click guarantee
      expect(html).toContain('Generating or copying links does not record clicks');
    });

    it('renders nothing when isOpen is false', () => {
      const html = renderToString(
        <SocialShareModal
          isOpen={false}
          onClose={() => {}}
          event={mockEvent}
          link={{ id: 'link_1', slug: 'neon-fest-host' }}
        />
      );

      expect(html).toBe('');
    });

    it('renders organizer-specific title when isHost is false', () => {
      const html = renderToString(
        <SocialShareModal
          isOpen={true}
          onClose={() => {}}
          event={mockEvent}
          link={{ id: 'link_1', slug: 'general-campaign' }}
          isHost={false}
        />
      );

      expect(html).toContain('Share Promotional Link');
      expect(html).not.toContain('Share Personal Host Link');
    });

    it('gracefully renders when event artwork/poster is missing', () => {
      const eventWithoutPoster = {
        title: 'Community Meetup',
        slug: 'community-meetup',
        coverImageUrl: null,
      };

      const html = renderToString(
        <SocialShareModal
          isOpen={true}
          onClose={() => {}}
          event={eventWithoutPoster}
          link={{ id: 'link_2', slug: 'meetup-link' }}
        />
      );

      expect(html).toContain('Community Meetup');
      expect(html).toContain('/r/meetup-link');
      // Artwork card should be cleanly omitted without crashing
      expect(html).not.toContain('Event Artwork');
    });
  });

  // =========================================================================
  // 4. Zero-Click Guarantee on URL Generation & Copy
  // =========================================================================
  describe('4. Zero-Click Guarantee on Share URL Generation', () => {
    it('generating share URLs does not make HTTP requests or dispatch clicks', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const platforms: SocialPlatform[] = ['x', 'tiktok', 'instagram', 'snapchat', 'whatsapp', 'facebook'];
      platforms.forEach((platform) => {
        const details = getPlatformShareDetails({
          baseUrl: 'https://outside.vip',
          slug: 'test-slug',
          platform,
          event: mockEvent,
        });
        expect(details.shareUrl).toContain(`utm_source=${platform}`);
      });

      // Pure in-memory generation: ZERO network requests
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('copyTextToClipboard falls back gracefully in test environments', async () => {
      // In SSR / headless test environments without clipboard API
      const result = await copyTextToClipboard('https://outside.vip/r/test');
      // Should not throw an unhandled rejection
      expect(typeof result).toBe('boolean');
    });
  });
});
