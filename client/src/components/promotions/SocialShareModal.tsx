import React, { useState } from 'react';
import {
  X,
  Share2,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Info,
  Image as ImageIcon,
  Smartphone,
} from 'lucide-react';
import {
  SocialPlatform,
  SocialShareEventContext,
  getPlatformShareDetails,
  copyTextToClipboard,
} from '../../lib/socialSharing';

export interface SocialShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: SocialShareEventContext;
  link: {
    id: string;
    slug: string;
    name?: string;
  };
  isHost?: boolean;
}

const PLATFORMS: Array<{
  id: SocialPlatform;
  label: string;
  isPrimary: boolean;
  tag?: string;
}> = [
  { id: 'x', label: 'X (Twitter)', isPrimary: true },
  { id: 'tiktok', label: 'TikTok', isPrimary: true },
  { id: 'instagram', label: 'Instagram', isPrimary: true },
  { id: 'snapchat', label: 'Snapchat', isPrimary: true },
  { id: 'whatsapp', label: 'WhatsApp', isPrimary: false },
  { id: 'facebook', label: 'Facebook', isPrimary: false },
];

export const SocialShareModal: React.FC<SocialShareModalProps> = ({
  isOpen,
  onClose,
  event,
  link,
  isHost = false,
}) => {
  const [selectedPlatform, setSelectedPlatform] = useState<SocialPlatform>('x');
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCaption, setCopiedCaption] = useState(false);
  const [copiedPoster, setCopiedPoster] = useState(false);

  if (!isOpen) return null;

  const shareDetails = getPlatformShareDetails({
    slug: link.slug,
    platform: selectedPlatform,
    event,
    campaignIdentifier: link.slug,
    contentIdentifier: isHost ? 'host' : undefined,
  });

  const handleCopyLink = async () => {
    const success = await copyTextToClipboard(shareDetails.shareUrl);
    if (success) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleCopyCaption = async () => {
    const success = await copyTextToClipboard(shareDetails.promotionalText);
    if (success) {
      setCopiedCaption(true);
      setTimeout(() => setCopiedCaption(false), 2000);
    }
  };

  const handleCopyPosterUrl = async () => {
    if (!event.coverImageUrl) return;
    const success = await copyTextToClipboard(event.coverImageUrl);
    if (success) {
      setCopiedPoster(true);
      setTimeout(() => setCopiedPoster(false), 2000);
    }
  };

  const handleOpenComposer = () => {
    if (shareDetails.composerUrl) {
      window.open(shareDetails.composerUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleDeviceShare = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: event.title,
          text: shareDetails.promotionalText,
          url: shareDetails.shareUrl,
        });
      } catch {
        // User cancelled share dialog
      }
    }
  };

  const hasDeviceShare = typeof navigator !== 'undefined' && Boolean(navigator?.share);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
      data-testid="social-share-modal"
    >
      <div
        className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-stone-100 bg-stone-50/70">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-stone-900 text-white">
                <Share2 className="w-4 h-4" />
              </div>
              <h2 className="text-base font-bold text-stone-900">
                {isHost ? 'Share Personal Host Link' : 'Share Promotional Link'}
              </h2>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-stone-200 text-stone-700">
                /r/{link.slug}
              </span>
            </div>
            <p className="text-xs text-stone-500">
              Distribute tracked links with social previews for{' '}
              <span className="font-semibold text-stone-800">{event.title}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-5">
          {/* Platform Selector Tabs */}
          <div>
            <label className="text-[11px] font-mono uppercase tracking-wider font-semibold text-stone-500 block mb-2">
              Select Sharing Platform
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {PLATFORMS.map((plat) => {
                const isSelected = selectedPlatform === plat.id;
                return (
                  <button
                    key={plat.id}
                    type="button"
                    onClick={() => {
                      setSelectedPlatform(plat.id);
                      setCopiedLink(false);
                      setCopiedCaption(false);
                    }}
                    className={`flex flex-col items-center justify-center py-2.5 px-2 rounded-xl text-xs font-semibold transition-all border cursor-pointer ${
                      isSelected
                        ? 'bg-stone-900 border-stone-900 text-white shadow-xs'
                        : 'bg-stone-50/80 border-stone-200 text-stone-700 hover:bg-stone-100'
                    }`}
                  >
                    <span className="text-xs">{plat.label}</span>
                    {plat.isPrimary && (
                      <span
                        className={`text-[9px] font-mono mt-0.5 uppercase tracking-tight ${
                          isSelected ? 'text-amber-300' : 'text-stone-400'
                        }`}
                      >
                        Priority
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Platform Configuration Card */}
          <div className="rounded-xl border border-stone-200 bg-stone-50/40 p-4 space-y-4">
            {/* Header of Active Platform */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-200/80">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                <h3 className="text-xs font-bold text-stone-900 uppercase tracking-wide">
                  {shareDetails.name} Share Configuration
                </h3>
              </div>
              <span className="text-[10px] font-mono text-stone-500 bg-white px-2 py-0.5 rounded border border-stone-200">
                utm_source={shareDetails.platform}
              </span>
            </div>

            {/* Tracked Promotional URL */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-stone-700">
                  Tracked Campaign URL
                </label>
                <span className="text-[10px] text-stone-400 font-mono">
                  Preserves attribution &amp; slug
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareDetails.shareUrl}
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-stone-200 rounded-lg text-stone-800 select-all focus:outline-hidden"
                />
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-stone-900 hover:bg-black text-white text-xs font-semibold rounded-lg shrink-0 transition-colors cursor-pointer shadow-2xs"
                >
                  {copiedLink ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Link</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Direct Composer & Device Share Actions */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {shareDetails.composerUrl && (
                <button
                  type="button"
                  onClick={handleOpenComposer}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer shadow-2xs"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open {shareDetails.name} Composer</span>
                </button>
              )}

              {hasDeviceShare && (
                <button
                  type="button"
                  onClick={handleDeviceShare}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-lg transition-colors cursor-pointer border border-stone-200"
                >
                  <Smartphone className="w-3.5 h-3.5 text-stone-600" />
                  <span>Share via Device</span>
                </button>
              )}
            </div>

            {/* Promotional Caption / Text Box */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-stone-700">
                  Recommended Promotional Text
                </label>
                <button
                  type="button"
                  onClick={handleCopyCaption}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-stone-600 hover:text-stone-900 cursor-pointer"
                >
                  {copiedCaption ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span className="text-emerald-700 font-bold">Caption Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy Caption</span>
                    </>
                  )}
                </button>
              </div>
              <textarea
                readOnly
                rows={2}
                value={shareDetails.promotionalText}
                className="w-full px-3 py-2 text-xs bg-white border border-stone-200 rounded-lg text-stone-700 select-all focus:outline-hidden resize-none"
              />
            </div>

            {/* Platform Advice & Restrictions Note */}
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-950">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-[11px] leading-relaxed">
                <strong className="font-semibold block text-amber-900">Platform Guidance:</strong>
                {shareDetails.captionTip}
              </div>
            </div>

            {/* Event Artwork / Poster Card */}
            {event.coverImageUrl && (
              <div className="flex items-center gap-3 p-2.5 rounded-lg bg-white border border-stone-200">
                <img
                  src={event.coverImageUrl}
                  alt={event.title}
                  className="w-12 h-12 object-cover rounded-md bg-stone-100 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 text-xs font-semibold text-stone-800">
                    <ImageIcon className="w-3.5 h-3.5 text-stone-500" />
                    <span>Event Artwork</span>
                  </div>
                  <p className="text-[11px] text-stone-500 truncate mt-0.5">
                    Use this official poster in your social story or video post.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyPosterUrl}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-stone-100 hover:bg-stone-200 text-stone-700 text-[11px] font-semibold transition-colors cursor-pointer shrink-0"
                >
                  {copiedPoster ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy Poster Link</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Attribution & Zero-Click Guarantee */}
          <div className="text-[11px] text-stone-400 leading-normal flex items-center justify-between border-t border-stone-100 pt-3">
            <span>
              🔒 All links include standard UTM campaign attribution. Generating or copying links does
              not record clicks.
            </span>
            <span className="font-mono text-[10px]">Outside.vip Marketing</span>
          </div>
        </div>
      </div>
    </div>
  );
};

