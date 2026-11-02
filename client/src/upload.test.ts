import { describe, it, expect, vi } from 'vitest';
import {
  validateImageFile,
  computeCropBounds,
  calculateMaxPan,
  clampPan,
  resolveAspectRatio,
  formatBytes,
} from './lib/imageCrop';
import { uploadImageWithProgress } from './lib/uploadService';
import { api } from './lib/api';

describe('Image Crop & Optimization Utilities', () => {
  describe('validateImageFile', () => {
    it('accepts valid JPEG, PNG, and WebP files within size limits', () => {
      const jpeg = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });
      const png = new File(['data'], 'photo.png', { type: 'image/png' });
      const webp = new File(['data'], 'photo.webp', { type: 'image/webp' });

      expect(validateImageFile(jpeg).valid).toBe(true);
      expect(validateImageFile(png).valid).toBe(true);
      expect(validateImageFile(webp).valid).toBe(true);
    });

    it('rejects disallowed file types with descriptive error', () => {
      const gif = new File(['data'], 'anim.gif', { type: 'image/gif' });
      const pdf = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
      const svg = new File(['data'], 'vector.svg', { type: 'image/svg+xml' });

      const gifRes = validateImageFile(gif);
      expect(gifRes.valid).toBe(false);
      expect(gifRes.error).toContain('Unsupported format');

      const pdfRes = validateImageFile(pdf);
      expect(pdfRes.valid).toBe(false);

      const svgRes = validateImageFile(svg);
      expect(svgRes.valid).toBe(false);
    });

    it('rejects files larger than 15MB', () => {
      const hugeFile = new File(['x'.repeat(100)], 'huge.jpg', { type: 'image/jpeg' });
      Object.defineProperty(hugeFile, 'size', { value: 16 * 1024 * 1024 });

      const res = validateImageFile(hugeFile);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('exceeds maximum allowed size');
    });

    it('handles empty or missing file safely', () => {
      expect(validateImageFile(null).valid).toBe(false);
      expect(validateImageFile(undefined).valid).toBe(false);
    });
  });

  describe('resolveAspectRatio', () => {
    it('resolves 16:10 for cover artwork', () => {
      expect(resolveAspectRatio('16:10', 3200, 2000)).toBe(1.6);
    });

    it('resolves standard gallery ratios 4:3, 16:9, and 1:1', () => {
      expect(resolveAspectRatio('4:3', 1600, 1200)).toBeCloseTo(1.333, 2);
      expect(resolveAspectRatio('16:9', 1920, 1080)).toBeCloseTo(1.777, 2);
      expect(resolveAspectRatio('1:1', 1000, 1000)).toBe(1.0);
    });

    it('resolves free/original ratio using natural image dimensions', () => {
      expect(resolveAspectRatio('free', 2500, 1000)).toBe(2.5);
    });
  });

  describe('calculateMaxPan & clampPan', () => {
    it('calculates max pan based on rendered size vs frame size', () => {
      const { maxPanX, maxPanY } = calculateMaxPan(800, 600, 600, 400);
      expect(maxPanX).toBe(100);
      expect(maxPanY).toBe(100);
    });

    it('clamps pan offsets to prevent empty space around frame', () => {
      const clamped = clampPan(150, -200, 100, 100);
      expect(clamped.panX).toBe(100);
      expect(clamped.panY).toBe(-100);
    });
  });

  describe('computeCropBounds', () => {
    it('computes exact 16:10 crop frame and output dimensions for cover flyer', () => {
      const result = computeCropBounds({
        viewportWidth: 640,
        viewportHeight: 480,
        naturalWidth: 3200,
        naturalHeight: 2000,
        aspectRatio: '16:10',
        zoom: 1,
        panX: 0,
        panY: 0,
        maxOutputDimension: 1920,
      });

      expect(result.frameWidth / result.frameHeight).toBeCloseTo(1.6, 1);
      expect(result.sourceCropWidth / result.sourceCropHeight).toBeCloseTo(1.6, 1);
      expect(result.outputWidth).toBeLessThanOrEqual(1920);
      expect(result.outputWidth / result.outputHeight).toBeCloseTo(1.6, 1);
      expect(result.sourceCropX).toBeGreaterThanOrEqual(0);
      expect(result.sourceCropY).toBeGreaterThanOrEqual(0);
    });

    it('downscales output resolution when source exceeds maxOutputDimension', () => {
      const result = computeCropBounds({
        viewportWidth: 600,
        viewportHeight: 400,
        naturalWidth: 4000,
        naturalHeight: 3000,
        aspectRatio: '4:3',
        zoom: 1,
        panX: 0,
        panY: 0,
        maxOutputDimension: 1600,
      });

      expect(result.outputWidth).toBe(1600);
      expect(result.outputHeight).toBe(1200);
    });

    it('does not upscale small images unnecessarily', () => {
      const result = computeCropBounds({
        viewportWidth: 600,
        viewportHeight: 400,
        naturalWidth: 800,
        naturalHeight: 600,
        aspectRatio: '4:3',
        zoom: 1,
        panX: 0,
        panY: 0,
        maxOutputDimension: 1600,
      });

      expect(result.outputWidth).toBeLessThanOrEqual(800);
      expect(result.outputHeight).toBeLessThanOrEqual(600);
    });
  });

  describe('formatBytes', () => {
    it('formats bytes into appropriate units', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(1024 * 250)).toBe('250.0 KB');
      expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    });
  });
});

