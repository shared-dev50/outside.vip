import React from 'react';
import {
  RefreshCw,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  X,
  FileImage,
  Sparkles,
} from 'lucide-react';
import { formatBytes } from '../../lib/imageCrop';

export type UploadState =
  | 'idle'
  | 'uploading'
  | 'processing'
  | 'success'
  | 'error';

export interface UploadProgressInfo {
  state: UploadState;
  filename: string;
  fileSizeBytes?: number;
  previewUrl?: string;
  percent: number;
  loadedBytes: number;
  totalBytes: number;
  errorMessage?: string | null;
}

export interface UploadProgressCardProps {
  info: UploadProgressInfo;
  onRetry?: () => void;
  onCancel?: () => void;
  onDismiss?: () => void;
  title?: string;
}

export const UploadProgressCard: React.FC<UploadProgressCardProps> = ({
  info,
  onRetry,
  onCancel,
  onDismiss,
  title,
}) => {
  if (info.state === 'idle') return null;

  const isUploading = info.state === 'uploading';
  const isProcessing = info.state === 'processing';
  const isSuccess = info.state === 'success';
  const isError = info.state === 'error';

  return (
    <div
      role="region"
      aria-label="Upload Progress"
      className={`p-3.5 rounded-xl border transition-all duration-300 font-mono text-xs ${
        isUploading
          ? 'bg-[#FAF8F5] border-stone-300 shadow-xs'
          : isProcessing
          ? 'bg-amber-50/70 border-amber-300 shadow-xs'
          : isSuccess
          ? 'bg-emerald-50/80 border-emerald-300 shadow-xs'
          : 'bg-rose-50/80 border-rose-300 shadow-xs'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-stone-900 border border-stone-200 shrink-0 flex items-center justify-center">
          {info.previewUrl ? (
            <img
              src={info.previewUrl}
              alt={info.filename}
              className="w-full h-full object-cover"
            />
          ) : (
            <FileImage className="w-6 h-6 text-stone-400" />
          )}

          {isSuccess && (
            <div className="absolute inset-0 bg-emerald-950/30 flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-emerald-400 drop-shadow" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              {title && (
                <span className="text-[10px] uppercase font-bold text-stone-500 block">
                  {title}
                </span>
              )}
              <p className="font-bold text-stone-900 truncate text-xs" title={info.filename}>
                {info.filename}
              </p>
            </div>

            <div className="shrink-0 flex items-center gap-1.5">
              {isUploading && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-stone-900 text-brand-neon">
                  <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                  <span>{info.percent}%</span>
                </span>
              )}

              {isProcessing && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white animate-pulse">
                  <Sparkles className="w-2.5 h-2.5" />
                  <span>Processing</span>
                </span>
              )}

              {isSuccess && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-600 text-white">
                  <CheckCircle className="w-2.5 h-2.5" />
                  <span>Uploaded</span>
                </span>
              )}

              {isError && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white">
                  <AlertCircle className="w-2.5 h-2.5" />
                  <span>Failed</span>
                </span>
              )}

              {isUploading && onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  title="Cancel upload"
                  className="p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {(isSuccess || isError) && onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  title="Dismiss card"
                  className="p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="w-full h-1.5 rounded-full bg-stone-200 overflow-hidden">
            <div
              className={`h-full transition-all duration-200 ease-out ${
                isUploading
                  ? 'bg-stone-900'
                  : isProcessing
                  ? 'bg-amber-500 animate-pulse'
                  : isSuccess
                  ? 'bg-emerald-600'
                  : 'bg-rose-600'
              }`}
              style={{
                width: isProcessing || isSuccess ? '100%' : `${Math.max(2, info.percent)}%`,
              }}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-stone-600">
            {isUploading && (
              <span>
                {formatBytes(info.loadedBytes)} / {formatBytes(info.totalBytes || info.fileSizeBytes || 0)}
              </span>
            )}

            {isProcessing && (
              <span className="text-amber-800">
                Optimizing & storing on Cloudinary...
              </span>
            )}

            {isSuccess && (
              <span className="text-emerald-700 font-medium">
                Asset stored in Cloudinary ({formatBytes(info.totalBytes || info.fileSizeBytes || 0)})
              </span>
            )}

            {isError && (
              <span className="text-rose-700 truncate pr-2" title={info.errorMessage || 'Upload failed'}>
                {info.errorMessage || 'Upload failed. Please check network and retry.'}
              </span>
            )}

            {isError && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-2.5 py-1 rounded bg-stone-900 hover:bg-black text-white text-[10px] font-bold flex items-center gap-1 transition-colors shrink-0 shadow-xs"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Retry</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
