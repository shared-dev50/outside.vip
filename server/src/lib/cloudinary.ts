import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import { env } from '../config/env';

export const CLOUDINARY_FOLDER = 'outside-vip/event-covers';
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Configure Cloudinary SDK if credentials exist
if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/**
 * Check if Cloudinary credentials are fully configured on the server
 */
export function isCloudinaryConfigured(): boolean {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME &&
    env.CLOUDINARY_CLOUD_NAME.trim().length > 0 &&
    env.CLOUDINARY_API_KEY &&
    env.CLOUDINARY_API_KEY.trim().length > 0 &&
    env.CLOUDINARY_API_SECRET &&
    env.CLOUDINARY_API_SECRET.trim().length > 0
  );
}

export interface ImageValidationResult {
  isValid: boolean;
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
  error?: string;
}

/**
 * Validate image buffer using true magic bytes and size constraints
 */
export function validateImageBuffer(buffer: Buffer): ImageValidationResult {
  if (!buffer || buffer.length === 0) {
    return { isValid: false, error: 'No image data received or file is empty.' };
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      error: `Image file exceeds maximum allowed size of 5 MB (received ${(buffer.length / (1024 * 1024)).toFixed(2)} MB).`,
    };
  }

  // 1. JPEG Magic bytes: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { isValid: true, mimeType: 'image/jpeg' };
  }

  // 2. PNG Magic bytes: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { isValid: true, mimeType: 'image/png' };
  }

  // 3. WebP Magic bytes: "RIFF" .... "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { isValid: true, mimeType: 'image/webp' };
  }

  return {
    isValid: false,
    error: 'Invalid image format. Only authentic JPEG, PNG, and WebP images are permitted.',
  };
}

/**
 * Generate signed upload parameters for direct client-to-Cloudinary upload
 */
export function generateSignedUploadParams(folder: string = CLOUDINARY_FOLDER) {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      'Cloudinary is not configured on the server. Please configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    folder,
    timestamp,
  };

  const signature = cloudinary.utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET);

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    folder,
    signature,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  };
}

/**
 * Generate an optimized thumbnail URL for an event cover
 */
export function generateThumbnailUrl(secureUrl: string): string {
  if (secureUrl.includes('/upload/')) {
    return secureUrl.replace('/upload/', '/upload/c_fill,g_auto,w_600,h_400,q_auto,f_auto/');
  }
  return secureUrl;
}

export interface UploadResult {
  secure_url: string;
  public_id: string;
  thumbnailUrl: string;
  format: string;
  width: number;
  height: number;
}

/**
 * Upload an image buffer directly to Cloudinary using a stream
 */
export async function uploadImageBuffer(
  buffer: Buffer,
  folder: string = CLOUDINARY_FOLDER
): Promise<UploadResult> {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      'Cloudinary is not configured on the server. Please configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'
    );
  }

  const validation = validateImageBuffer(buffer);
  if (!validation.isValid) {
    throw new Error(validation.error || 'Invalid image file.');
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      },
      (error, result: UploadApiResponse | undefined) => {
        if (error || !result) {
          return reject(error || new Error('Upload to Cloudinary failed without result.'));
        }

        const thumbnailUrl = generateThumbnailUrl(result.secure_url);

        resolve({
          secure_url: result.secure_url,
          public_id: result.public_id,
          thumbnailUrl,
          format: result.format,
          width: result.width,
          height: result.height,
        });
      }
    );

    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    stream.pipe(uploadStream);
  });
}

/**
 * Delete a Cloudinary asset by public ID safely
 * Ensures public ID starts with the dedicated folder to avoid accidental or malicious deletions
 */
export async function deleteCloudinaryAsset(publicId?: string | null): Promise<boolean> {
  if (!isCloudinaryConfigured()) return false;
  if (!publicId || typeof publicId !== 'string') return false;

  const trimmedId = publicId.trim();

  // Safeguard: Only delete assets that reside inside our dedicated event covers folder
  if (!trimmedId.startsWith(CLOUDINARY_FOLDER)) {
    console.warn(`[Cloudinary] Skipped deletion: Asset "${trimmedId}" is outside dedicated folder "${CLOUDINARY_FOLDER}".`);
    return false;
  }

  try {
    const res = await cloudinary.uploader.destroy(trimmedId, { invalidate: true });
    return res.result === 'ok';
  } catch (err) {
    console.error(`[Cloudinary] Error destroying asset "${trimmedId}":`, err);
    return false;
  }
}

export { cloudinary };