describe('Image Upload Service & Progress Tracking', () => {
  it('api.organizer.uploadCoverImage reports progress callback', async () => {
    const fakeFile = new File(['dummy-image-data'], 'test-flyer.webp', { type: 'image/webp' });
    const progressHistory: Array<{ percent: number; state: string }> = [];

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/organizer/upload/sign')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                timestamp: 1700000000,
                folder: 'outside-vip/event-covers',
                signature: 'test-sig',
                uploadUrl: 'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
              },
            }),
        } as any);
      }

      if (typeof url === 'string' && url.includes('cloudinary.com')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1234/outside-vip/event-covers/test.webp',
              public_id: 'outside-vip/event-covers/test',
              format: 'webp',
              width: 1920,
              height: 1200,
            }),
        } as any);
      }

      return Promise.resolve({ ok: false } as any);
    });

    const res = await uploadImageWithProgress(fakeFile, {
      onProgress: (p) => {
        progressHistory.push({ percent: p.percent, state: p.state });
      },
    });

    expect(res.secure_url).toContain('https://res.cloudinary.com/test-cloud/image/upload');
    expect(res.public_id).toBe('outside-vip/event-covers/test');
    expect(res.thumbnailUrl).toContain('/upload/c_fill,g_auto,w_600,h_400,q_auto,f_auto/');
    expect(progressHistory.length).toBeGreaterThan(0);
    expect(progressHistory[progressHistory.length - 1].state).toBe('processing');

    fetchSpy.mockRestore();
  });

  it('falls back to server upload if Cloudinary direct upload fails', async () => {
    const fakeFile = new File(['dummy-image-data'], 'test-flyer.webp', { type: 'image/webp' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/organizer/upload/sign')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                cloudName: 'test-cloud',
                apiKey: 'test-key',
                timestamp: 1700000000,
                folder: 'outside-vip/event-covers',
                signature: 'test-sig',
                uploadUrl: 'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
              },
            }),
        } as any);
      }

      if (typeof url === 'string' && url.includes('cloudinary.com')) {
        // Direct upload fails (e.g. CORS or Cloudinary outage)
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: { message: 'Cloudinary server error' } }),
        } as any);
      }

      if (typeof url === 'string' && url.includes('/organizer/upload')) {
        // Server fallback succeeds
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              data: {
                secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1234/outside-vip/event-covers/server-fallback.webp',
                public_id: 'outside-vip/event-covers/server-fallback',
                thumbnailUrl: 'https://res.cloudinary.com/test-cloud/image/upload/c_fill,g_auto,w_600,h_400,q_auto,f_auto/v1234/outside-vip/event-covers/server-fallback.webp',
              },
            }),
        } as any);
      }

      return Promise.resolve({ ok: false } as any);
    });

    const res = await api.organizer.uploadCoverImage(fakeFile);
    expect(res.secure_url).toContain('server-fallback.webp');
    expect(res.public_id).toBe('outside-vip/event-covers/server-fallback');

    fetchSpy.mockRestore();
  });
});
