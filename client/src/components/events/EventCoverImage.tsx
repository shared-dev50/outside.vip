import React, { useCallback, useEffect, useRef, useState } from 'react';

export const DEFAULT_COVER_FALLBACK =
  'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1200&q=80';

export type CoverImageOrientation = 'landscape' | 'portrait' | 'square';

interface ImageDimensions {
  width: number;
  height: number;
}

interface EventCoverImageProps {
  src: string;
  alt: string;
  /**
   * - 'poster': 4:5 portrait-first card presentation (Home & Discover). Never crops
   *   existing landscape, square, or non-4:5 portrait artwork; fills naturally when
   *   4:5 and uses clean object-contain matte without blurred background duplicates.
   * - 'natural': Natural aspect-ratio hero presentation (Event Details & Active Cover
   *   preview). Preserves uploaded portrait, landscape, and square proportions with
   *   a single artwork image and zero blurred side-fillers.
   * - 'fixed': Compact fixed-size framing (locked event teaser and dashboard thumbnails).
   */
  mode?: 'poster' | 'natural' | 'fixed';
  /** Classes applied to the outer container wrapper. */
  containerClassName?: string;
  /** Classes added to the primary <img> element (hover scale, blur, etc.). */
  imgClassName?: string;
  /** Override Unsplash fallback URL if needed. */
  fallbackSrc?: string;
  loading?: 'lazy' | 'eager';
  /** Extra blur/brightness classes applied for fixed-mode backdrops. */
  backdropImgClassName?: string;
  /** Maximum height (px) used when bounding portrait/square heroes in natural mode. */
  maxNaturalHeroHeight?: number;
  /** Callback fired once natural orientation is resolved. */
  onOrientationChange?: (orientation: CoverImageOrientation) => void;
  children?: React.ReactNode;
}

function classifyOrientation(width: number, height: number): CoverImageOrientation {
  if (height > width) return 'portrait';
  if (height === width) return 'square';
  return 'landscape';
}

function isNearPosterFourFifths(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return Math.abs(ratio - 4 / 5) <= 0.03;
}

function needsPosterAmbientBackdrop(width: number, height: number): boolean {
  if (width <= 0 || height <= 0 || isNearPosterFourFifths(width, height)) {
    return false;
  }
  const ratio = width / height;
  const mismatch = Math.max(ratio / (4 / 5), (4 / 5) / ratio);
  return mismatch >= 1.12;
}

/**
 * Shared cover artwork renderer with orientation awareness and zero duplicated
 * blurred fillers on Home, Discover, and unlocked Event Details surfaces.
 */
export const EventCoverImage: React.FC<EventCoverImageProps> = ({
  src,
  alt,
  mode = 'fixed',
  containerClassName = '',
  imgClassName = '',
  fallbackSrc = DEFAULT_COVER_FALLBACK,
  loading,
  backdropImgClassName = '',
  maxNaturalHeroHeight = 580,
  onOrientationChange,
  children,
}) => {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState(src || fallbackSrc);
  const [fallbackApplied, setFallbackApplied] = useState(false);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [orientation, setOrientation] = useState<CoverImageOrientation>('landscape');

  const applyDimensions = useCallback(
    (naturalWidth: number, naturalHeight: number) => {
      if (naturalWidth <= 0 || naturalHeight <= 0) return;
      setDimensions({ width: naturalWidth, height: naturalHeight });
      const next = classifyOrientation(naturalWidth, naturalHeight);
      setOrientation(next);
      onOrientationChange?.(next);
    },
    [onOrientationChange]
  );

  useEffect(() => {
    setResolvedSrc(src || fallbackSrc);
    setFallbackApplied(false);
    setDimensions(null);
    setOrientation('landscape');
  }, [src, fallbackSrc]);

  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
      applyDimensions(el.naturalWidth, el.naturalHeight);
    }
  }, [resolvedSrc, applyDimensions]);

  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    applyDimensions(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
  };

  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!fallbackApplied && e.currentTarget.src !== fallbackSrc) {
      setFallbackApplied(true);
      setDimensions(null);
      setOrientation('landscape');
      setResolvedSrc(fallbackSrc);
      e.currentTarget.src = fallbackSrc;
    }
  };

  if (mode === 'poster') {
    const isExactFourFifths =
      dimensions !== null && isNearPosterFourFifths(dimensions.width, dimensions.height);
    const showAmbientBackdrop =
      dimensions !== null && needsPosterAmbientBackdrop(dimensions.width, dimensions.height);
    const fitClass = isExactFourFifths ? 'object-cover' : 'object-contain';

    return (
      <div
        className={`relative aspect-[4/5] w-full overflow-hidden ${
          showAmbientBackdrop ? 'bg-stone-950' : 'bg-[#F3EFE6] dark:bg-[#181B24]'
        } ${containerClassName}`.trim()}
      >
        {showAmbientBackdrop && (
          <>
            <img
              src={resolvedSrc}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl brightness-50 saturate-75 pointer-events-none select-none"
            />
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-stone-950/35 pointer-events-none"
            />
          </>
        )}

        <img
          ref={imgRef}
          src={resolvedSrc}
          alt={alt}
          loading={loading}
          onLoad={handleLoad}
          onError={handleError}
          className={`relative z-[1] w-full h-full ${fitClass} ${imgClassName}`.trim()}
        />
        {children}
      </div>
    );
  }

  if (mode === 'natural') {
    let wrapperStyle: React.CSSProperties | undefined;
    let wrapperSizingClass = 'aspect-[16/10] w-full';

    if (dimensions) {
      const ratio = dimensions.width / dimensions.height;
      wrapperStyle = {
        aspectRatio: `${dimensions.width} / ${dimensions.height}`,
      };
      if (dimensions.height >= dimensions.width) {
        const cappedWidthPx = Math.round(maxNaturalHeroHeight * ratio);
        wrapperStyle.maxWidth = `min(100%, ${cappedWidthPx}px)`;
        wrapperSizingClass = 'w-full mx-auto';
      } else {
        wrapperSizingClass = 'w-full';
      }
    }

    return (
      <div
        style={wrapperStyle}
        className={`relative overflow-hidden ${wrapperSizingClass} ${containerClassName}`.trim()}
      >
        <img
          ref={imgRef}
          src={resolvedSrc}
          alt={alt}
          loading={loading}
          onLoad={handleLoad}
          onError={handleError}
          className={`relative block w-full h-full object-contain ${imgClassName}`.trim()}
        />
        {children}
      </div>
    );
  }

  // 'fixed': preserves legacy compact thumbnail and locked-gate behaviour
  const isPortrait = orientation === 'portrait';
  const fitClass = isPortrait ? 'object-contain' : 'object-cover';

  return (
    <div className={`relative overflow-hidden ${containerClassName}`.trim()}>
      {isPortrait && (
        <img
          src={resolvedSrc}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 w-full h-full object-cover blur-2xl scale-110 opacity-45 pointer-events-none select-none ${backdropImgClassName}`.trim()}
        />
      )}

      <img
        ref={imgRef}
        src={resolvedSrc}
        alt={alt}
        loading={loading}
        onLoad={handleLoad}
        onError={handleError}
        className={`relative w-full h-full ${fitClass} ${imgClassName}`.trim()}
      />

      {children}
    </div>
  );
};
