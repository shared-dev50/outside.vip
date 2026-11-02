/**
 * Outside.vip Image Crop & Optimization Utility
 * Handles client-side image validation, crop boundary calculations,
 * responsive aspect ratios, high-quality canvas cropping, and compression.
 */

export type CropAspectRatio = '16:10' | '4:3' | '16:9' | '1:1' | 'free';

export interface AspectRatioOption {
  id: CropAspectRatio;
  label: string;
  ratio: number | null; // null for free/original
  description: string;
}

export const CROP_ASPECT_RATIOS: AspectRatioOption[] = [
  { id: '16:10', label: '16:10 Flyer', ratio: 16 / 10, description: 'Outside.vip event flyer format' },
  { id: '4:3', label: '4:3 Standard', ratio: 4 / 3, description: 'Standard photo landscape' },
  { id: '16:9', label: '16:9 Cinema', ratio: 16 / 9, description: 'Widescreen landscape' },
  { id: '1:1', label: '1:1 Square', ratio: 1 / 1, description: 'Square profile & avatar' },
  { id: 'free', label: 'Original', ratio: null, description: 'Preserve original image ratio' },
];

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_RAW_FILE_SIZE = 15 * 1024 * 1024; // 15 MB max selection for client cropping

export interface CropState {
  zoom: number; // 1.0 to 3.0+
  panX: number; // horizontal offset in viewport pixels
  panY: number; // vertical offset in viewport pixels
  aspectRatio: CropAspectRatio;
}

