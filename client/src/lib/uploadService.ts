/**
 * Outside.vip Image Upload Service
 * High-level helper providing progress-aware and abortable uploads
 * to Cloudinary with server fallback.
 */

import { api, UploadProgressPayload } from './api';

export type UploadProgressEvent = UploadProgressPayload;

export interface UploadResult {
  secure_url: string;
  public_id: string;
  thumbnailUrl?: string;
  format?: string;
  width?: number;
  height?: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgressEvent) => void;
  signal?: AbortSignal;
}

/**
 * Uploads an image file with genuine progress tracking and abort support.
 */
export async function uploadImageWithProgress(
  file: File,
  options: UploadOptions = {}
): Promise<UploadResult> {
  return api.organizer.uploadCoverImage(file, options.onProgress, options.signal);
}
