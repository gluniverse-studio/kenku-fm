import { PreviewItem } from "../../../types/preview";

export type PromotePlan =
  | { type: "none" }
  | { type: "seek-and-resume-live-track"; position: number }
  | { type: "resume-live-track" }
  | { type: "play-track"; trackId: string; playlistId: string; startAt: number }
  | { type: "play-sound"; soundId: string };

/**
 * Whether a stored URL can be auditioned in GM-only preview.
 * Only local `file://` items are previewable so the unsandboxed Audio Capture
 * window never fetches third-party remote audio.
 */
export function isPreviewableUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("file://");
}

/**
 * Compute the preview timestamp to carry over when promoting a playlist track
 * to live. Returns 0 when the preview has ended, is under 1 s in, or is within
 * 1 s of the end.
 */
export function computePromoteStartAt(
  progress: number,
  duration: number,
  ended: boolean,
): number {
  if (ended || !Number.isFinite(progress) || progress < 1) {
    return 0;
  }
  if (Number.isFinite(duration) && duration > 0 && progress >= duration - 1) {
    return 0;
  }
  return progress;
}

/**
 * Decide what promoting the active preview item to live should do.
 *
 * When the previewed track is already playing live and `startAt === 0`, we do
 * NOT seek back to 0:00 (which would unexpectedly restart the table's music);
 * we only un-pause if live playback is paused.
 */
export function planPromoteToLive(params: {
  item: PreviewItem | null;
  progress: number;
  duration: number;
  ended: boolean;
  liveTrackId?: string;
  liveHasPlayback: boolean;
  livePlaying: boolean;
}): PromotePlan {
  const {
    item,
    progress,
    duration,
    ended,
    liveTrackId,
    liveHasPlayback,
    livePlaying,
  } = params;
  if (!item) {
    return { type: "none" };
  }
  if (item.kind === "sound") {
    return { type: "play-sound", soundId: item.id };
  }

  const startAt = computePromoteStartAt(progress, duration, ended);
  if (liveTrackId === item.id && liveHasPlayback) {
    if (startAt > 0) {
      return { type: "seek-and-resume-live-track", position: Math.floor(startAt) };
    }
    return livePlaying ? { type: "none" } : { type: "resume-live-track" };
  }

  return {
    type: "play-track",
    trackId: item.id,
    playlistId: item.parentId,
    startAt,
  };
}