export interface CropDimensions {
  sourceCropX: number;
  sourceCropY: number;
  sourceCropWidth: number;
  sourceCropHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export interface CropResult {
  file: File;
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Validates an image file before opening the crop interface
 */
export function validateImageFile(file?: File | null): { valid: boolean; error?: string } {
  if (!file) {
    return { valid: false, error: 'No image file was selected.' };
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return {
      valid: false,
      error: 'Unsupported format. Please select a valid JPEG, PNG, or WebP image.',
    };
  }

  if (file.size > MAX_RAW_FILE_SIZE) {
    return {
      valid: false,
      error: `File exceeds maximum allowed size of 15MB (selected ${(file.size / (1024 * 1024)).toFixed(1)}MB).`,
    };
  }

  return { valid: true };
}

/**
 * Computes maximum allowed pan offsets to guarantee the crop frame
 * remains completely covered by the image (no empty letterboxing).
 */
export function calculateMaxPan(
  renderWidth: number,
  renderHeight: number,
  frameWidth: number,
  frameHeight: number
): { maxPanX: number; maxPanY: number } {
  return {
    maxPanX: Math.max(0, (renderWidth - frameWidth) / 2),
    maxPanY: Math.max(0, (renderHeight - frameHeight) / 2),
  };
}

/**
 * Clamps pan coordinates within valid boundaries
 */
export function clampPan(
  panX: number,
  panY: number,
  maxPanX: number,
  maxPanY: number
): { panX: number; panY: number } {
  return {
    panX: Math.max(-maxPanX, Math.min(maxPanX, panX)),
    panY: Math.max(-maxPanY, Math.min(maxPanY, panY)),
  };
}

/**
 * Resolves numerical aspect ratio for a given CropAspectRatio mode
 */
export function resolveAspectRatio(mode: CropAspectRatio, naturalWidth: number, naturalHeight: number): number {
  if (mode === 'free') {
    return naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 16 / 10;
  }
  const match = CROP_ASPECT_RATIOS.find((r) => r.id === mode);
  return match?.ratio || 16 / 10;
}

/**
 * Pure calculation of crop frame, rendered image geometry, and source image crop rectangle
 */
export function computeCropBounds(params: {
  viewportWidth: number;
  viewportHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  aspectRatio: CropAspectRatio;
  zoom: number;
  panX: number;
  panY: number;
  maxOutputDimension?: number;
}): {
  frameWidth: number;
  frameHeight: number;
  renderWidth: number;
  renderHeight: number;
  clampedPanX: number;
  clampedPanY: number;
  sourceCropX: number;
  sourceCropY: number;
  sourceCropWidth: number;
  sourceCropHeight: number;
  outputWidth: number;
  outputHeight: number;
} {
  const {
    viewportWidth,
    viewportHeight,
    naturalWidth,
    naturalHeight,
    aspectRatio,
    zoom = 1,
    panX = 0,
    panY = 0,
    maxOutputDimension = 1920,
  } = params;

  const targetRatio = resolveAspectRatio(aspectRatio, naturalWidth, naturalHeight);

  // Compute crop frame dimensions inside viewport with a 24px safety margin
  const availW = Math.max(80, viewportWidth - 48);
  const availH = Math.max(80, viewportHeight - 48);

  let frameWidth = availW;
  let frameHeight = frameWidth / targetRatio;

  if (frameHeight > availH) {
    frameHeight = availH;
    frameWidth = frameHeight * targetRatio;
  }

  frameWidth = Math.round(frameWidth);
  frameHeight = Math.round(frameHeight);

  // Base scale: image must completely cover crop frame at zoom 1.0
  const scaleX = frameWidth / naturalWidth;
  const scaleY = frameHeight / naturalHeight;
  const baseScale = Math.max(scaleX, scaleY);

  const effectiveZoom = Math.max(1, zoom);
  const renderWidth = naturalWidth * baseScale * effectiveZoom;
  const renderHeight = naturalHeight * baseScale * effectiveZoom;

  const { maxPanX, maxPanY } = calculateMaxPan(renderWidth, renderHeight, frameWidth, frameHeight);
  const { panX: clampedPanX, panY: clampedPanY } = clampPan(panX, panY, maxPanX, maxPanY);

  // Calculate image top-left relative to crop frame
  const imgLeft = (frameWidth - renderWidth) / 2 + clampedPanX;
  const imgTop = (frameHeight - renderHeight) / 2 + clampedPanY;

  // Scale from render pixels back to original image coordinates
  const renderToNatScale = 1 / (baseScale * effectiveZoom);

  let sourceCropX = Math.round(-imgLeft * renderToNatScale);
  let sourceCropY = Math.round(-imgTop * renderToNatScale);
  let sourceCropWidth = Math.round(frameWidth * renderToNatScale);
  let sourceCropHeight = Math.round(frameHeight * renderToNatScale);

  // Safeguard against coordinate boundary overshoot
  sourceCropX = Math.max(0, Math.min(naturalWidth - 1, sourceCropX));
  sourceCropY = Math.max(0, Math.min(naturalHeight - 1, sourceCropY));
  sourceCropWidth = Math.max(1, Math.min(naturalWidth - sourceCropX, sourceCropWidth));
  sourceCropHeight = Math.max(1, Math.min(naturalHeight - sourceCropY, sourceCropHeight));

  // Determine output export dimensions (downscale if larger than maxOutputDimension, don't upscale)
  let outputWidth = sourceCropWidth;
  let outputHeight = sourceCropHeight;

  if (outputWidth > maxOutputDimension || outputHeight > maxOutputDimension) {
    if (outputWidth >= outputHeight) {
      outputWidth = maxOutputDimension;
      outputHeight = Math.round(maxOutputDimension / targetRatio);
    } else {
      outputHeight = maxOutputDimension;
      outputWidth = Math.round(maxOutputDimension * targetRatio);
    }
  }

  outputWidth = Math.max(1, Math.round(outputWidth));
  outputHeight = Math.max(1, Math.round(outputHeight));

  return {
    frameWidth,
    frameHeight,
    renderWidth,
    renderHeight,
    clampedPanX,
    clampedPanY,
    sourceCropX,
    sourceCropY,
    sourceCropWidth,
    sourceCropHeight,
    outputWidth,
    outputHeight,
  };
}

/**
 * Renders the cropped image area to an offscreen canvas and compresses it to WebP/JPEG.
 */
export async function createCroppedImageFile(params: {
  imageElement: HTMLImageElement;
  sourceCropX: number;
  sourceCropY: number;
  sourceCropWidth: number;
  sourceCropHeight: number;
  outputWidth: number;
  outputHeight: number;
  originalFileName: string;
  quality?: number;
}): Promise<CropResult> {
  const {
    imageElement,
    sourceCropX,
    sourceCropY,
    sourceCropWidth,
    sourceCropHeight,
    outputWidth,
    outputHeight,
    originalFileName,
    quality = 0.88,
  } = params;

  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is not available');
  }

  // Use highest quality interpolation for downsampling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    imageElement,
    sourceCropX,
    sourceCropY,
    sourceCropWidth,
    sourceCropHeight,
    0,
    0,
    outputWidth,
    outputHeight
  );

  // Attempt WebP compression first; fallback to JPEG if WebP is unsupported
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b && b.size > 0) {
          resolve(b);
        } else {
          // Fallback to JPEG
          canvas.toBlob(
            (jpegBlob) => {
              if (jpegBlob && jpegBlob.size > 0) {
                resolve(jpegBlob);
              } else {
                reject(new Error('Failed to encode cropped image to blob'));
              }
            },
            'image/jpeg',
            quality
          );
        }
      },
      'image/webp',
      quality
    );
  });

  const baseName = originalFileName.replace(/\.[^/.]+$/, '');
  const extension = blob.type === 'image/webp' ? '.webp' : '.jpg';
  const finalFileName = `${baseName}-cropped${extension}`;

  const file = new File([blob], finalFileName, {
    type: blob.type,
    lastModified: Date.now(),
  });

  const previewUrl = URL.createObjectURL(blob);

  return {
    file,
    blob,
    previewUrl,
    width: outputWidth,
    height: outputHeight,
    sizeBytes: blob.size,
  };
}

/**
 * Formats byte counts into human-readable strings (e.g., 240 KB or 1.4 MB)
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
