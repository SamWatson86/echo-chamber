type SdpDirection = 'offer' | 'local' | 'remote';

export type SdpHintOptions = {
  bandwidthKbps?: number;
  h264MinLevelHex?: string;
  h264UpgradeProfiles?: string[];
  startBitrateKbps?: number;
  minBitrateKbps?: number;
  maxBitrateKbps?: number;
};

const DEFAULTS: Required<SdpHintOptions> = {
  bandwidthKbps: 25_000,
  h264MinLevelHex: '33',
  h264UpgradeProfiles: ['42e0', '42c0', '4200', '4d00'],
  startBitrateKbps: 10_000,
  minBitrateKbps: 5_000,
  maxBitrateKbps: 25_000,
};

const INSTALL_FLAG = '__echoViewerNextSdpHintsInstalled';

function clampBitrateKbps(value: number | undefined, fallback: number): number {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(250, Math.min(100_000, Math.round(candidate)));
}

function withDefaults(options?: SdpHintOptions): Required<SdpHintOptions> {
  const bandwidthKbps = clampBitrateKbps(options?.bandwidthKbps, DEFAULTS.bandwidthKbps);
  const startBitrateKbps = clampBitrateKbps(options?.startBitrateKbps, DEFAULTS.startBitrateKbps);
  const minBitrateKbps = clampBitrateKbps(options?.minBitrateKbps, DEFAULTS.minBitrateKbps);
  const maxBitrateKbps = clampBitrateKbps(options?.maxBitrateKbps, DEFAULTS.maxBitrateKbps);

  return {
    ...DEFAULTS,
    ...options,
    bandwidthKbps,
    startBitrateKbps,
    minBitrateKbps: Math.min(minBitrateKbps, maxBitrateKbps),
    maxBitrateKbps,
    h264UpgradeProfiles: (options?.h264UpgradeProfiles || DEFAULTS.h264UpgradeProfiles).map((profile) =>
      profile.toLowerCase(),
    ),
  };
}

export function mungeVideoBandwidth(sdp: string, bandwidthKbps: number): string {
  if (!sdp.includes('m=video')) return sdp;

  const asKbps = clampBitrateKbps(bandwidthKbps, DEFAULTS.bandwidthKbps);
  const tias = asKbps * 1000;
  const lines = sdp.split('\r\n');
  const out: string[] = [];

  let inVideo = false;
  let inserted = false;

  lines.forEach((line) => {
    if (line.startsWith('m=video')) {
      inVideo = true;
      inserted = false;
      out.push(line);
      return;
    }

    if (line.startsWith('m=')) {
      inVideo = false;
      out.push(line);
      return;
    }

    if (inVideo && (line.startsWith('b=AS:') || line.startsWith('b=TIAS:'))) {
      return;
    }

    out.push(line);

    if (inVideo && line.startsWith('c=') && !inserted) {
      out.push(`b=AS:${asKbps}`);
      out.push(`b=TIAS:${tias}`);
      inserted = true;
    }
  });

  return out.join('\r\n');
}

function ensureCodecHints(line: string, options: Required<SdpHintOptions>): string {
  if (line.includes('x-google-start-bitrate=')) return line;
  const hints = `x-google-start-bitrate=${options.startBitrateKbps};x-google-min-bitrate=${options.minBitrateKbps};x-google-max-bitrate=${options.maxBitrateKbps}`;
  return `${line};${hints}`;
}

export function addCodecBitrateHints(sdp: string, options?: SdpHintOptions): string {
  const merged = withDefaults(options);
  const rtpmapPattern = /^a=rtpmap:(\d+) (H264|VP8|VP9)\/90000$/i;
  const lines = sdp.split('\r\n');
  const payloads = new Set<string>();

  lines.forEach((line) => {
    const match = line.match(rtpmapPattern);
    if (match) payloads.add(match[1]);
  });

  if (!payloads.size) return sdp;

  return lines
    .map((line) => {
      const match = line.match(/^a=fmtp:(\d+)\s+/i);
      if (!match) return line;
      if (!payloads.has(match[1])) return line;
      return ensureCodecHints(line, merged);
    })
    .join('\r\n');
}

