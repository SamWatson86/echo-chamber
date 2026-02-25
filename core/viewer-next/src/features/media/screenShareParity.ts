export const BITRATE_DEFAULT_HIGH = 15_000_000;
export const BITRATE_DEFAULT_MED = 5_000_000;
export const BITRATE_DEFAULT_LOW = 1_500_000;

export const DEFAULT_MAX_CANVAS_WIDTH = 1920;
export const DEFAULT_MAX_CANVAS_PIXELS = 2_100_000;

export type ResolutionCapResult = {
  width: number;
  height: number;
  scaled: boolean;
  scale: number;
};

export type ResolutionCapOptions = {
  maxWidth?: number;
  maxPixels?: number;
};

export function capCanvasResolution(
  width: number,
  height: number,
  options: ResolutionCapOptions = {},
): ResolutionCapResult {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_CANVAS_WIDTH;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_CANVAS_PIXELS;

  const safeWidth = Math.max(2, Math.round(width || 1920));
  const safeHeight = Math.max(2, Math.round(height || 1080));
  const pixels = safeWidth * safeHeight;

  if (safeWidth <= maxWidth && pixels <= maxPixels) {
    return { width: safeWidth - (safeWidth % 2), height: safeHeight - (safeHeight % 2), scaled: false, scale: 1 };
  }

  const scale = Math.min(maxWidth / safeWidth, Math.sqrt(maxPixels / pixels));
  const nextWidth = Math.max(2, Math.round(safeWidth * scale));
  const nextHeight = Math.max(2, Math.round(safeHeight * scale));

  return {
    width: nextWidth - (nextWidth % 2),
    height: nextHeight - (nextHeight % 2),
    scaled: true,
    scale,
  };
}

export function buildScreenSharePublishOptions(sourceWidth: number, sourceHeight: number) {
  const highWidth = Math.max(2, sourceWidth - (sourceWidth % 2));
  const highHeight = Math.max(2, sourceHeight - (sourceHeight % 2));

  const medWidth = Math.max(2, Math.round(highWidth / 2) - (Math.round(highWidth / 2) % 2));
  const medHeight = Math.max(2, Math.round(highHeight / 2) - (Math.round(highHeight / 2) % 2));

  const lowWidth = Math.max(2, Math.round(highWidth / 3) - (Math.round(highWidth / 3) % 2));
  const lowHeight = Math.max(2, Math.round(highHeight / 3) - (Math.round(highHeight / 3) % 2));

  return {
    videoCodec: 'h264',
    simulcast: true,
    screenShareEncoding: { maxBitrate: BITRATE_DEFAULT_HIGH, maxFramerate: 60 },
    screenShareSimulcastLayers: [
      { width: medWidth, height: medHeight, encoding: { maxBitrate: BITRATE_DEFAULT_MED, maxFramerate: 60 } },
      { width: lowWidth, height: lowHeight, encoding: { maxBitrate: BITRATE_DEFAULT_LOW, maxFramerate: 30 } },
    ],
    degradationPreference: 'maintain-framerate' as const,
  };
}

export const SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS = {
  dtx: false,
  red: false,
  audioBitrate: 128_000,
} as const;

export type CanvasScreenSharePipeline = {
  publishTrack: MediaStreamTrack;
  sourceTrack: MediaStreamTrack;
  width: number;
  height: number;
  stop: () => void;
};

export type CanvasPipelineDeps = {
  documentLike?: Document;
  windowLike?: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'setInterval' | 'clearInterval'>;
  workerFactory?: (source: string) => Worker;
  logger?: (message: string) => void;
};

function readTrackDimensions(sourceTrack: MediaStreamTrack): { width: number; height: number } {
  const settings = sourceTrack.getSettings?.() ?? {};
  const width = Number(settings.width ?? 1920);
  const height = Number(settings.height ?? 1080);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1920,
    height: Number.isFinite(height) && height > 0 ? height : 1080,
  };
}

