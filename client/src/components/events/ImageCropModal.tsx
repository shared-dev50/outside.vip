import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Check,
  Lock,
  Crop as CropIcon,
  Maximize2,
  Sparkles,
} from 'lucide-react';
import {
  CropAspectRatio,
  CROP_ASPECT_RATIOS,
  computeCropBounds,
  createCroppedImageFile,
  formatBytes,
} from '../../lib/imageCrop';

export interface ImageCropModalProps {
  isOpen: boolean;
  file: File | null;
  mode: 'cover' | 'gallery';
  title?: string;
  onCancel: () => void;
  onConfirm: (croppedFile: File, previewUrl: string) => void;
}

export const ImageCropModal: React.FC<ImageCropModalProps> = ({
  isOpen,
  file,
  mode,
  title,
  onCancel,
  onConfirm,
}) => {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [naturalHeight, setNaturalHeight] = useState(0);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [aspectRatio, setAspectRatio] = useState<CropAspectRatio>(
    mode === 'cover' ? '16:10' : '4:3'
  );

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [touchStartDist, setTouchStartDist] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Setup / teardown object URL and reset state when file changes
  useEffect(() => {
    if (!isOpen || !file) {
      setImageLoaded(false);
      setNaturalWidth(0);
      setNaturalHeight(0);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      return;
    }

    setZoom(1);
    setPan({ x: 0, y: 0 });
    setAspectRatio(mode === 'cover' ? '16:10' : '4:3');

    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;

    const img = new Image();
    img.src = url;
    img.onload = () => {
      imageElementRef.current = img;
      setNaturalWidth(img.naturalWidth);
      setNaturalHeight(img.naturalHeight);
      setImageLoaded(true);
    };
    img.onerror = () => {
      setImageLoaded(false);
    };

    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [isOpen, file, mode]);

  // Handle ESC key to dismiss without upload
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  // Canvas drawing loop
  useEffect(() => {
    if (!isOpen || !imageLoaded || !imageElementRef.current || !canvasRef.current || !containerRef.current) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const viewW = Math.max(300, Math.floor(rect.width));
    const viewH = Math.max(240, Math.floor(rect.height));

    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    const bounds = computeCropBounds({
      viewportWidth: viewW,
      viewportHeight: viewH,
      naturalWidth,
      naturalHeight,
      aspectRatio,
      zoom,
      panX: pan.x,
      panY: pan.y,
      maxOutputDimension: mode === 'cover' ? 1920 : 1600,
    });

    // 1. Fill backdrop
    ctx.fillStyle = '#0E1015';
    ctx.fillRect(0, 0, viewW, viewH);

    // Frame position in viewport
    const frameLeft = (viewW - bounds.frameWidth) / 2;
    const frameTop = (viewH - bounds.frameHeight) / 2;

    // 2. Draw image transformed inside viewport
    const imgLeft = frameLeft + (bounds.frameWidth - bounds.renderWidth) / 2 + bounds.clampedPanX;
    const imgTop = frameTop + (bounds.frameHeight - bounds.renderHeight) / 2 + bounds.clampedPanY;

    ctx.drawImage(
      imageElementRef.current,
      imgLeft,
      imgTop,
      bounds.renderWidth,
      bounds.renderHeight
    );

    // 3. Draw dark vignette outside the crop frame
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    // Top
    ctx.fillRect(0, 0, viewW, frameTop);
    // Bottom
    ctx.fillRect(0, frameTop + bounds.frameHeight, viewW, viewH - (frameTop + bounds.frameHeight));
    // Left
    ctx.fillRect(0, frameTop, frameLeft, bounds.frameHeight);
    // Right
    ctx.fillRect(
      frameLeft + bounds.frameWidth,
      frameTop,
      viewW - (frameLeft + bounds.frameWidth),
      bounds.frameHeight
    );

    // 4. Draw rule of thirds grid inside crop frame
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1;
    // Horizontal grid
    ctx.beginPath();
    ctx.moveTo(frameLeft, frameTop + bounds.frameHeight / 3);
    ctx.lineTo(frameLeft + bounds.frameWidth, frameTop + bounds.frameHeight / 3);
    ctx.moveTo(frameLeft, frameTop + (bounds.frameHeight * 2) / 3);
    ctx.lineTo(frameLeft + bounds.frameWidth, frameTop + (bounds.frameHeight * 2) / 3);
    // Vertical grid
    ctx.moveTo(frameLeft + bounds.frameWidth / 3, frameTop);
    ctx.lineTo(frameLeft + bounds.frameWidth / 3, frameTop + bounds.frameHeight);
    ctx.moveTo(frameLeft + (bounds.frameWidth * 2) / 3, frameTop);
    ctx.lineTo(frameLeft + (bounds.frameWidth * 2) / 3, frameTop + bounds.frameHeight);
    ctx.stroke();

    // 5. Draw crop frame boundary
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(frameLeft, frameTop, bounds.frameWidth, bounds.frameHeight);

    // 6. Draw distinct corner brackets
    const cornerSize = 16;
    ctx.strokeStyle = '#D2FF00'; // Outside.vip signature electric volt accent
    ctx.lineWidth = 3;

    // Top-Left
    ctx.beginPath();
    ctx.moveTo(frameLeft - 1, frameTop + cornerSize);
    ctx.lineTo(frameLeft - 1, frameTop - 1);
    ctx.lineTo(frameLeft + cornerSize, frameTop - 1);
    ctx.stroke();

    // Top-Right
    ctx.beginPath();
    ctx.moveTo(frameLeft + bounds.frameWidth - cornerSize, frameTop - 1);
    ctx.lineTo(frameLeft + bounds.frameWidth + 1, frameTop - 1);
    ctx.lineTo(frameLeft + bounds.frameWidth + 1, frameTop + cornerSize);
    ctx.stroke();

    // Bottom-Left
    ctx.beginPath();
    ctx.moveTo(frameLeft - 1, frameTop + bounds.frameHeight - cornerSize);
    ctx.lineTo(frameLeft - 1, frameTop + bounds.frameHeight + 1);
    ctx.lineTo(frameLeft + cornerSize, frameTop + bounds.frameHeight + 1);
    ctx.stroke();

    // Bottom-Right
    ctx.beginPath();
    ctx.moveTo(frameLeft + bounds.frameWidth - cornerSize, frameTop + bounds.frameHeight + 1);
    ctx.lineTo(frameLeft + bounds.frameWidth + 1, frameTop + bounds.frameHeight + 1);
    ctx.lineTo(frameLeft + bounds.frameWidth + 1, frameTop + bounds.frameHeight - cornerSize);
    ctx.stroke();

    ctx.restore();

    // Update real-time live preview thumbnail canvas
    if (previewCanvasRef.current && imageElementRef.current) {
      const prevCanvas = previewCanvasRef.current;
      const prevCtx = prevCanvas.getContext('2d');
      if (prevCtx) {
        prevCtx.imageSmoothingEnabled = true;
        prevCtx.imageSmoothingQuality = 'high';
        prevCtx.clearRect(0, 0, prevCanvas.width, prevCanvas.height);
        prevCtx.drawImage(
          imageElementRef.current,
          bounds.sourceCropX,
          bounds.sourceCropY,
          bounds.sourceCropWidth,
          bounds.sourceCropHeight,
          0,
          0,
          prevCanvas.width,
          prevCanvas.height
        );
      }
    }
  }, [isOpen, imageLoaded, naturalWidth, naturalHeight, aspectRatio, zoom, pan, mode]);

  // Mouse drag handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Wheel zoom handler
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.08 : -0.08;
    setZoom((prev) => Math.max(1, Math.min(3, +(prev + delta).toFixed(2))));
  };

  // Touch handlers
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      setIsDragging(true);
      setDragStart({
        x: e.touches[0].clientX - pan.x,
        y: e.touches[0].clientY - pan.y,
      });
      setTouchStartDist(null);
    } else if (e.touches.length === 2) {
      setIsDragging(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      setTouchStartDist(Math.hypot(dx, dy));
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1 && isDragging) {
      setPan({
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y,
      });
    } else if (e.touches.length === 2 && touchStartDist !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDist = Math.hypot(dx, dy);
      const factor = newDist / touchStartDist;
      setZoom((prev) => Math.max(1, Math.min(3, +(prev * factor).toFixed(2))));
      setTouchStartDist(newDist);
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    setTouchStartDist(null);
  };

  const resetFrame = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Execute high-resolution client crop and trigger confirmation
  const handleConfirm = async () => {
    if (!imageElementRef.current || !file || isProcessing) return;

    try {
      setIsProcessing(true);

      const container = containerRef.current;
      const rect = container?.getBoundingClientRect();
      const viewW = Math.max(300, Math.floor(rect?.width || 500));
      const viewH = Math.max(240, Math.floor(rect?.height || 340));

      const bounds = computeCropBounds({
        viewportWidth: viewW,
        viewportHeight: viewH,
        naturalWidth,
        naturalHeight,
        aspectRatio,
        zoom,
        panX: pan.x,
        panY: pan.y,
        maxOutputDimension: mode === 'cover' ? 1920 : 1600,
      });

      const cropped = await createCroppedImageFile({
        imageElement: imageElementRef.current,
        sourceCropX: bounds.sourceCropX,
        sourceCropY: bounds.sourceCropY,
        sourceCropWidth: bounds.sourceCropWidth,
        sourceCropHeight: bounds.sourceCropHeight,
        outputWidth: bounds.outputWidth,
        outputHeight: bounds.outputHeight,
        originalFileName: file.name,
        quality: 0.88,
      });

      onConfirm(cropped.file, cropped.previewUrl);
    } catch (err) {
      console.error('Failed to crop image:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  const modalTitle =
    title || (mode === 'cover' ? 'Crop & Frame Cover Artwork' : 'Crop Gallery Photo');

  // Preview dimensions helper
  const previewRatio = mode === 'cover' ? 1.6 : aspectRatio === 'free' ? (naturalWidth / naturalHeight || 1.33) : (aspectRatio === '16:9' ? 16/9 : aspectRatio === '1:1' ? 1 : 4/3);
  const previewBoxW = 120;
  const previewBoxH = Math.round(previewBoxW / previewRatio);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-fadeIn"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-3xl rounded-2xl bg-stone-900 border border-stone-800 text-stone-100 shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-800 bg-stone-950/40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-stone-800 border border-stone-700 flex items-center justify-center text-brand-neon">
              <CropIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-display font-black uppercase tracking-tight text-white flex items-center gap-2">
                <span>{modalTitle}</span>
                {mode === 'cover' ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30 flex items-center gap-1 font-semibold">
                    <Lock className="w-2.5 h-2.5" /> 16:10 Ratio
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-stone-800 text-stone-300 border border-stone-700">
                    Gallery Crop
                  </span>
                )}
              </h2>
              <p className="text-xs text-stone-400 font-sans mt-0.5">
                Drag to reposition. Zoom to compose. Compressed client-side before uploading.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel crop"
            className="p-1.5 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewport & Controls */}
        <div className="flex-1 flex flex-col p-4 sm:p-5 gap-4 overflow-y-auto">
          {/* Canvas Viewport */}
          <div
            ref={containerRef}
            className="relative w-full h-[320px] sm:h-[380px] rounded-xl overflow-hidden bg-stone-950 border border-stone-800 flex items-center justify-center select-none shadow-inner"
          >
            {!imageLoaded ? (
              <div className="flex flex-col items-center gap-2 text-stone-500">
                <RotateCcw className="w-5 h-5 animate-spin" />
                <span className="text-xs font-mono">Loading image preview...</span>
              </div>
            ) : (
              <canvas
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                className={`w-full h-full block ${
                  isDragging ? 'cursor-grabbing' : 'cursor-grab'
                } touch-none`}
              />
            )}

            {/* Viewport Overlay Controls */}
            <div className="absolute bottom-3 left-3 px-2.5 py-1 rounded-md bg-black/75 backdrop-blur-md text-[11px] font-mono text-stone-300 border border-white/10 flex items-center gap-2 pointer-events-none">
              <span>{naturalWidth} × {naturalHeight} px</span>
              <span className="text-stone-600">•</span>
              <span>{file ? formatBytes(file.size) : ''}</span>
            </div>

            <button
              type="button"
              onClick={resetFrame}
              title="Reset frame centering"
              className="absolute bottom-3 right-3 px-2.5 py-1 rounded-md bg-black/75 hover:bg-stone-800 text-[11px] font-mono text-stone-300 hover:text-white border border-white/10 flex items-center gap-1.5 shadow-sm transition-colors"
            >
              <Maximize2 className="w-3 h-3" />
              <span>Center</span>
            </button>
          </div>

          {/* Configuration Toolbar */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5 items-center bg-stone-950/60 p-3.5 rounded-xl border border-stone-800/80">
            {/* Left: Aspect Ratio Controls */}
            <div className="md:col-span-5 flex flex-col gap-1.5">
              <span className="text-[11px] font-mono uppercase tracking-wider text-stone-400 font-bold">
                {mode === 'cover' ? 'Aspect Ratio (Fixed 16:10)' : 'Aspect Ratio Preset'}
              </span>

              {mode === 'cover' ? (
                <div className="text-xs font-mono text-stone-300 bg-stone-900 px-3 py-2 rounded-lg border border-stone-800 flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>16:10 Widescreen (Outside.vip flyer standard)</span>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {CROP_ASPECT_RATIOS.filter((r) => r.id !== '16:10').map((ratio) => (
                    <button
                      key={ratio.id}
                      type="button"
                      onClick={() => {
                        setAspectRatio(ratio.id);
                        setPan({ x: 0, y: 0 });
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-medium transition-colors border ${
                        aspectRatio === ratio.id
                          ? 'bg-stone-100 text-stone-950 border-white font-bold shadow-xs'
                          : 'bg-stone-900 text-stone-400 border-stone-800 hover:text-stone-200 hover:bg-stone-850'
                      }`}
                    >
                      {ratio.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Middle: Zoom Controls */}
            <div className="md:col-span-4 flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11px] font-mono text-stone-400">
                <span className="uppercase tracking-wider font-bold">Zoom Level</span>
                <span className="text-brand-neon font-bold">{Math.round(zoom * 100)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(1, +(z - 0.1).toFixed(2)))}
                  disabled={zoom <= 1}
                  className="w-7 h-7 rounded bg-stone-900 hover:bg-stone-800 border border-stone-800 text-stone-300 flex items-center justify-center disabled:opacity-40 transition-colors"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.05"
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="flex-1 accent-[#D2FF00] h-1.5 bg-stone-800 rounded-lg cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(3, +(z + 0.1).toFixed(2)))}
                  disabled={zoom >= 3}
                  className="w-7 h-7 rounded bg-stone-900 hover:bg-stone-800 border border-stone-800 text-stone-300 flex items-center justify-center disabled:opacity-40 transition-colors"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Right: Live Preview Box */}
            <div className="md:col-span-3 flex items-center gap-2.5 pl-0 md:pl-2 border-t md:border-t-0 md:border-l border-stone-800/80 pt-2.5 md:pt-0">
              <div
                style={{ width: previewBoxW, height: previewBoxH }}
                className="rounded-lg overflow-hidden bg-stone-900 border border-stone-700/80 shrink-0 shadow-xs relative"
              >
                <canvas
                  ref={previewCanvasRef}
                  width={previewBoxW}
                  height={previewBoxH}
                  className="w-full h-full block object-cover"
                />
              </div>
              <div className="text-[10px] font-mono text-stone-400 space-y-0.5">
                <span className="block font-bold text-stone-200">Live Preview</span>
                <span className="block text-emerald-400 flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" /> Client WebP
                </span>
                <span className="block text-stone-500">Max 1920px</span>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3.5 border-t border-stone-800 bg-stone-950/60 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] font-mono text-stone-500 hidden sm:block">
            Scroll or pinch to zoom • Drag to center framing
          </p>
          <div className="flex items-center gap-2.5 ml-auto">
            <button
              type="button"
              onClick={onCancel}
              disabled={isProcessing}
              className="px-4 py-2 rounded-xl text-xs font-mono font-medium text-stone-300 hover:text-white bg-stone-850 hover:bg-stone-800 border border-stone-700/60 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!imageLoaded || isProcessing}
              className="px-4 py-2 rounded-xl text-xs font-mono font-bold text-black bg-brand-neon hover:bg-brand-neon-hover shadow-neon-sm flex items-center gap-2 transition-all disabled:opacity-50 disabled:shadow-none"
            >
              {isProcessing ? (
                <>
                  <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                  <span>Optimizing...</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Confirm Crop & Upload</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