export function upgradeH264ProfileLevel(
  sdp: string,
  direction: SdpDirection,
  options?: SdpHintOptions,
): string {
  const merged = withDefaults(options);
  const targetLevel = merged.h264MinLevelHex.toLowerCase();
  const upgradeProfiles = new Set(merged.h264UpgradeProfiles.map((item) => item.toLowerCase()));

  return sdp.replace(
    /profile-level-id=([0-9a-fA-F]{4})([0-9a-fA-F]{2})/g,
    (_full, profileRaw: string, levelRaw: string) => {
      const profile = profileRaw.toLowerCase();
      const level = levelRaw.toLowerCase();
      const levelInt = Number.parseInt(level, 16);
      const targetLevelInt = Number.parseInt(targetLevel, 16);
      const nextLevel = Number.isFinite(levelInt) && levelInt >= targetLevelInt ? level : targetLevel;

      if (direction === 'remote') {
        return `profile-level-id=${profileRaw}${nextLevel}`;
      }

      const nextProfile = upgradeProfiles.has(profile) ? '6400' : profileRaw;
      return `profile-level-id=${nextProfile}${nextLevel}`;
    },
  );
}

export function mungeSdpWithParityHints(
  sdp: string,
  direction: SdpDirection,
  options?: SdpHintOptions,
): string {
  if (!sdp || !sdp.includes('m=video')) return sdp;

  const merged = withDefaults(options);
  const withBandwidth = mungeVideoBandwidth(sdp, merged.bandwidthKbps);
  const withCodecHints = addCodecBitrateHints(withBandwidth, merged);
  return upgradeH264ProfileLevel(withCodecHints, direction, merged);
}

function copyDescriptionWithMungedSdp<T extends { type: string; sdp?: string | null }>(
  desc: T,
  direction: SdpDirection,
  options?: SdpHintOptions,
): T {
  if (!desc?.sdp) return desc;
  const munged = mungeSdpWithParityHints(desc.sdp, direction, options);
  return { ...desc, sdp: munged };
}

export function installSdpCodecHintParity(options?: SdpHintOptions): void {
  const globalAny = globalThis as Record<string, unknown>;
  if (globalAny[INSTALL_FLAG]) return;

  const peerConnectionCtor = globalAny.RTCPeerConnection as
    | (new (...args: any[]) => RTCPeerConnection)
    | undefined;

  if (!peerConnectionCtor?.prototype) return;

  const proto = peerConnectionCtor.prototype as {
    createOffer?: (...args: any[]) => Promise<any>;
    setLocalDescription?: (...args: any[]) => Promise<any>;
    setRemoteDescription?: (...args: any[]) => Promise<any>;
    __echoOrigCreateOffer?: (...args: any[]) => Promise<any>;
    __echoOrigSetLocalDescription?: (...args: any[]) => Promise<any>;
    __echoOrigSetRemoteDescription?: (...args: any[]) => Promise<any>;
  };

  if (typeof proto.createOffer === 'function' && !proto.__echoOrigCreateOffer) {
    proto.__echoOrigCreateOffer = proto.createOffer;
    proto.createOffer = async function patchedCreateOffer(...args: any[]) {
      const offer = await proto.__echoOrigCreateOffer!.apply(this, args);
      if (!offer || typeof offer !== 'object' || !offer.sdp) return offer;
      return {
        ...offer,
        sdp: mungeSdpWithParityHints(String(offer.sdp), 'offer', options),
      };
    };
  }

  if (typeof proto.setLocalDescription === 'function' && !proto.__echoOrigSetLocalDescription) {
    proto.__echoOrigSetLocalDescription = proto.setLocalDescription;
    proto.setLocalDescription = function patchedSetLocalDescription(description?: any, ...rest: any[]) {
      const mungedDescription = description?.sdp
        ? copyDescriptionWithMungedSdp(description as { type: string; sdp?: string | null }, 'local', options)
        : description;
      return proto.__echoOrigSetLocalDescription!.apply(this, [mungedDescription, ...rest]);
    };
  }

  if (typeof proto.setRemoteDescription === 'function' && !proto.__echoOrigSetRemoteDescription) {
    proto.__echoOrigSetRemoteDescription = proto.setRemoteDescription;
    proto.setRemoteDescription = function patchedSetRemoteDescription(description?: any, ...rest: any[]) {
      const mungedDescription = description?.sdp
        ? copyDescriptionWithMungedSdp(description as { type: string; sdp?: string | null }, 'remote', options)
        : description;
      return proto.__echoOrigSetRemoteDescription!.apply(this, [mungedDescription, ...rest]);
    };
  }

  globalAny[INSTALL_FLAG] = true;
}