export function createCanvasScreenSharePipeline(
  sourceTrack: MediaStreamTrack,
  deps: CanvasPipelineDeps = {},
): CanvasScreenSharePipeline {
  const documentLike = deps.documentLike ?? document;
  const windowLike = deps.windowLike ?? window;
  const logger = deps.logger;

  const { width: rawWidth, height: rawHeight } = readTrackDimensions(sourceTrack);
  let capped = capCanvasResolution(rawWidth, rawHeight);

  const canvas = documentLike.createElement('canvas');
  canvas.width = capped.width;
  canvas.height = capped.height;
  canvas.style.display = 'none';
  documentLike.body?.appendChild(canvas);

  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!context) {
    canvas.remove();
    throw new Error('Canvas pipeline unavailable: 2d context not available');
  }

  const captureStream = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
  if (typeof captureStream !== 'function') {
    canvas.remove();
    throw new Error('Canvas pipeline unavailable: captureStream unsupported');
  }

  const capture = captureStream.call(canvas, 60);
  const publishTrack = capture.getVideoTracks()[0];
  if (!publishTrack) {
    canvas.remove();
    throw new Error('Canvas pipeline unavailable: no captured video track');
  }

  const offVideo = documentLike.createElement('video');
  offVideo.srcObject = new MediaStream([sourceTrack]);
  offVideo.muted = true;
  (offVideo as HTMLVideoElement).playsInline = true;

  let active = true;
  let rafId: number | null = null;
  let workerTimer: Worker | null = null;

  const resizeFromVideo = () => {
    const nextWidth = Number(offVideo.videoWidth || 0);
    const nextHeight = Number(offVideo.videoHeight || 0);
    if (nextWidth <= 0 || nextHeight <= 0) return;

    const nextCap = capCanvasResolution(nextWidth, nextHeight);
    if (nextCap.width === canvas.width && nextCap.height === canvas.height) return;

    capped = nextCap;
    canvas.width = capped.width;
    canvas.height = capped.height;
    logger?.(`[canvas-pipe] resize ${nextWidth}x${nextHeight} -> ${capped.width}x${capped.height}`);
  };

  let frameCount = 0;
  const drawFrame = () => {
    if (!active) return;
    if (offVideo.readyState >= 2 && offVideo.videoWidth > 0 && offVideo.videoHeight > 0) {
      if (frameCount > 0 && frameCount % 30 === 0) {
        resizeFromVideo();
      }
      context.drawImage(offVideo, 0, 0, canvas.width, canvas.height);
      frameCount += 1;
    }
    rafId = windowLike.requestAnimationFrame(drawFrame);
  };

  const startDrawLoops = () => {
    if (!active) return;
    if (rafId == null) {
      rafId = windowLike.requestAnimationFrame(drawFrame);
    }

    if (!workerTimer && typeof Worker !== 'undefined') {
      const script =
        "var t=null;onmessage=function(e){if(e.data==='stop'){if(t){clearInterval(t);}return;}t=setInterval(function(){postMessage('tick');},e.data||16);};";
      workerTimer = deps.workerFactory
        ? deps.workerFactory(script)
        : new Worker(URL.createObjectURL(new Blob([script], { type: 'application/javascript' })));
      workerTimer.onmessage = () => {
        if (!active) return;
        if (offVideo.readyState >= 2 && offVideo.videoWidth > 0 && offVideo.videoHeight > 0) {
          context.drawImage(offVideo, 0, 0, canvas.width, canvas.height);
          frameCount += 1;
        }
      };
      workerTimer.postMessage(1000 / 60);
    }
  };

  const onLoadedData = () => startDrawLoops();
  const onResize = () => resizeFromVideo();
  offVideo.addEventListener('loadeddata', onLoadedData);
  offVideo.addEventListener('resize', onResize);

  void offVideo
    .play()
    .then(() => startDrawLoops())
    .catch((error) => {
      logger?.(`[canvas-pipe] offVideo.play failed: ${(error as Error).message}`);
    });

  if (offVideo.readyState >= 2) {
    startDrawLoops();
  }

  const stop = () => {
    if (!active) return;
    active = false;

    if (rafId != null) {
      windowLike.cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (workerTimer) {
      try {
        workerTimer.postMessage('stop');
        workerTimer.terminate();
      } catch {
        // best effort cleanup
      }
      workerTimer = null;
    }

    offVideo.removeEventListener('loadeddata', onLoadedData);
    offVideo.removeEventListener('resize', onResize);
    try {
      offVideo.pause();
    } catch {
      // ignore pause errors
    }
    offVideo.srcObject = null;

    try {
      publishTrack.stop();
    } catch {
      // ignore
    }

    canvas.remove();
  };

  return {
    publishTrack,
    sourceTrack,
    width: capped.width,
    height: capped.height,
    stop,
  };
}
