/**
 * Social Sharing and Campaign Promotional URL Utilities
 * Outside.vip — Stage 5 Implementation 2
 */

export type SocialPlatform =
  | 'x'
  | 'tiktok'
  | 'instagram'
  | 'snapchat'
  | 'whatsapp'
  | 'facebook';

export interface SocialShareEventContext {
  title: string;
  slug: string;
  city?: string | null;
  tagline?: string | null;
  coverImageUrl?: string | null;
  category?: string | null;
}

export interface BuildPromotionalShareUrlParams {
  baseUrl?: string;
  slug: string;
  platform: SocialPlatform;
  event: SocialShareEventContext;
  campaignIdentifier?: string;
  contentIdentifier?: string;
}

export interface PlatformShareDetails {
  platform: SocialPlatform;
  name: string;
  shareUrl: string;
  composerUrl?: string;
  promotionalText: string;
  captionTip: string;
  supportsDirectShare: boolean;
  artworkUrl?: string | null;
}

/**
 * Generates a share-ready promotional URL with standard UTM parameters.
 *
 * UTM Conventions:
 * - utm_source: platform (e.g. x, tiktok, instagram, snapchat, whatsapp, facebook)
 * - utm_medium: social
 * - utm_campaign: stable URL-safe event or campaign identifier
 * - utm_content: optional host or campaign identifier
 */
export function buildPromotionalShareUrl(params: BuildPromotionalShareUrlParams): string {
  const { baseUrl, slug, platform, event, campaignIdentifier, contentIdentifier } = params;

  let origin = baseUrl;
  if (!origin) {
    origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'https://outside.vip';
  }
  const cleanOrigin = origin.replace(/\/+$/, '');
  const cleanSlug = encodeURIComponent(slug.trim());

  const searchParams = new URLSearchParams();
  searchParams.set('utm_source', platform);
  searchParams.set('utm_medium', 'social');

  // Stable URL-safe campaign identifier
  const campaign = (campaignIdentifier || event.slug || slug || 'event')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  searchParams.set('utm_campaign', campaign);

  if (contentIdentifier && contentIdentifier.trim()) {
    const content = contentIdentifier.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    searchParams.set('utm_content', content);
  }

  return `${cleanOrigin}/r/${cleanSlug}?${searchParams.toString()}`;
}

/**
 * Returns platform-specific sharing copy, composer URL, and platform advice.
 */
export function getPlatformShareDetails(
  params: BuildPromotionalShareUrlParams
): PlatformShareDetails {
  const { platform, event } = params;
  const shareUrl = buildPromotionalShareUrl(params);

  const eventTitle = event.title?.trim() || 'Outside.vip Event';
  const citySuffix = event.city ? ` in ${event.city}` : '';

  switch (platform) {
    case 'x': {
      const tweetText = `Join me at ${eventTitle}${citySuffix}! 🎟️ Get tickets:`;
      const composerUrl = `https://twitter.com/intent/tweet?url=${encodeURIComponent(
        shareUrl
      )}&text=${encodeURIComponent(tweetText)}`;

      return {
        platform: 'x',
        name: 'X (formerly Twitter)',
        shareUrl,
        composerUrl,
        promotionalText: `Join me at ${eventTitle}${citySuffix}! 🎟️ Get tickets on Outside.vip: ${shareUrl}`,
        captionTip:
          'Opens the X composer with your tracked link. X automatically displays a rich poster preview from our Open Graph and Twitter Card tags.',
        supportsDirectShare: true,
        artworkUrl: event.coverImageUrl,
      };
    }

    case 'tiktok': {
      const categoryTag = event.category ? ` #${event.category.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
      const promoCaption = `Heading to ${eventTitle}${citySuffix}! 🎟️ Get tickets via link in bio: ${shareUrl} #outsidevip #events${categoryTag}`;

      return {
        platform: 'tiktok',
        name: 'TikTok',
        shareUrl,
        composerUrl: undefined,
        promotionalText: promoCaption,
        captionTip:
          'TikTok does not automatically generate link previews or support clickable links in standard video captions. Place this tracked link in your TikTok profile bio or video sticker.',
        supportsDirectShare: false,
        artworkUrl: event.coverImageUrl,
      };
    }

    case 'instagram': {
      const instaCaption = `Heading to ${eventTitle}${citySuffix}! 🎟️ Grab tickets via link in bio or Story sticker: ${shareUrl}`;

      return {
        platform: 'instagram',
        name: 'Instagram',
        shareUrl,
        composerUrl: undefined,
        promotionalText: instaCaption,
        captionTip:
          'Instagram does not support clickable links in feed post captions. Add this tracked link as a "Link" sticker in your Instagram Story or put it in your Profile Bio.',
        supportsDirectShare: false,
        artworkUrl: event.coverImageUrl,
      };
    }

    case 'snapchat': {
      const snapText = `Going to ${eventTitle}${citySuffix}! 🎟️ Grab tickets here: ${shareUrl}`;

      return {
        platform: 'snapchat',
        name: 'Snapchat',
        shareUrl,
        composerUrl: undefined,
        promotionalText: snapText,
        captionTip:
          'In Snapchat, tap the Paperclip icon on your Snap or Story to attach this tracked ticket link before posting.',
        supportsDirectShare: typeof navigator !== 'undefined' && Boolean(navigator?.share),
        artworkUrl: event.coverImageUrl,
      };
    }

    case 'whatsapp': {
      const waText = `Join me at ${eventTitle}${citySuffix}! 🎟️ Get tickets on Outside.vip: ${shareUrl}`;
      const composerUrl = `https://wa.me/?text=${encodeURIComponent(waText)}`;

      return {
        platform: 'whatsapp',
        name: 'WhatsApp',
        shareUrl,
        composerUrl,
        promotionalText: waText,
        captionTip:
          'Opens WhatsApp to send your tracked promotional link directly to chats, groups, or WhatsApp Status. WhatsApp will fetch the event poster preview automatically.',
        supportsDirectShare: true,
        artworkUrl: event.coverImageUrl,
      };
    }

    case 'facebook': {
      const composerUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
        shareUrl
      )}`;

      return {
        platform: 'facebook',
        name: 'Facebook',
        shareUrl,
        composerUrl,
        promotionalText: `Join me at ${eventTitle}${citySuffix}! 🎟️ Get tickets on Outside.vip: ${shareUrl}`,
        captionTip:
          'Opens the Facebook share dialog. Facebook automatically reads our Open Graph metadata to render the event title, description, and poster.',
        supportsDirectShare: true,
        artworkUrl: event.coverImageUrl,
      };
    }

    default: {
      return {
        platform,
        name: platform,
        shareUrl,
        promotionalText: `Check out ${eventTitle}: ${shareUrl}`,
        captionTip: 'Copy and share this tracked promotional link.',
        supportsDirectShare: false,
        artworkUrl: event.coverImageUrl,
      };
    }
  }
}

/**
 * Copies text to the system clipboard with legacy fallback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback below
    }
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch {
    return false;
  }
}
