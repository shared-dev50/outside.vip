export function extractYouTubeVideoId(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  const watchMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/i);
  if (watchMatch?.[1]) return watchMatch[1];

  const shortMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/i);
  if (shortMatch?.[1]) return shortMatch[1];

  const embedMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/i);
  if (embedMatch?.[1]) return embedMatch[1];

  const shortsMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i);
  if (shortsMatch?.[1]) return shortsMatch[1];

  const vMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/i);
  if (vMatch?.[1]) return vMatch[1];

  return null;
}

export function getYouTubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1&autoplay=0`;
}
