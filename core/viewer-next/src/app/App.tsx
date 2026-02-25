import {
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  LocalAudioTrack,
  LocalParticipant,
  LocalVideoTrack,
  Participant,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type LocalTrack,
  type TrackPublication,
} from 'livekit-client';
import { useActorRef, useSelector } from '@xstate/react';
import { connectionMachine } from '@/features/connection/connectionMachine';
import { useViewerPrefsStore } from '@/stores/viewerPrefsStore';
import { useOnlineUsersQuery } from '@/features/connection/useOnlineUsersQuery';
import { useRoomStatusQuery } from '@/features/connection/useRoomStatusQuery';
import type { RoomStatusParticipant } from '@/lib/api';
import {
  BITRATE_DEFAULT_HIGH,
  BITRATE_DEFAULT_LOW,
  BITRATE_DEFAULT_MED,
  SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS,
  buildScreenSharePublishOptions,
  createCanvasScreenSharePipeline,
} from '@/features/media/screenShareParity';
import {
  PublisherBitrateCapManager,
  ReceiverAimdController,
  type BitrateCapMessage,
} from '@/features/media/aimdBitrateControl';
import { BweWatchdog, applyBweActionToSender } from '@/features/media/bweWatchdog';
import { RnnoiseMicProcessor, type RnnoiseSuppressionLevel } from '@/features/media/rnnoiseParity';
import { ParticipantVolumeBoostManager } from '@/features/media/participantVolumeBoost';
import {
  buildSoundboardBroadcastPayloads,
  formatSoundboardHint,
  parseSoundboardPlayMessage,
  sortSoundboardByOrder,
} from '@/features/media/soundboardParity';
import { ensureLocalDeviceId, resolveChimeIdentity } from '@/features/media/deviceProfileParity';
import { migrateLegacyViewerPreferences } from '@/features/media/legacyPreferenceMigration';
import { installSdpCodecHintParity } from '@/features/media/sdpCodecHintParity';
import { CameraRecoveryMonitor } from '@/features/media/cameraRecoveryParity';

const FIXED_ROOMS = ['main', 'breakout-1', 'breakout-2', 'breakout-3'] as const;
const ROOM_DISPLAY_NAMES: Record<(typeof FIXED_ROOMS)[number], string> = {
  main: 'Main',
  'breakout-1': 'Breakout 1',
  'breakout-2': 'Breakout 2',
  'breakout-3': 'Breakout 3',
};

const THEME_STORAGE_KEY = 'echo-core-theme';
const UI_OPACITY_KEY = 'echo-core-ui-opacity';
const CHAT_MESSAGE_TYPE = 'chat-message';
const CHAT_FILE_TYPE = 'chat-file';
const RNNOISE_ENABLED_KEY = 'echo-noise-cancel-enabled';
const RNNOISE_LEVEL_KEY = 'echo-noise-cancel-level';
const PARTICIPANT_VOLUME_STORAGE_KEY = 'echo-participant-volumes';
const SOUNDBOARD_CLIP_VOLUME_STORAGE_KEY = 'echo-soundboard-clip-volume';
const SOUNDBOARD_ORDER_STORAGE_KEY = 'echo-core-soundboard-order';

const THEMES = [
  { id: 'frost', label: 'Frost', previewClass: 'frost-preview' },
  { id: 'cyberpunk', label: 'Cyberpunk', previewClass: 'cyberpunk-preview' },
  { id: 'aurora', label: 'Aurora', previewClass: 'aurora-preview' },
  { id: 'ember', label: 'Ember', previewClass: 'ember-preview' },
  { id: 'matrix', label: 'Matrix', previewClass: 'matrix-preview' },
  { id: 'midnight', label: 'Midnight', previewClass: 'midnight-preview' },
  { id: 'ultra-instinct', label: 'Ultra Instinct', previewClass: 'ultra-instinct-preview' },
] as const;

const EMOJI_LIST = [
  '😀',
  '😂',
  '🔥',
  '👏',
  '🎉',
  '👀',
  '🫡',
  '🤝',
  '🎧',
  '🛶',
  '💯',
  '✅',
  '🥶',
  '🎺',
  '🔊',
  '🤖',
] as const;

const SOUNDBOARD_ICONS = [
  '🔊',
  '😂',
  '🔥',
  '👏',
  '🎉',
  '👀',
  '💯',
  '✅',
  '🎺',
  '🤖',
  '🎧',
] as const;

type SoundboardSound = {
  id: string;
  name: string;
  icon: string;
  volume: number;
  favorite: boolean;
};

type ChatMessage = {
  id: string;
  type: typeof CHAT_MESSAGE_TYPE | typeof CHAT_FILE_TYPE;
  identity: string;
  name: string;
  text: string;
  timestamp: number;
  room: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
};

type ParticipantView = {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micTrack: LocalTrack | RemoteTrack | null;
  cameraTrack: LocalTrack | RemoteTrack | null;
  cameraPublication?: TrackPublication;
  screenTrack: LocalTrack | RemoteTrack | null;
  screenAudioTrack: LocalTrack | RemoteTrack | null;
};

type JamTrack = {
  spotify_uri: string;
  name: string;
  artist: string;
  album_art_url: string;
  duration_ms: number;
  added_by: string;
};

type JamState = {
  active: boolean;
  host_identity: string;
  queue: JamTrack[];
  now_playing: {
    name: string;
    artist: string;
    album_art_url: string;
    duration_ms: number;
    progress_ms: number;
    is_playing: boolean;
  } | null;
  listeners: string[];
  listener_count: number;
  spotify_connected: boolean;
  bot_connected: boolean;
};

type DebugEntry = {
  id: number;
  text: string;
};

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type AdminDashboardParticipant = {
  identity: string;
  name?: string;
  online_seconds?: number;
  viewer_version?: string;
  stats?: {
    ice_remote_type?: string;
    screen_fps?: number;
    screen_width?: number;
    screen_height?: number;
    quality_limitation?: string;
  };
};

type AdminDashboardRoom = {
  room_id: string;
  participants?: AdminDashboardParticipant[];
};

type AdminDashboardResponse = {
  total_online?: number;
  server_version?: string;
  rooms?: AdminDashboardRoom[];
};

type AdminSessionEvent = {
  timestamp: number;
  event_type: 'join' | 'leave';
  identity: string;
  name?: string;
  room_id: string;
  duration_secs?: number;
};

type AdminSessionsResponse = {
  events?: AdminSessionEvent[];
};

type AdminMetricsResponse = {
  users?: Array<{
    identity: string;
    name?: string;
    avg_fps: number;
    avg_bitrate_kbps: number;
    pct_bandwidth_limited: number;
    pct_cpu_limited: number;
    encoder?: string;
    ice_local_type?: string;
    ice_remote_type?: string;
    sample_count: number;
    total_minutes: number;
  }>;
};

type AdminDashboardMetricsResponse = {
  summary?: {
    total_sessions?: number;
    unique_users?: number;
    total_hours?: number;
    avg_duration_mins?: number;
  };
  per_user?: Array<{
    identity: string;
    name?: string;
    session_count: number;
    total_hours: number;
  }>;
  heatmap_joins?: Array<{
    timestamp: number;
    name?: string;
  }>;
  timeline_events?: Array<{
    timestamp: number;
    event_type: 'join' | 'leave';
    identity: string;
    name?: string;
  }>;
};

type AdminDeployCommit = {
  sha?: string;
  short_sha?: string;
  message?: string;
  author?: string;
  timestamp?: string;
  deploy_timestamp?: string;
  deploy_duration?: number;
  deploy_status?: 'success' | 'failed' | 'rollback' | 'pending';
  deploy_error?: string;
};

type AdminDeploysResponse = {
  commits?: AdminDeployCommit[];
};

type AdminBugsResponse = {
  reports?: Array<{
    timestamp: number;
    identity?: string;
    name?: string;
    reporter?: string;
    description: string;
  }>;
};

function getStoredValue(key: string): string | null {
  try {
    const storage = globalThis.localStorage as
      | { getItem?: (k: string) => string | null }
      | undefined;
    if (!storage || typeof storage.getItem !== 'function') return null;
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredValue(key: string, value: string): void {
  try {
    const storage = globalThis.localStorage as
      | { setItem?: (k: string, v: string) => void }
      | undefined;
    if (!storage || typeof storage.setItem !== 'function') return;
    storage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function loadParticipantVolumes(): Record<string, { mic: number; screen: number }> {
  return safeJsonParse<Record<string, { mic: number; screen: number }>>(
    getStoredValue(PARTICIPANT_VOLUME_STORAGE_KEY),
    {},
  );
}

function getParticipantVolume(
  volumes: Record<string, { mic: number; screen: number }>,
  identity: string,
  kind: 'mic' | 'screen',
) {
  const entry = volumes[identity];
  const value = kind === 'mic' ? entry?.mic : entry?.screen;
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(3, Number(value)));
}

function setParticipantVolume(
  volumes: Record<string, { mic: number; screen: number }>,
  identity: string,
  kind: 'mic' | 'screen',
  value: number,
) {
  const current = volumes[identity] ?? { mic: 1, screen: 1 };
  const nextValue = Math.max(0, Math.min(3, Number(value)));
  volumes[identity] = {
    mic: kind === 'mic' ? nextValue : current.mic,
    screen: kind === 'screen' ? nextValue : current.screen,
  };
}

function stableRoomId(room: string): (typeof FIXED_ROOMS)[number] {
  if (FIXED_ROOMS.includes(room as (typeof FIXED_ROOMS)[number])) {
    return room as (typeof FIXED_ROOMS)[number];
  }
  return 'main';
}

function getInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase() || '??'
  );
}

function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds?: number): string {
  if (seconds == null || Number.isNaN(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.max(1, Math.floor(seconds))}s`;
}

function formatAdminTime(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDeployTime(isoLike: string | undefined): string {
  if (!isoLike) return '';
  try {
    const deployedAt = new Date(isoLike);
    const diffMs = Date.now() - deployedAt.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return deployedAt.toLocaleDateString();
  } catch {
    return isoLike;
  }
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((part) => Number(part) || 0);
  const b = current.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function hasTauriIPC(): boolean {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  return Boolean(tauri?.core && typeof tauri.core.invoke === 'function');
}

async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<T> } } }).__TAURI__;
  if (!tauri?.core?.invoke) {
    throw new Error('Tauri IPC not available');
  }
  return tauri.core.invoke(cmd, args);
}

function identityBase(identity: string): string {
  const dash = identity.lastIndexOf('-');
  if (dash <= 0) return identity;
  const suffix = identity.slice(dash + 1);
  return /^\d{3,6}$/.test(suffix) ? identity.slice(0, dash) : identity;
}

function classifyTrack(
  publication: TrackPublication | undefined,
): LocalTrack | RemoteTrack | null {
  return (publication?.track as LocalTrack | RemoteTrack | undefined) ?? null;
}

function buildParticipantViews(room: Room): ParticipantView[] {
  const all: Participant[] = [room.localParticipant, ...Array.from(room.remoteParticipants.values())];

  return all.map((participant) => {
    const micPublication = participant.getTrackPublication(Track.Source.Microphone);
    const cameraPublication = participant.getTrackPublication(Track.Source.Camera);
    const screenPublication = participant.getTrackPublication(Track.Source.ScreenShare);
    const screenAudioSource = (Track.Source as Record<string, string | undefined>).ScreenShareAudio ?? 'screen_share_audio';
    const screenAudioPublication = participant.getTrackPublication(screenAudioSource as any);

    return {
      identity: participant.identity,
      name: participant.name || participant.identity,
      isLocal: participant instanceof LocalParticipant,
      speaking: participant.isSpeaking,
      micTrack: classifyTrack(micPublication),
      cameraTrack: classifyTrack(cameraPublication),
      cameraPublication,
      screenTrack: classifyTrack(screenPublication),
      screenAudioTrack: classifyTrack(screenAudioPublication),
    };
  });
}

function resolveControlUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed) return trimmed;
  if (typeof window !== 'undefined' && window.location.host) {
    return `https://${window.location.host}`;
  }
  return 'https://127.0.0.1:9443';
}

type TrackRendererProps = {
  track: LocalTrack | RemoteTrack | null;
  className?: string;
  muted?: boolean;
  onMounted?: (element: HTMLMediaElement) => void;
  onUnmounted?: (element: HTMLMediaElement) => void;
};

function TrackRenderer({
  track,
  className,
  muted,
  onMounted,
  onUnmounted,
}: TrackRendererProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!track || !mountRef.current) return;

    const element = track.attach();
    element.autoplay = true;
    (element as HTMLVideoElement).playsInline = true;
    element.controls = false;
    element.muted = Boolean(muted);
    element.className = className ?? '';

    mountRef.current.innerHTML = '';
    mountRef.current.appendChild(element);
    onMounted?.(element);

    return () => {
      onUnmounted?.(element);
      try {
        track.detach(element);
      } catch {
        // ignore detach errors
      }
      element.remove();
    };
  }, [track, className, muted, onMounted, onUnmounted]);

  return <div ref={mountRef} className="h-full w-full" />;
}

type TrackLikeWithSender = {
  sender?: RTCRtpSender;
  mediaStreamTrack?: MediaStreamTrack;
};

function getTrackSender(track: LocalTrack | RemoteTrack | null | undefined) {
  const candidate = track as LocalTrack | RemoteTrack | null | undefined;
  if (!candidate) return null;
  const sender = (candidate as unknown as TrackLikeWithSender).sender;
  return sender ?? null;
}

function getTrackMediaStreamTrack(track: LocalTrack | RemoteTrack | null | undefined) {
  const candidate = track as LocalTrack | RemoteTrack | null | undefined;
  if (!candidate) return null;
  const mediaStreamTrack = (candidate as unknown as TrackLikeWithSender).mediaStreamTrack;
  return mediaStreamTrack ?? null;
}

migrateLegacyViewerPreferences(globalThis.localStorage as Storage | undefined);
installSdpCodecHintParity();

export function App() {
  const actorRef = useActorRef(connectionMachine);
  const snapshot = useSelector(actorRef, (state) => state);

  const {
    controlUrl,
    sfuUrl,
    room,
    name,
    identity,
    adminPassword,
    setField,
  } = useViewerPrefsStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const localAvatarInputRef = useRef<HTMLInputElement | null>(null);

  const [soundboardCompactOpen, setSoundboardCompactOpen] = useState(false);
  const [soundboardEditOpen, setSoundboardEditOpen] = useState(false);
  const [soundboardVolumeOpen, setSoundboardVolumeOpen] = useState(false);
  const [soundboardVolume, setSoundboardVolume] = useState<number>(() => {
    const raw = Number.parseInt(getStoredValue('echo-core-soundboard-volume') ?? '100', 10);
    return Number.isNaN(raw) ? 100 : Math.max(0, Math.min(100, raw));
  });
  const [soundSearch, setSoundSearch] = useState('');
  const [soundboardSounds, setSoundboardSounds] = useState<SoundboardSound[]>([]);
  const [soundboardHint, setSoundboardHint] = useState('');
  const [soundboardReloadTick, setSoundboardReloadTick] = useState(0);
  const [soundboardEditingId, setSoundboardEditingId] = useState<string | null>(null);
  const [soundboardSelectedIcon, setSoundboardSelectedIcon] = useState<string>(SOUNDBOARD_ICONS[0]);
  const [soundFileLabel, setSoundFileLabel] = useState('Select audio');
  const [soundNameInput, setSoundNameInput] = useState('');
  const [soundClipVolume, setSoundClipVolume] = useState(() => {
    const raw = Number.parseInt(getStoredValue(SOUNDBOARD_CLIP_VOLUME_STORAGE_KEY) ?? '100', 10);
    return Number.isFinite(raw) ? Math.max(0, Math.min(200, raw)) : 100;
  });
  const [soundboardCustomOrder] = useState<string[]>(() =>
    safeJsonParse<string[]>(getStoredValue(SOUNDBOARD_ORDER_STORAGE_KEY), []),
  );
  const soundUploadFileRef = useRef<File | null>(null);

  const [chimeStatus, setChimeStatus] = useState<{ enter: string; exit: string }>({ enter: '', exit: '' });
  const [chimeExists, setChimeExists] = useState<{ enter: boolean; exit: boolean }>({ enter: false, exit: false });
  const chimeFileRef = useRef<{ enter: File | null; exit: File | null }>({ enter: null, exit: null });
  const chimeAudioCtxRef = useRef<AudioContext | null>(null);
  const chimeBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const soundboardAudioCtxRef = useRef<AudioContext | null>(null);
  const soundboardMasterGainRef = useRef<GainNode | null>(null);
  const soundboardBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const soundboardCurrentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const soundboardSoundsRef = useRef<SoundboardSound[]>([]);
  const soundClipVolumeRef = useRef(100);
  const playSoundByIdRef = useRef<(soundId: string, clipVolume?: number) => Promise<boolean>>(async () => false);
  const fetchChimeBufferRef = useRef<(targetIdentity: string, kind: 'enter' | 'exit') => Promise<AudioBuffer | null>>(async () => null);
  const deviceIdByIdentityRef = useRef<Map<string, string>>(new Map());
  const localDeviceIdRef = useRef('');

  const [cameraLobbyOpen, setCameraLobbyOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [activeTheme, setActiveTheme] = useState<string>(() => getStoredValue(THEME_STORAGE_KEY) ?? 'frost');
  const [uiOpacity, setUiOpacity] = useState<number>(() => {
    const raw = Number.parseInt(getStoredValue(UI_OPACITY_KEY) ?? '100', 10);
    return Number.isNaN(raw) ? 100 : Math.max(20, Math.min(100, raw));
  });

  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugDescription, setBugDescription] = useState('');
  const [bugStatus, setBugStatus] = useState('');
  const [bugScreenshotFile, setBugScreenshotFile] = useState<File | null>(null);
  const [bugScreenshotUrl, setBugScreenshotUrl] = useState<string | null>(null);

  const [jamOpen, setJamOpen] = useState(false);
  const [jamVolume, setJamVolume] = useState(50);
  const [jamStatus, setJamStatus] = useState('');
  const [jamError, setJamError] = useState('');
  const [jamState, setJamState] = useState<JamState | null>(null);
  const [jamSearch, setJamSearch] = useState('');
  const [jamSearchResults, setJamSearchResults] = useState<JamTrack[]>([]);

  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);

  const [adminDashOpen, setAdminDashOpen] = useState(false);
  const [adminDashTab, setAdminDashTab] = useState<'live' | 'history' | 'metrics' | 'bugs' | 'deploys'>('live');
  const [adminDashboard, setAdminDashboard] = useState<AdminDashboardResponse | null>(null);
  const [adminSessions, setAdminSessions] = useState<AdminSessionsResponse | null>(null);
  const [adminMetrics, setAdminMetrics] = useState<AdminMetricsResponse | null>(null);
  const [adminDashboardMetrics, setAdminDashboardMetrics] = useState<AdminDashboardMetricsResponse | null>(null);
  const [adminBugs, setAdminBugs] = useState<AdminBugsResponse | null>(null);
  const [adminDeploys, setAdminDeploys] = useState<AdminDeploysResponse | null>(null);
  const [adminPanelWidth, setAdminPanelWidth] = useState<number>(() => {
    const raw = Number.parseInt(getStoredValue('admin-panel-width') ?? '520', 10);
    return Number.isFinite(raw) ? Math.max(400, raw) : 520;
  });
  const adminDashTimerRef = useRef<number | null>(null);

  const [deviceStatus, setDeviceStatus] = useState('');
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [camDevices, setCamDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>(() => getStoredValue('echo-device-mic') ?? '');
  const [selectedCamId, setSelectedCamId] = useState<string>(() => getStoredValue('echo-device-cam') ?? '');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>(() => getStoredValue('echo-device-speaker') ?? '');

  const [roomVersion, setRoomVersion] = useState(0);
  const [roomAudioMuted, setRoomAudioMuted] = useState(false);
  const [roomConnectError, setRoomConnectError] = useState<string | null>(null);
  const [connectedRoomName, setConnectedRoomName] = useState<string>('main');
  const [pendingMicDesired, setPendingMicDesired] = useState<boolean | null>(null);
  const [pendingCamDesired, setPendingCamDesired] = useState<boolean | null>(null);
  const [pendingScreenDesired, setPendingScreenDesired] = useState<boolean | null>(null);
  const [updateBannerVersion, setUpdateBannerVersion] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [noiseCancelEnabled, setNoiseCancelEnabled] = useState(() => getStoredValue(RNNOISE_ENABLED_KEY) === '1');
  const [noiseCancelLevel, setNoiseCancelLevel] = useState<RnnoiseSuppressionLevel>(() => {
    const raw = Number(getStoredValue(RNNOISE_LEVEL_KEY) ?? '2');
    if (raw === 0 || raw === 1) return raw;
    return 2;
  });
  const [volumeRevision, setVolumeRevision] = useState(0);

  const micToggleSeqRef = useRef(0);
  const camToggleSeqRef = useRef(0);
  const screenToggleSeqRef = useRef(0);
  const pendingMicDesiredRef = useRef<boolean | null>(null);
  const pendingCamDesiredRef = useRef<boolean | null>(null);
  const pendingScreenDesiredRef = useRef<boolean | null>(null);
  const mediaIntentRef = useRef({ mic: false, cam: false, screen: false });

  const roomRef = useRef<Room | null>(null);
  const remoteMediaElementsRef = useRef<Set<HTMLMediaElement>>(new Set());
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatAbortRef = useRef<AbortController | null>(null);

  const screenShareVideoTrackRef = useRef<LocalVideoTrack | null>(null);
  const screenShareAudioTrackRef = useRef<LocalAudioTrack | null>(null);
  const screenSharePipelineRef = useRef<ReturnType<typeof createCanvasScreenSharePipeline> | null>(null);
  const screenShareManualActiveRef = useRef(false);
  const startManualScreenShareRef = useRef<() => Promise<boolean>>(async () => false);
  const stopManualScreenShareRef = useRef<() => Promise<void>>(async () => undefined);
  const applyRnnoiseToLocalMicRef = useRef<() => Promise<void>>(async () => undefined);
  const publisherCapManagerRef = useRef<PublisherBitrateCapManager | null>(null);
  const receiverAimdControllersRef = useRef<Map<string, ReceiverAimdController>>(new Map());
  const bweWatchdogRef = useRef(new BweWatchdog());
  const outboundBweTimerRef = useRef<number | null>(null);
  const capCleanupTimerRef = useRef<number | null>(null);
  const outboundPrevStatsRef = useRef<{ bytesSent: number; timestamp: number } | null>(null);
  const inboundPrevLostRef = useRef<Map<string, number>>(new Map());
  const inboundPrevBytesRef = useRef<Map<string, { bytes: number; timestamp: number }>>(new Map());
  const rnnoiseProcessorRef = useRef(new RnnoiseMicProcessor());
  const volumeBoostRef = useRef(new ParticipantVolumeBoostManager());
  const participantVolumesRef = useRef<Record<string, { mic: number; screen: number }>>(loadParticipantVolumes());
  const mediaBindingRef = useRef<Map<HTMLMediaElement, { identity: string; kind: 'mic' | 'screen' }>>(new Map());
  const cameraRecoveryMonitorRef = useRef(new CameraRecoveryMonitor());
  const cameraRecoveryDetachRef = useRef<Map<string, () => void>>(new Map());

  const jamAudioWsRef = useRef<WebSocket | null>(null);
  const jamAudioCtxRef = useRef<AudioContext | null>(null);
  const jamGainRef = useRef<GainNode | null>(null);
  const jamNextPlayRef = useRef(0);
  const jamStoppingRef = useRef(false);
  const jamRetriesRef = useRef(0);

  const spotifyAuthStateRef = useRef<string | null>(null);
  const spotifyVerifierRef = useRef<string | null>(null);

  const onlineUsersQuery = useOnlineUsersQuery(resolveControlUrl(controlUrl));
  const adminToken = snapshot.context.session?.adminToken ?? null;
  const roomStatusQuery = useRoomStatusQuery(resolveControlUrl(controlUrl), adminToken);

  const activeRoom = stableRoomId((room || 'main').trim());
  const localIdentity = snapshot.context.session?.identity ?? '';
  const localDeviceId = useMemo(
    () =>
      ensureLocalDeviceId(
        globalThis.localStorage as Storage | undefined,
        (globalThis as { crypto?: Crypto }).crypto,
      ),
    [],
  );
  localDeviceIdRef.current = localDeviceId;
  const viewerVersion = 'viewer-next-react';
  const isAdminMode = useMemo(() => {
    const candidate = (globalThis as { __ECHO_ADMIN__?: unknown }).__ECHO_ADMIN__;
    return Boolean(candidate);
  }, []);

  const roomStatusMap = useMemo(() => {
    const map = new Map<string, RoomStatusParticipant[]>();
    (roomStatusQuery.data ?? []).forEach((entry) => {
      map.set(entry.room_id, entry.participants ?? []);
    });
    return map;
  }, [roomStatusQuery.data]);

  const connected = snapshot.matches('connected');
  const provisioning = snapshot.matches('provisioning');

  const participantViews = useMemo(() => {
    const liveRoom = roomRef.current;
    const fallbackParticipants = roomStatusMap.get(activeRoom) ?? [];

    if (liveRoom) {
      const live = buildParticipantViews(liveRoom);
      const seen = new Set(live.map((participant) => participant.identity));

      fallbackParticipants.forEach((participant) => {
        if (seen.has(participant.identity)) return;
        live.push({
          identity: participant.identity,
          name: participant.name ?? participant.identity,
          isLocal: false,
          speaking: false,
          micTrack: null,
          cameraTrack: null,
          cameraPublication: undefined,
          screenTrack: null,
          screenAudioTrack: null,
        });
      });

      return live;
    }

    return fallbackParticipants.map((participant) => ({
      identity: participant.identity,
      name: participant.name ?? participant.identity,
      isLocal: false,
      speaking: false,
      micTrack: null,
      cameraTrack: null,
      cameraPublication: undefined,
      screenTrack: null,
      screenAudioTrack: null,
    }));
  }, [roomVersion, roomStatusMap, activeRoom, volumeRevision]);

  const screenParticipants = useMemo(
    () => participantViews.filter((participant) => Boolean(participant.screenTrack)),
    [participantViews],
  );

  const filteredSoundboard = useMemo(() => {
    const filtered = soundboardSounds.filter((sound) =>
      sound.name.toLowerCase().includes(soundSearch.toLowerCase().trim()),
    );
    return sortSoundboardByOrder(filtered, soundboardCustomOrder);
  }, [soundSearch, soundboardSounds, soundboardCustomOrder]);

  const jamHostIdentityBase = jamState?.host_identity ? identityBase(jamState.host_identity) : '';
  const localIdentityBase = identityBase(localIdentity);
  const isJamHost = Boolean(jamHostIdentityBase && jamHostIdentityBase === localIdentityBase);
  const isJamListening = Boolean(
    jamState?.listeners?.some((listener) => identityBase(listener) === localIdentityBase),
  );

  const localMediaState = useMemo(() => {
    const localParticipant = roomRef.current?.localParticipant;
    if (localParticipant) {
      return {
        mic: localParticipant.isMicrophoneEnabled,
        cam: localParticipant.isCameraEnabled,
        screen: screenShareManualActiveRef.current || localParticipant.isScreenShareEnabled,
      };
    }

    const local = participantViews.find((participant) => participant.isLocal);
    return {
      mic: Boolean(local?.micTrack),
      cam: Boolean(local?.cameraTrack),
      screen: Boolean(local?.screenTrack),
    };
  }, [participantViews, roomVersion]);

  const micEnabled = pendingMicDesired ?? localMediaState.mic;
  const camEnabled = pendingCamDesired ?? localMediaState.cam;
  const screenEnabled = pendingScreenDesired ?? localMediaState.screen;

  const statusText = useMemo(() => {
    if (snapshot.matches('connected')) {
      return roomConnectError ? `Connected (media warning: ${roomConnectError})` : 'Connected';
    }
    if (snapshot.matches('provisioning')) return 'Connecting…';
    if (snapshot.matches('failed')) return `Connection failed: ${snapshot.context.lastError ?? 'Unknown error'}`;
    return 'Idle';
  }, [snapshot, roomConnectError]);

  useEffect(() => {
    if (pendingMicDesired == null) mediaIntentRef.current.mic = micEnabled;
    if (pendingCamDesired == null) mediaIntentRef.current.cam = camEnabled;
    if (pendingScreenDesired == null) mediaIntentRef.current.screen = screenEnabled;
  }, [micEnabled, camEnabled, screenEnabled, pendingMicDesired, pendingCamDesired, pendingScreenDesired]);

  useEffect(() => {
    pendingMicDesiredRef.current = pendingMicDesired;
    pendingCamDesiredRef.current = pendingCamDesired;
    pendingScreenDesiredRef.current = pendingScreenDesired;
  }, [pendingMicDesired, pendingCamDesired, pendingScreenDesired]);

  useEffect(() => {
    if (connected || provisioning) return;
    pendingMicDesiredRef.current = null;
    pendingCamDesiredRef.current = null;
    pendingScreenDesiredRef.current = null;
    setPendingMicDesired(null);
    setPendingCamDesired(null);
    setPendingScreenDesired(null);
  }, [connected, provisioning]);

  const appendDebug = useCallback((text: string) => {
    setDebugLog((prev) => [
      ...prev,
      { id: Date.now() + Math.floor(Math.random() * 1000), text: `[${new Date().toLocaleTimeString()}] ${text}` },
    ]);
  }, []);

  const apiUrl = useCallback(
    (path: string) => `${resolveControlUrl(controlUrl)}${path}`,
    [controlUrl],
  );

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (heartbeatAbortRef.current) {
      heartbeatAbortRef.current.abort();
      heartbeatAbortRef.current = null;
    }
  }, []);

  const sendLeaveNotification = useCallback(
    (identityOverride?: string) => {
      const control = resolveControlUrl(controlUrl);
      const participantIdentity = identityOverride || snapshot.context.session?.identity || localIdentity || identity.trim();
      if (!control || !adminToken || !participantIdentity) return;

      fetch(`${control}/v1/participants/leave`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ identity: participantIdentity }),
      }).catch(() => undefined);
    },
    [adminToken, controlUrl, snapshot.context.session?.identity, localIdentity, identity],
  );

  const localChimeIdentity = useMemo(
    () => identityBase(localIdentity || identity.trim() || name.trim() || 'viewer'),
    [localIdentity, identity, name],
  );

  const ensureChimeAudioContext = useCallback(async (): Promise<AudioContext> => {
    let context = chimeAudioCtxRef.current;
    if (!context) {
      context = new AudioContext();
      chimeAudioCtxRef.current = context;
    }
    if (context.state === 'suspended') {
      await context.resume();
    }
    return context;
  }, []);

  const playBuiltInChime = useCallback(
    async (kind: 'enter' | 'exit', volume = 0.5) => {
      const context = await ensureChimeAudioContext();
      const gain = context.createGain();
      gain.gain.value = Math.max(0, Math.min(1, volume));
      gain.connect(context.destination);

      const o1 = context.createOscillator();
      const o2 = context.createOscillator();
      const base = kind === 'enter' ? 680 : 540;
      o1.frequency.value = base;
      o2.frequency.value = base * 1.33;
      o1.type = 'sine';
      o2.type = 'triangle';
      o1.connect(gain);
      o2.connect(gain);

      const now = context.currentTime;
      o1.start(now);
      o2.start(now + 0.05);
      o1.stop(now + 0.22);
      o2.stop(now + 0.28);
    },
    [ensureChimeAudioContext],
  );

  const fetchChimeBuffer = useCallback(
    async (targetIdentity: string, kind: 'enter' | 'exit'): Promise<AudioBuffer | null> => {
      const cacheKey = `${targetIdentity}-${kind}`;
      if (chimeBufferCacheRef.current.has(cacheKey)) {
        return chimeBufferCacheRef.current.get(cacheKey) ?? null;
      }

      try {
        const response = await fetch(
          `${resolveControlUrl(controlUrl)}/api/chime/${encodeURIComponent(targetIdentity)}/${kind}?v=${Date.now()}`,
          {
            headers: adminToken
              ? {
                  Authorization: `Bearer ${adminToken}`,
                }
              : undefined,
          },
        );
        if (!response.ok) return null;

        const context = await ensureChimeAudioContext();
        const arrayBuffer = await response.arrayBuffer();
        const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
        chimeBufferCacheRef.current.set(cacheKey, decoded);
        return decoded;
      } catch {
        return null;
      }
    },
    [controlUrl, adminToken, ensureChimeAudioContext],
  );

  useEffect(() => {
    fetchChimeBufferRef.current = fetchChimeBuffer;
  }, [fetchChimeBuffer]);

  const playParticipantChime = useCallback(
    async (participantIdentity: string, kind: 'enter' | 'exit') => {
      const chimeIdentity = resolveChimeIdentity(
        participantIdentity,
        identityBase,
        deviceIdByIdentityRef.current,
      );
      const context = await ensureChimeAudioContext();
      const gain = context.createGain();
      gain.gain.value = 0.5;
      gain.connect(context.destination);

      const buffer = await fetchChimeBuffer(chimeIdentity, kind);
      if (buffer) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.start();
        return;
      }

      await playBuiltInChime(kind, 0.5);
    },
    [ensureChimeAudioContext, fetchChimeBuffer, playBuiltInChime],
  );

  const checkLocalChimeState = useCallback(
    async (kind: 'enter' | 'exit') => {
      if (!connected || !localChimeIdentity) return;
      try {
        const response = await fetch(
          `${resolveControlUrl(controlUrl)}/api/chime/${encodeURIComponent(localChimeIdentity)}/${kind}`,
          {
            method: 'HEAD',
            headers: adminToken
              ? {
                  Authorization: `Bearer ${adminToken}`,
                }
              : undefined,
          },
        );
        setChimeExists((prev) => ({ ...prev, [kind]: response.ok }));
        if (response.ok) {
          setChimeStatus((prev) => ({ ...prev, [kind]: 'Custom sound set' }));
        }
      } catch {
        // ignore check failures
      }
    },
    [connected, localChimeIdentity, controlUrl, adminToken],
  );

  const uploadChime = useCallback(
    async (kind: 'enter' | 'exit') => {
      if (!adminToken || !localChimeIdentity) return;
      const file = chimeFileRef.current[kind];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        setChimeStatus((prev) => ({ ...prev, [kind]: 'Too large (max 2MB)' }));
        return;
      }

      setChimeStatus((prev) => ({ ...prev, [kind]: 'Uploading...' }));
      try {
        const response = await fetch(
          `${resolveControlUrl(controlUrl)}/api/chime/upload?identity=${encodeURIComponent(localChimeIdentity)}&kind=${kind}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
              'Content-Type': file.type || 'audio/mpeg',
            },
            body: await file.arrayBuffer(),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!response.ok || !payload.ok) {
          setChimeStatus((prev) => ({ ...prev, [kind]: payload.error || 'Upload failed' }));
          return;
        }

        chimeBufferCacheRef.current.delete(`${localChimeIdentity}-${kind}`);
        setChimeExists((prev) => ({ ...prev, [kind]: true }));
        setChimeStatus((prev) => ({ ...prev, [kind]: file.name || 'Custom sound set' }));
        chimeFileRef.current[kind] = null;
      } catch {
        setChimeStatus((prev) => ({ ...prev, [kind]: 'Upload error' }));
      }
    },
    [adminToken, localChimeIdentity, controlUrl],
  );

  const previewChime = useCallback(
    async (kind: 'enter' | 'exit') => {
      if (!localChimeIdentity) return;
      chimeBufferCacheRef.current.delete(`${localChimeIdentity}-${kind}`);
      const buffer = await fetchChimeBuffer(localChimeIdentity, kind);
      if (!buffer) return;
      const context = await ensureChimeAudioContext();
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = 0.6;
      source.connect(gain);
      gain.connect(context.destination);
      source.start();
    },
    [localChimeIdentity, fetchChimeBuffer, ensureChimeAudioContext],
  );

  const removeChime = useCallback(
    async (kind: 'enter' | 'exit') => {
      if (!adminToken || !localChimeIdentity) return;
      try {
        await fetch(`${resolveControlUrl(controlUrl)}/api/chime/delete`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ identity: localChimeIdentity, kind }),
        });
      } catch {
        // ignore delete failure
      }

      chimeBufferCacheRef.current.delete(`${localChimeIdentity}-${kind}`);
      setChimeExists((prev) => ({ ...prev, [kind]: false }));
      setChimeStatus((prev) => ({ ...prev, [kind]: '' }));
    },
    [adminToken, localChimeIdentity, controlUrl],
  );

  const logStatsEvent = useCallback(
    async (eventName: string, eventDetail?: string) => {
      const room = roomRef.current;
      const participantIdentity = room?.localParticipant?.identity || localIdentity;
      if (!participantIdentity) return;

      try {
        await fetch(apiUrl('/api/stats-log'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            identity: participantIdentity,
            room: connectedRoomName || activeRoom,
            event: eventName,
            event_detail: eventDetail || null,
          }),
        });
      } catch {
        // best-effort logging only
      }
    },
    [apiUrl, localIdentity, connectedRoomName, activeRoom],
  );

  const postAdminStatsSample = useCallback(async () => {
    if (!adminToken) return;
    const room = roomRef.current;
    const participant = room?.localParticipant;
    if (!participant) return;

    const identityValue = participant.identity || localIdentity;
    if (!identityValue) return;

    const screenPublication = participant.getTrackPublication(Track.Source.ScreenShare);
    const screenTrack = screenPublication?.track as
      | {
          mediaStreamTrack?: {
            getSettings?: () => Partial<MediaTrackSettings>;
          };
        }
      | undefined;

    const settings = screenTrack?.mediaStreamTrack?.getSettings?.();
    const fps = settings?.frameRate != null ? Number(settings.frameRate) : null;
    const width = settings?.width != null ? Number(settings.width) : null;
    const height = settings?.height != null ? Number(settings.height) : null;

    try {
      await fetch(apiUrl('/admin/api/stats'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identity: identityValue,
          name: participant.name || name || identityValue,
          room: connectedRoomName || activeRoom,
          screen_fps: Number.isFinite(fps ?? NaN) ? fps : null,
          screen_width: Number.isFinite(width ?? NaN) ? width : null,
          screen_height: Number.isFinite(height ?? NaN) ? height : null,
          screen_bitrate_kbps: null,
          bwe_kbps: null,
          quality_limitation: null,
          encoder: null,
          ice_local_type: null,
          ice_remote_type: null,
          simulcast_layers: null,
        }),
      });
    } catch {
      // best-effort sampling only
    }
  }, [adminToken, apiUrl, localIdentity, name, connectedRoomName, activeRoom]);

  const registerRemoteMediaElement = useCallback(
    (
      element: HTMLMediaElement,
      isAttach: boolean,
      binding?: { identity: string; kind: 'mic' | 'screen' },
    ) => {
      if (isAttach) {
        remoteMediaElementsRef.current.add(element);
        if (binding) {
          mediaBindingRef.current.set(element, binding);
        }
      } else {
        remoteMediaElementsRef.current.delete(element);
        mediaBindingRef.current.delete(element);
        volumeBoostRef.current.cleanup(element);
      }

      if (typeof (element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId === 'function') {
        const maybeSink = (element as HTMLMediaElement & {
          setSinkId?: (id: string) => Promise<void>;
        }).setSinkId;
        if (maybeSink && selectedSpeakerId) {
          maybeSink.call(element as HTMLMediaElement & { setSinkId: (id: string) => Promise<void> }, selectedSpeakerId).catch(
            () => {
              // ignore sink-id errors
            },
          );
        }
      }

      const currentBinding = mediaBindingRef.current.get(element);
      const volume = currentBinding
        ? getParticipantVolume(participantVolumesRef.current, currentBinding.identity, currentBinding.kind)
        : 1;

      volumeBoostRef.current.applyVolume(element, volume, roomAudioMuted);
      element.muted = false;
    },
    [roomAudioMuted, selectedSpeakerId],
  );

  useEffect(() => {
    document.body.dataset.theme = activeTheme;
    setStoredValue(THEME_STORAGE_KEY, activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    const clamped = Math.max(20, Math.min(100, uiOpacity));
    document.documentElement.style.setProperty('--ui-bg-alpha', `${clamped / 100}`);
    setStoredValue(UI_OPACITY_KEY, String(clamped));
  }, [uiOpacity]);

  useEffect(() => {
    setStoredValue('echo-core-soundboard-volume', String(soundboardVolume));
    if (soundboardMasterGainRef.current) {
      soundboardMasterGainRef.current.gain.value = Math.max(0, Math.min(100, soundboardVolume)) / 100;
    }
  }, [soundboardVolume]);

  useEffect(() => {
    setStoredValue(SOUNDBOARD_CLIP_VOLUME_STORAGE_KEY, String(soundClipVolume));
  }, [soundClipVolume]);

  useEffect(() => {
    soundboardSoundsRef.current = soundboardSounds;
  }, [soundboardSounds]);

  useEffect(() => {
    soundClipVolumeRef.current = soundClipVolume;
  }, [soundClipVolume]);

  useEffect(() => {
    setStoredValue('echo-device-mic', selectedMicId);
  }, [selectedMicId]);

  useEffect(() => {
    setStoredValue('echo-device-cam', selectedCamId);
  }, [selectedCamId]);

  useEffect(() => {
    setStoredValue('echo-device-speaker', selectedSpeakerId);
  }, [selectedSpeakerId]);

  useEffect(() => {
    void volumeBoostRef.current.setSinkId(selectedSpeakerId);
  }, [selectedSpeakerId]);

  useEffect(() => {
    setStoredValue(RNNOISE_ENABLED_KEY, noiseCancelEnabled ? '1' : '0');
  }, [noiseCancelEnabled]);

  useEffect(() => {
    setStoredValue(RNNOISE_LEVEL_KEY, String(noiseCancelLevel));
    rnnoiseProcessorRef.current.setSuppressionLevel(noiseCancelLevel);
  }, [noiseCancelLevel]);

  useEffect(() => {
    if (chatOpen) {
      setUnreadChatCount(0);
    }
  }, [chatOpen]);

  // RNNoise mic effect is installed after callback declarations.

  useEffect(() => {
    remoteMediaElementsRef.current.forEach((element) => {
      const binding = mediaBindingRef.current.get(element);
      const volume = binding
        ? getParticipantVolume(participantVolumesRef.current, binding.identity, binding.kind)
        : 1;
      volumeBoostRef.current.applyVolume(element, volume, roomAudioMuted);
      element.muted = false;
    });
  }, [roomAudioMuted, volumeRevision]);

  useEffect(() => () => {
    if (outboundBweTimerRef.current) {
      window.clearInterval(outboundBweTimerRef.current);
      outboundBweTimerRef.current = null;
    }
    if (capCleanupTimerRef.current) {
      window.clearInterval(capCleanupTimerRef.current);
      capCleanupTimerRef.current = null;
    }
    screenSharePipelineRef.current?.stop();
    screenSharePipelineRef.current = null;
    volumeBoostRef.current.cleanupAll();
    cameraRecoveryMonitorRef.current.reset();
    cameraRecoveryDetachRef.current.forEach((detach) => detach());
    cameraRecoveryDetachRef.current.clear();
    const soundboardContext = soundboardAudioCtxRef.current;
    soundboardAudioCtxRef.current = null;
    soundboardMasterGainRef.current = null;
    soundboardCurrentSourceRef.current = null;
    soundboardBufferCacheRef.current.clear();
    if (soundboardContext) {
      void soundboardContext.close().catch(() => undefined);
    }
    void rnnoiseProcessorRef.current.disable();
  }, []);

  useEffect(() => {
    stopHeartbeat();

    const participantIdentity = snapshot.context.session?.identity || identity.trim();
    if (!connected || !adminToken || !participantIdentity) return;

    const control = resolveControlUrl(controlUrl);
    const ac = new AbortController();
    heartbeatAbortRef.current = ac;

    const sendBeat = () => {
      if (ac.signal.aborted) return;
      fetch(`${control}/v1/participants/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          room: connectedRoomName || activeRoom,
          identity: participantIdentity,
          name: name.trim() || 'Viewer',
          viewer_version: viewerVersion,
        }),
        signal: ac.signal,
      }).catch(() => undefined);
    };

    sendBeat();
    heartbeatTimerRef.current = window.setInterval(sendBeat, 10_000);

    return stopHeartbeat;
  }, [
    connected,
    adminToken,
    controlUrl,
    connectedRoomName,
    activeRoom,
    identity,
    name,
    viewerVersion,
    snapshot.context.session?.identity,
    stopHeartbeat,
  ]);

  useEffect(() => {
    if (!connected || !adminToken) return;

    void postAdminStatsSample();
    const timer = window.setInterval(() => {
      void postAdminStatsSample();
    }, 10_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [connected, adminToken, postAdminStatsSample]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      sendLeaveNotification();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      stopHeartbeat();
    };
  }, [sendLeaveNotification, stopHeartbeat]);

  useEffect(() => {
    if (updateDismissed) return;
    if (!(globalThis as { __ECHO_NATIVE__?: unknown }).__ECHO_NATIVE__) return;

    let cancelled = false;

    const checkForUpdate = async () => {
      if (cancelled || updateDismissed) return;
      let currentVersion = '';

      if (hasTauriIPC()) {
        try {
          const info = await tauriInvoke<{ version?: string }>('get_app_info');
          currentVersion = info?.version || '';
        } catch {
          currentVersion = '';
        }
      }

      if (!currentVersion) return;

      try {
        const response = await fetch(`${resolveControlUrl(controlUrl)}/api/version`);
        if (!response.ok) return;
        const payload = (await response.json()) as { latest_client?: string };
        const latestClient = payload.latest_client || '';
        if (latestClient && isNewerVersion(latestClient, currentVersion)) {
          setUpdateBannerVersion(latestClient);
        }
      } catch {
        // silent update-check failure
      }
    };

    const timeoutHandle = window.setTimeout(() => {
      void checkForUpdate();
    }, 10_000);

    const intervalHandle = window.setInterval(() => {
      void checkForUpdate();
    }, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
      window.clearInterval(intervalHandle);
    };
  }, [controlUrl, updateDismissed]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceStatus('Device enumeration is not supported in this browser.');
      return;
    }

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => null);
      const devices = await navigator.mediaDevices.enumerateDevices();

      const mics = devices.filter((device) => device.kind === 'audioinput');
      const cams = devices.filter((device) => device.kind === 'videoinput');
      const speakers = devices.filter((device) => device.kind === 'audiooutput');

      setMicDevices(mics);
      setCamDevices(cams);
      setSpeakerDevices(speakers);

      if (!selectedMicId && mics[0]) setSelectedMicId(mics[0].deviceId);
      if (!selectedCamId && cams[0]) setSelectedCamId(cams[0].deviceId);
      if (!selectedSpeakerId && speakers[0]) setSelectedSpeakerId(speakers[0].deviceId);

      setDeviceStatus(`Found ${mics.length} mic(s), ${cams.length} camera(s), ${speakers.length} speaker(s).`);
    } catch (error) {
      setDeviceStatus(`Unable to refresh devices: ${(error as Error).message}`);
    }
  }, [selectedMicId, selectedCamId, selectedSpeakerId]);

  const buildConnectionRequest = useCallback(
    (nextRoom = activeRoom) => ({
      controlUrl: resolveControlUrl(controlUrl),
      sfuUrl: sfuUrl.trim(),
      room: nextRoom,
      name: name.trim() || 'Viewer',
      identity: identity.trim(),
      adminPassword,
    }),
    [activeRoom, controlUrl, sfuUrl, name, identity, adminPassword],
  );

  const disconnectRoom = useCallback(async () => {
    if (outboundBweTimerRef.current) {
      window.clearInterval(outboundBweTimerRef.current);
      outboundBweTimerRef.current = null;
    }
    if (capCleanupTimerRef.current) {
      window.clearInterval(capCleanupTimerRef.current);
      capCleanupTimerRef.current = null;
    }

    if (roomRef.current) {
      try {
        await roomRef.current.disconnect();
      } catch {
        // ignore disconnect errors
      }
      roomRef.current.removeAllListeners();
      roomRef.current = null;
    }

    screenSharePipelineRef.current?.stop();
    screenSharePipelineRef.current = null;
    try {
      screenShareVideoTrackRef.current?.mediaStreamTrack?.stop();
      screenShareAudioTrackRef.current?.mediaStreamTrack?.stop();
    } catch {
      // ignore stop errors
    }
    screenShareVideoTrackRef.current = null;
    screenShareAudioTrackRef.current = null;
    screenShareManualActiveRef.current = false;

    if (publisherCapManagerRef.current) {
      await publisherCapManagerRef.current.clear();
    }
    publisherCapManagerRef.current = null;
    receiverAimdControllersRef.current.clear();
    inboundPrevLostRef.current.clear();
    inboundPrevBytesRef.current.clear();
    outboundPrevStatsRef.current = null;
    bweWatchdogRef.current.reset();

    remoteMediaElementsRef.current.clear();
    mediaBindingRef.current.clear();
    volumeBoostRef.current.cleanupAll();
    cameraRecoveryMonitorRef.current.reset();
    cameraRecoveryDetachRef.current.forEach((detach) => detach());
    cameraRecoveryDetachRef.current.clear();
    deviceIdByIdentityRef.current.clear();
    void rnnoiseProcessorRef.current.disable();

    setRoomVersion((v) => v + 1);
  }, []);

  const reconcileMediaIntent = useCallback(async (room?: Room | null) => {
    const liveRoom = room ?? roomRef.current;
    if (!liveRoom) return;

    const localParticipant = liveRoom.localParticipant;
    const intent = mediaIntentRef.current;

    if (localParticipant.isMicrophoneEnabled !== intent.mic) {
      try {
        await localParticipant.setMicrophoneEnabled(intent.mic, {
          deviceId: intent.mic ? (selectedMicId || undefined) : undefined,
        });
      } catch (error) {
        appendDebug(`Mic reconcile failed: ${(error as Error).message}`);
      }
    }

    if (localParticipant.isCameraEnabled !== intent.cam) {
      try {
        await localParticipant.setCameraEnabled(intent.cam, {
          deviceId: intent.cam ? (selectedCamId || undefined) : undefined,
        });
      } catch (error) {
        appendDebug(`Camera reconcile failed: ${(error as Error).message}`);
      }
    }

    const currentScreenEnabled = screenShareManualActiveRef.current || localParticipant.isScreenShareEnabled;
    if (currentScreenEnabled !== intent.screen) {
      try {
        if (intent.screen) {
          const parityStarted = await startManualScreenShareRef.current();
          if (!parityStarted) {
            await localParticipant.setScreenShareEnabled(true, { audio: true });
          }
        } else if (screenShareManualActiveRef.current) {
          await stopManualScreenShareRef.current();
        } else {
          await localParticipant.setScreenShareEnabled(false);
        }
      } catch (error) {
        appendDebug(`Screen-share reconcile failed: ${(error as Error).message}`);
      }
    }

    if (localParticipant.isMicrophoneEnabled === intent.mic) {
      pendingMicDesiredRef.current = null;
      setPendingMicDesired(null);
    }
    if (localParticipant.isCameraEnabled === intent.cam) {
      pendingCamDesiredRef.current = null;
      setPendingCamDesired(null);
    }
    if ((screenShareManualActiveRef.current || localParticipant.isScreenShareEnabled) === intent.screen) {
      pendingScreenDesiredRef.current = null;
      setPendingScreenDesired(null);
    }

    setRoomVersion((v) => v + 1);
  }, [appendDebug, selectedMicId, selectedCamId]);

  const loadChatHistory = useCallback(async () => {
    if (!adminToken) return;

    try {
      const response = await fetch(
        `${resolveControlUrl(controlUrl)}/api/chat/history/${encodeURIComponent(activeRoom)}`,
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        },
      );

      if (!response.ok) return;

      const payload = (await response.json()) as ChatMessage[];
      setChatMessages(payload.filter((entry) => entry.room === activeRoom));
      appendDebug(`Loaded ${payload.length} chat history messages for ${activeRoom}`);
    } catch (error) {
      appendDebug(`Failed to load chat history: ${(error as Error).message}`);
    }
  }, [adminToken, controlUrl, activeRoom, appendDebug]);

  useEffect(() => {
    if (!snapshot.context.session) {
      setRoomConnectError(null);
      setConnectedRoomName(activeRoom);
      void disconnectRoom();
      return;
    }

    const session = snapshot.context.session;
    let cancelled = false;

    const nextRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    const bump = () => setRoomVersion((version) => version + 1);

    nextRoom
      .on(RoomEvent.Connected, () => {
        appendDebug('LiveKit room connected');
        void logStatsEvent('room-connected', activeRoom);
        setRoomConnectError(null);
        setConnectedRoomName(activeRoom);
        window.setTimeout(() => {
          void broadcastDeviceId();
          prefetchRoomChimeBuffers();
        }, 250);
        window.setTimeout(() => {
          void broadcastDeviceId();
        }, 1500);
        bump();
      })
      .on(RoomEvent.Disconnected, () => {
        appendDebug('LiveKit room disconnected');
        void logStatsEvent('room-disconnected', activeRoom);
        bump();
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        appendDebug(`Participant joined: ${participant.name || participant.identity}`);
        void playParticipantChime(participant.identity, 'enter');
        window.setTimeout(() => {
          void broadcastDeviceId();
        }, 200);
        bump();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        appendDebug(`Participant left: ${participant.name || participant.identity}`);
        void playParticipantChime(participant.identity, 'exit');
        bump();
      })
      .on(RoomEvent.TrackSubscribed, () => bump())
      .on(RoomEvent.TrackUnsubscribed, () => bump())
      .on(RoomEvent.LocalTrackPublished, () => bump())
      .on(RoomEvent.LocalTrackUnpublished, () => bump())
      .on(RoomEvent.ActiveSpeakersChanged, () => bump())
      .on(RoomEvent.DataReceived, (payload, participant) => {
        try {
          const text = new TextDecoder().decode(payload);
          const message = JSON.parse(text) as {
            type?: string;
            room?: string;
            id?: string;
            name?: string;
            identity?: string;
            host?: string;
            identityBase?: string;
            avatarUrl?: string;
            text?: string;
            timestamp?: number;
            fileUrl?: string;
            fileName?: string;
            fileType?: string;
            soundId?: string;
            soundName?: string;
            senderName?: string;
            deviceId?: string;
            [key: string]: unknown;
          };

          if (message.type === 'bitrate-cap') {
            if (!publisherCapManagerRef.current) {
              publisherCapManagerRef.current = new PublisherBitrateCapManager({
                localIdentity,
                senderProvider: () => {
                  if (screenShareVideoTrackRef.current?.sender) return screenShareVideoTrackRef.current.sender;
                  const publication = roomRef.current?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
                  return getTrackSender(publication?.track as LocalTrack | RemoteTrack | null | undefined);
                },
                sendData: async (encodedPayload, destinationIdentity) => {
                  const localRoom = roomRef.current;
                  if (!localRoom) return;
                  const options = {
                    reliable: true,
                    destinationIdentities: [destinationIdentity],
                  } as unknown as Parameters<LocalParticipant['publishData']>[1];
                  await localRoom.localParticipant.publishData(encodedPayload, options);
                },
              });
            }

            void publisherCapManagerRef.current.handleCapRequest(
              message as unknown as Partial<BitrateCapMessage>,
              participant?.identity,
            );
            return;
          }

          if (message.type === 'bitrate-cap-ack') {
            if (participant?.identity) {
              receiverAimdControllersRef.current.get(participant.identity)?.markAckReceived();
            }
            return;
          }

          if (message.type === CHAT_MESSAGE_TYPE || message.type === CHAT_FILE_TYPE) {
            if (message.room && message.room !== activeRoom) return;

            const incoming: ChatMessage = {
              id:
                message.id ||
                `${message.identity || participant?.identity || 'unknown'}-${message.timestamp || Date.now()}`,
              type: message.type,
              identity: message.identity || participant?.identity || 'unknown',
              name:
                message.name || participant?.name || participant?.identity || message.identity || 'Unknown',
              text: message.text || '',
              timestamp: message.timestamp || Date.now(),
              room: message.room || activeRoom,
              fileUrl: message.fileUrl,
              fileName: message.fileName,
              fileType: message.fileType,
            };

            if (incoming.identity === localIdentity) return;

            setChatMessages((prev) => [...prev, incoming]);
            if (!chatOpen) {
              setUnreadChatCount((count) => count + 1);
            }
            return;
          }

          if (message.type === 'chat-delete' && message.id) {
            setChatMessages((prev) => prev.filter((entry) => entry.id !== message.id));
            return;
          }

          const soundboardPlay = parseSoundboardPlayMessage(message);
          if (soundboardPlay) {
            const sounds = soundboardSoundsRef.current;
            const resolvedSoundId =
              soundboardPlay.soundId ??
              sounds.find((sound) =>
                sound.name.trim().toLowerCase() === soundboardPlay.soundName.trim().toLowerCase(),
              )?.id ??
              null;

            if (resolvedSoundId) {
              const clipVolume =
                sounds.find((sound) => sound.id === resolvedSoundId)?.volume ??
                soundClipVolumeRef.current;
              void playSoundByIdRef.current(resolvedSoundId, clipVolume);
            }
            setSoundboardHint(formatSoundboardHint(soundboardPlay.senderName, soundboardPlay.soundName));
            return;
          }

          if (message.type === 'device-id' && message.identityBase && message.deviceId) {
            const idBase = String(message.identityBase || '').trim();
            const deviceId = String(message.deviceId || '').trim();
            if (!idBase || !deviceId) return;
            deviceIdByIdentityRef.current.set(idBase, deviceId);
            appendDebug(`[device-profile] mapped ${idBase} -> ${deviceId}`);
            void fetchChimeBufferRef.current(deviceId, 'enter');
            void fetchChimeBufferRef.current(deviceId, 'exit');
            return;
          }

          if (message.type === 'sound-added' || message.type === 'sound-updated') {
            setSoundboardHint('Soundboard updated.');
            setSoundboardReloadTick((tick) => tick + 1);
            return;
          }

          if (message.type === 'avatar-update' && message.identityBase && message.avatarUrl) {
            const idBase = String(message.identityBase || '');
            if (!idBase) return;
            const resolved = message.avatarUrl.startsWith('http://') || message.avatarUrl.startsWith('https://')
              ? message.avatarUrl
              : `${resolveControlUrl(controlUrl)}${message.avatarUrl}`;
            setAvatarUrls((prev) => ({ ...prev, [idBase]: resolved }));
            return;
          }

          if (message.type === 'jam-started') {
            setJamStatus(`${message.host || 'Host'} started a jam session.`);
            return;
          }

          if (message.type === 'jam-stopped') {
            setJamStatus('Jam session ended.');
          }
        } catch {
          // ignore non-json data messages
        }
      });

    roomRef.current = nextRoom;

    const run = async () => {
      try {
        await disconnectRoom();
        roomRef.current = nextRoom;

        let iceServers: IceServerConfig[] = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ];

        try {
          const iceResponse = await fetch(`${resolveControlUrl(controlUrl)}/v1/ice-servers`, {
            headers: {
              Authorization: `Bearer ${session.adminToken}`,
            },
          });

          if (iceResponse.ok) {
            const icePayload = (await iceResponse.json()) as { iceServers?: IceServerConfig[] };
            if (Array.isArray(icePayload.iceServers) && icePayload.iceServers.length > 0) {
              iceServers = icePayload.iceServers;
              appendDebug(`[ice] fetched ${iceServers.length} ICE servers from control plane`);
            }
          } else {
            appendDebug(`[ice] /v1/ice-servers returned ${iceResponse.status}, using STUN fallback`);
          }
        } catch {
          appendDebug('[ice] failed to fetch ICE config, using STUN fallback');
        }

        await nextRoom.connect(session.request.sfuUrl, session.roomToken, {
          autoSubscribe: true,
          rtcConfig: {
            iceServers,
          },
        });
        if (cancelled) {
          await nextRoom.disconnect();
          return;
        }

        setConnectedRoomName(activeRoom);
        await reconcileMediaIntent(nextRoom);
        bump();
        await refreshDevices();
        await loadChatHistory();
      } catch (error) {
        setRoomConnectError((error as Error).message);
        appendDebug(`LiveKit connect failed: ${(error as Error).message}`);
      }
    };

    void run();

    return () => {
      cancelled = true;
      nextRoom.removeAllListeners();
      void nextRoom.disconnect().catch(() => undefined);
      if (roomRef.current === nextRoom) {
        roomRef.current = null;
      }
    };
  }, [
    snapshot.context.session?.roomToken,
    snapshot.context.session?.request.sfuUrl,
    snapshot.context.session?.adminToken,
    activeRoom,
    localIdentity,
    chatOpen,
    controlUrl,
    appendDebug,
    disconnectRoom,
    refreshDevices,
    loadChatHistory,
    reconcileMediaIntent,
    logStatsEvent,
    playParticipantChime,
  ]);

  const onConnect = useCallback(() => {
    actorRef.send({ type: 'CONNECT', request: buildConnectionRequest() });
  }, [actorRef, buildConnectionRequest]);

  const onDisconnect = useCallback(() => {
    sendLeaveNotification();
    stopHeartbeat();
    void logStatsEvent('disconnect-click');
    actorRef.send({ type: 'DISCONNECT' });
    void disconnectRoom();
    setRoomAudioMuted(false);
    appendDebug('Disconnected by user');
  }, [actorRef, disconnectRoom, appendDebug, sendLeaveNotification, stopHeartbeat, logStatsEvent]);

  const onSwitchRoom = useCallback(
    (roomId: (typeof FIXED_ROOMS)[number]) => {
      setField('room', roomId);
      appendDebug(`Switching room to ${roomId}`);
      if (connected || provisioning) {
        actorRef.send({ type: 'CONNECT', request: buildConnectionRequest(roomId) });
      }
    },
    [appendDebug, connected, provisioning, actorRef, buildConnectionRequest, setField],
  );

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    const current = pendingMicDesiredRef.current ?? room?.localParticipant.isMicrophoneEnabled ?? localMediaState.mic;
    const desired = !current;

    mediaIntentRef.current.mic = desired;
    const seq = micToggleSeqRef.current + 1;
    micToggleSeqRef.current = seq;
    pendingMicDesiredRef.current = desired;
    setPendingMicDesired(desired);
    setRoomVersion((v) => v + 1);

    if (!room) return;

    try {
      await room.localParticipant.setMicrophoneEnabled(desired, {
        deviceId: desired ? (selectedMicId || undefined) : undefined,
      });
      if (desired) {
        await applyRnnoiseToLocalMicRef.current();
      } else {
        await rnnoiseProcessorRef.current.disable();
      }
      appendDebug(desired ? 'Microphone enabled' : 'Microphone disabled');
      void logStatsEvent(desired ? 'mic-enabled' : 'mic-disabled');
    } catch (error) {
      appendDebug(`Mic toggle failed: ${(error as Error).message}`);
      setDeviceStatus(`Mic toggle failed: ${(error as Error).message}`);
    } finally {
      if (micToggleSeqRef.current === seq) {
        pendingMicDesiredRef.current = null;
        setPendingMicDesired(null);
        setRoomVersion((v) => v + 1);
      }
    }
  }, [appendDebug, localMediaState.mic, selectedMicId, logStatsEvent]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    const current = pendingCamDesiredRef.current ?? room?.localParticipant.isCameraEnabled ?? localMediaState.cam;
    const desired = !current;

    mediaIntentRef.current.cam = desired;
    const seq = camToggleSeqRef.current + 1;
    camToggleSeqRef.current = seq;
    pendingCamDesiredRef.current = desired;
    setPendingCamDesired(desired);
    setRoomVersion((v) => v + 1);

    if (!room) return;

    try {
      await room.localParticipant.setCameraEnabled(desired, {
        deviceId: desired ? (selectedCamId || undefined) : undefined,
      });
      appendDebug(desired ? 'Camera enabled' : 'Camera disabled');
      void logStatsEvent(desired ? 'camera-enabled' : 'camera-disabled');
    } catch (error) {
      appendDebug(`Camera toggle failed: ${(error as Error).message}`);
      setDeviceStatus(`Camera toggle failed: ${(error as Error).message}`);
    } finally {
      if (camToggleSeqRef.current === seq) {
        pendingCamDesiredRef.current = null;
        setPendingCamDesired(null);
        setRoomVersion((v) => v + 1);
      }
    }
  }, [appendDebug, localMediaState.cam, selectedCamId, logStatsEvent]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    const actualScreenState =
      screenShareManualActiveRef.current
      || Boolean(room?.localParticipant.isScreenShareEnabled);
    const current = pendingScreenDesiredRef.current ?? actualScreenState;
    const desired = !current;

    mediaIntentRef.current.screen = desired;
    const seq = screenToggleSeqRef.current + 1;
    screenToggleSeqRef.current = seq;
    pendingScreenDesiredRef.current = desired;
    setPendingScreenDesired(desired);
    setRoomVersion((v) => v + 1);

    if (!room) return;

    try {
      if (desired) {
        const parityStarted = await startManualScreenShareRef.current();
        if (!parityStarted) {
          await room.localParticipant.setScreenShareEnabled(true, { audio: true });
          screenShareManualActiveRef.current = false;
        }
      } else if (screenShareManualActiveRef.current) {
        await stopManualScreenShareRef.current();
      } else {
        await room.localParticipant.setScreenShareEnabled(false);
      }

      appendDebug(desired ? 'Screen share started' : 'Screen share stopped');
      void logStatsEvent(desired ? 'screen-share-start' : 'screen-share-stop');
    } catch (error) {
      appendDebug(`Screen share toggle failed: ${(error as Error).message}`);
      setDeviceStatus(`Screen share toggle failed: ${(error as Error).message}`);
    } finally {
      if (screenToggleSeqRef.current === seq) {
        pendingScreenDesiredRef.current = null;
        setPendingScreenDesired(null);
        setRoomVersion((v) => v + 1);
      }
    }
  }, [appendDebug, logStatsEvent]);

  const switchMicDevice = useCallback(
    async (deviceId: string) => {
      setSelectedMicId(deviceId);
      if (!micEnabled || !roomRef.current) return;

      try {
        await roomRef.current.localParticipant.setMicrophoneEnabled(true, {
          deviceId,
        });
        await applyRnnoiseToLocalMicRef.current();
        appendDebug(`Switched microphone: ${deviceId}`);
      } catch (error) {
        setDeviceStatus(`Mic switch failed: ${(error as Error).message}`);
      }
    },
    [appendDebug, micEnabled],
  );

  const switchCamDevice = useCallback(
    async (deviceId: string) => {
      setSelectedCamId(deviceId);
      if (!camEnabled || !roomRef.current) return;

      try {
        await roomRef.current.localParticipant.setCameraEnabled(true, {
          deviceId,
        });
        appendDebug(`Switched camera: ${deviceId}`);
      } catch (error) {
        setDeviceStatus(`Camera switch failed: ${(error as Error).message}`);
      }
    },
    [appendDebug, camEnabled],
  );

  const updateParticipantVolume = useCallback(
    (targetIdentity: string, kind: 'mic' | 'screen', volume: number) => {
      setParticipantVolume(participantVolumesRef.current, targetIdentity, kind, volume);
      setStoredValue(PARTICIPANT_VOLUME_STORAGE_KEY, JSON.stringify(participantVolumesRef.current));

      remoteMediaElementsRef.current.forEach((element) => {
        const binding = mediaBindingRef.current.get(element);
        if (!binding) return;
        if (binding.identity !== targetIdentity) return;
        if (binding.kind !== kind) return;

        const nextVolume = getParticipantVolume(participantVolumesRef.current, targetIdentity, kind);
        volumeBoostRef.current.applyVolume(element, nextVolume, roomAudioMuted);
      });

      setVolumeRevision((value) => value + 1);
    },
    [roomAudioMuted],
  );

  const attachCameraRecovery = useCallback(
    (
      identity: string,
      publication: TrackPublication | undefined,
      track: LocalTrack | RemoteTrack | null,
      element: HTMLMediaElement,
    ) => {
      if (!(element instanceof HTMLVideoElement)) return;

      const key = `${identity}-camera`;
      cameraRecoveryDetachRef.current.get(key)?.();
      const detach = cameraRecoveryMonitorRef.current.attach({
        key,
        video: element,
        publication: publication as unknown as { setSubscribed?: (value: boolean) => void; videoTrack?: { requestKeyFrame?: () => void } } | undefined,
        track: track as unknown as { requestKeyFrame?: () => void } | null,
        onDebug: appendDebug,
      });
      cameraRecoveryDetachRef.current.set(key, detach);
    },
    [appendDebug],
  );

  const detachCameraRecovery = useCallback((identity: string) => {
    const key = `${identity}-camera`;
    const detach = cameraRecoveryDetachRef.current.get(key);
    if (detach) {
      detach();
      cameraRecoveryDetachRef.current.delete(key);
    }
  }, []);

  const saveChatMessage = useCallback(
    async (message: ChatMessage) => {
      if (!adminToken) return;
      try {
        await fetch(`${resolveControlUrl(controlUrl)}/api/chat/message`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
        });
      } catch (error) {
        appendDebug(`Failed to save chat message: ${(error as Error).message}`);
      }
    },
    [adminToken, controlUrl, appendDebug],
  );

  const publishData = useCallback(async (payload: object) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      await room.localParticipant.publishData(encoded, { reliable: true });
    } catch (error) {
      appendDebug(`Data publish failed: ${(error as Error).message}`);
    }
  }, [appendDebug]);

  const publishDataToIdentity = useCallback(async (payload: object, destinationIdentity: string) => {
    const room = roomRef.current;
    if (!room || !destinationIdentity) return;

    try {
      const encoded = new TextEncoder().encode(JSON.stringify(payload));
      const options = {
        reliable: true,
        destinationIdentities: [destinationIdentity],
      } as unknown as Parameters<LocalParticipant['publishData']>[1];

      await room.localParticipant.publishData(encoded, options);
    } catch {
      await publishData(payload);
    }
  }, [publishData]);

  async function broadcastDeviceId() {
    const room = roomRef.current;
    if (!room?.localParticipant) return;

    const identity = room.localParticipant.identity;
    const payload = {
      type: 'device-id',
      identityBase: identityBase(identity),
      deviceId: localDeviceIdRef.current,
    };

    try {
      await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
        reliable: true,
      });
    } catch {
      // best effort
    }
  }

  function prefetchRoomChimeBuffers() {
    const room = roomRef.current;
    if (!room) return;

    room.remoteParticipants.forEach((participant) => {
      const chimeIdentity = resolveChimeIdentity(
        participant.identity,
        identityBase,
        deviceIdByIdentityRef.current,
      );
      void fetchChimeBufferRef.current(chimeIdentity, 'enter');
      void fetchChimeBufferRef.current(chimeIdentity, 'exit');
    });
  }

  const getLocalScreenSender = useCallback((): RTCRtpSender | null => {
    if (screenShareVideoTrackRef.current?.sender) return screenShareVideoTrackRef.current.sender;

    const room = roomRef.current;
    if (!room) return null;

    const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    return getTrackSender(publication?.track as LocalTrack | RemoteTrack | null | undefined);
  }, []);

  const stopManualScreenShare = useCallback(async () => {
    const room = roomRef.current;

    screenSharePipelineRef.current?.stop();
    screenSharePipelineRef.current = null;

    if (room && screenShareVideoTrackRef.current) {
      try {
        await room.localParticipant.unpublishTrack(screenShareVideoTrackRef.current, true);
      } catch {
        // ignore unpublish errors
      }
    }

    if (room && screenShareAudioTrackRef.current) {
      try {
        await room.localParticipant.unpublishTrack(screenShareAudioTrackRef.current, true);
      } catch {
        // ignore unpublish errors
      }
    }

    try {
      screenShareVideoTrackRef.current?.mediaStreamTrack?.stop();
      screenShareAudioTrackRef.current?.mediaStreamTrack?.stop();
    } catch {
      // ignore stop errors
    }

    screenShareVideoTrackRef.current = null;
    screenShareAudioTrackRef.current = null;
    screenShareManualActiveRef.current = false;
    receiverAimdControllersRef.current.clear();

    if (publisherCapManagerRef.current) {
      await publisherCapManagerRef.current.clear();
    }

    bweWatchdogRef.current.reset();
  }, []);

  const startManualScreenShare = useCallback(async (): Promise<boolean> => {
    const room = roomRef.current;
    const participant = room?.localParticipant;
    if (!room || !participant) return false;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      return false;
    }

    if (typeof LocalVideoTrack !== 'function') {
      return false;
    }

    let capture: MediaStream | null = null;
    let videoSourceTrack: MediaStreamTrack | null = null;

    try {
      capture = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60 },
          resizeMode: 'none' as ConstrainDOMString,
        },
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        systemAudio: 'include' as any,
      } as DisplayMediaStreamOptions & { systemAudio?: string });

      videoSourceTrack = capture.getVideoTracks()[0] ?? null;
      if (!videoSourceTrack) {
        throw new Error('Display capture returned no video track');
      }

      const pipeline = createCanvasScreenSharePipeline(videoSourceTrack, {
        logger: (line) => appendDebug(line),
      });
      screenSharePipelineRef.current = pipeline;

      const localVideoTrack = new LocalVideoTrack(pipeline.publishTrack, undefined, false);
      await participant.publishTrack(localVideoTrack as unknown as LocalTrack, {
        source: Track.Source.ScreenShare,
        ...buildScreenSharePublishOptions(pipeline.width, pipeline.height),
      } as any);

      const sender = localVideoTrack.sender;
      if (sender) {
        try {
          const params = sender.getParameters();
          params.encodings?.forEach((encoding) => {
            if (encoding.rid === 'f' || (!encoding.rid && (params.encodings?.length ?? 0) === 1)) {
              encoding.maxBitrate = BITRATE_DEFAULT_HIGH;
              encoding.maxFramerate = 60;
              encoding.scaleResolutionDownBy = 1;
            } else if (encoding.rid === 'h') {
              encoding.maxBitrate = BITRATE_DEFAULT_MED;
              encoding.maxFramerate = 60;
              encoding.scaleResolutionDownBy = 2;
            } else if (encoding.rid === 'q') {
              encoding.maxBitrate = BITRATE_DEFAULT_LOW;
              encoding.maxFramerate = 30;
              encoding.scaleResolutionDownBy = 3;
            }
          });
          await sender.setParameters(params);
        } catch {
          // best effort sender tune
        }
      }

      screenShareVideoTrackRef.current = localVideoTrack;

      const sourceAudio = capture.getAudioTracks()[0] ?? null;
      if (sourceAudio && typeof LocalAudioTrack === 'function') {
        const localAudioTrack = new LocalAudioTrack(sourceAudio, undefined, false);
        const screenAudioSource =
          (Track.Source as Record<string, string | undefined>).ScreenShareAudio
          ?? 'screen_share_audio';

        await participant.publishTrack(localAudioTrack as unknown as LocalTrack, {
          source: screenAudioSource,
          ...SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS,
        } as any);

        screenShareAudioTrackRef.current = localAudioTrack;
      }

      videoSourceTrack.addEventListener(
        'ended',
        () => {
          mediaIntentRef.current.screen = false;
          pendingScreenDesiredRef.current = null;
          setPendingScreenDesired(null);
          void stopManualScreenShare();
          setRoomVersion((value) => value + 1);
        },
        { once: true },
      );

      screenShareManualActiveRef.current = true;
      appendDebug('Screen share started (canvas-pipeline parity path)');

      if (!publisherCapManagerRef.current) {
        publisherCapManagerRef.current = new PublisherBitrateCapManager({
          localIdentity,
          senderProvider: getLocalScreenSender,
          sendData: async (payload, destinationIdentity) => {
            const localRoom = roomRef.current;
            if (!localRoom) return;
            const options = {
              reliable: true,
              destinationIdentities: [destinationIdentity],
            } as unknown as Parameters<LocalParticipant['publishData']>[1];
            await localRoom.localParticipant.publishData(payload, options);
          },
        });
      }

      return true;
    } catch (error) {
      appendDebug(`Screen share parity path failed: ${(error as Error).message}`);
      screenSharePipelineRef.current?.stop();
      screenSharePipelineRef.current = null;
      capture?.getTracks().forEach((track) => track.stop());
      videoSourceTrack?.stop();
      await stopManualScreenShare();
      return false;
    }
  }, [appendDebug, getLocalScreenSender, localIdentity, stopManualScreenShare]);

  useEffect(() => {
    startManualScreenShareRef.current = startManualScreenShare;
  }, [startManualScreenShare]);

  useEffect(() => {
    stopManualScreenShareRef.current = stopManualScreenShare;
  }, [stopManualScreenShare]);

  const applyRnnoiseToLocalMic = useCallback(async () => {
    if (!noiseCancelEnabled) {
      await rnnoiseProcessorRef.current.disable();
      return;
    }

    const room = roomRef.current;
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = publication?.track as LocalTrack | RemoteTrack | null | undefined;
    const sender = getTrackSender(track);
    const mediaStreamTrack = getTrackMediaStreamTrack(track);

    if (!sender || !mediaStreamTrack || mediaStreamTrack.kind !== 'audio') {
      return;
    }

    try {
      await rnnoiseProcessorRef.current.enableForSender(sender, mediaStreamTrack, {
        suppressionLevel: noiseCancelLevel,
        logger: appendDebug,
      });
      appendDebug('[rnnoise] enabled for local microphone');
    } catch (error) {
      appendDebug(`[rnnoise] enable failed: ${(error as Error).message}`);
    }
  }, [appendDebug, noiseCancelEnabled, noiseCancelLevel]);

  useEffect(() => {
    applyRnnoiseToLocalMicRef.current = applyRnnoiseToLocalMic;
  }, [applyRnnoiseToLocalMic]);

  useEffect(() => {
    if (!connected || !micEnabled) {
      void rnnoiseProcessorRef.current.disable();
      return;
    }

    void applyRnnoiseToLocalMic();
  }, [connected, micEnabled, applyRnnoiseToLocalMic]);

  useEffect(() => {
    if (outboundBweTimerRef.current) {
      window.clearInterval(outboundBweTimerRef.current);
      outboundBweTimerRef.current = null;
    }

    if (capCleanupTimerRef.current) {
      window.clearInterval(capCleanupTimerRef.current);
      capCleanupTimerRef.current = null;
    }

    if (!connected) return;

    outboundBweTimerRef.current = window.setInterval(() => {
      void (async () => {
        const room = roomRef.current;
        const sender = getLocalScreenSender();
        if (!room || !sender) return;

        try {
          const reports = await sender.getStats();
          let bytesSent = 0;
          let bweKbps: number | null = null;
          const layers: Array<{ rid: string; fps: number; limit: string }> = [];

          reports.forEach((report) => {
            if (report.type === 'outbound-rtp' && !('isRemote' in report && report.isRemote)) {
              bytesSent += Number((report as RTCOutboundRtpStreamStats).bytesSent ?? 0);
              layers.push({
                rid: String((report as RTCOutboundRtpStreamStats).rid ?? 'single'),
                fps: Number((report as RTCOutboundRtpStreamStats).framesPerSecond ?? 0),
                limit: String((report as RTCOutboundRtpStreamStats).qualityLimitationReason ?? 'none'),
              });
            }

            if (report.type === 'candidate-pair') {
              const pair = report as RTCIceCandidatePairStats & { selected?: boolean };
              const selected = pair.selected ?? pair.nominated;
              if (selected && Number.isFinite(pair.availableOutgoingBitrate ?? NaN)) {
                bweKbps = Math.round(Number(pair.availableOutgoingBitrate ?? 0) / 1000);
              }
            }
          });

          const now = Date.now();
          const previous = outboundPrevStatsRef.current;
          let totalSendKbps = 0;

          if (previous && now > previous.timestamp) {
            const deltaBytes = Math.max(0, bytesSent - previous.bytesSent);
            const deltaMs = now - previous.timestamp;
            totalSendKbps = Math.round((deltaBytes * 8) / deltaMs);
          }

          outboundPrevStatsRef.current = { bytesSent, timestamp: now };

          const actions = bweWatchdogRef.current.evaluate(
            {
              bweKbps,
              totalSendKbps,
              layers,
            },
            publisherCapManagerRef.current?.getAppliedCap() ?? null,
          );

          for (const action of actions) {
            await applyBweActionToSender(sender, action);
          }
        } catch {
          // ignore outbound stats failures
        }

        for (const participant of room.remoteParticipants.values()) {
          const screenPublication = participant.getTrackPublication(Track.Source.ScreenShare);
          const remoteTrack = screenPublication?.track as
            | (RemoteTrack & { receiver?: RTCRtpReceiver })
            | null
            | undefined;

          const receiver = remoteTrack?.receiver;
          if (!receiver?.getStats) continue;

          try {
            const stats = await receiver.getStats();
            let packetsLost = 0;
            let bytesReceived = 0;

            stats.forEach((entry) => {
              if (entry.type !== 'inbound-rtp') return;
              const inbound = entry as RTCInboundRtpStreamStats;
              if (inbound.kind !== 'video') return;
              packetsLost += Number(inbound.packetsLost ?? 0);
              bytesReceived += Number(inbound.bytesReceived ?? 0);
            });

            const now = Date.now();
            const prevLost = inboundPrevLostRef.current.get(participant.identity) ?? packetsLost;
            const deltaLost = Math.max(0, packetsLost - prevLost);
            inboundPrevLostRef.current.set(participant.identity, packetsLost);

            const prevBytes = inboundPrevBytesRef.current.get(participant.identity);
            let kbps = 0;
            if (prevBytes && now > prevBytes.timestamp) {
              kbps = Math.round(((bytesReceived - prevBytes.bytes) * 8) / (now - prevBytes.timestamp));
            }
            inboundPrevBytesRef.current.set(participant.identity, { bytes: bytesReceived, timestamp: now });

            const controller =
              receiverAimdControllersRef.current.get(participant.identity)
              ?? new ReceiverAimdController();
            receiverAimdControllersRef.current.set(participant.identity, controller);

            const result = controller.update({
              deltaLost,
              receivedKbps: Math.max(0, kbps),
              localIdentity,
              nowMs: now,
            });

            if (result.outboundMessage) {
              await publishDataToIdentity(result.outboundMessage, participant.identity);
            }
          } catch {
            // ignore receiver stats failures
          }
        }

        await publisherCapManagerRef.current?.tickCleanup();
      })();
    }, 3_000);

    capCleanupTimerRef.current = window.setInterval(() => {
      void publisherCapManagerRef.current?.tickCleanup();
    }, 5_000);

    return () => {
      if (outboundBweTimerRef.current) {
        window.clearInterval(outboundBweTimerRef.current);
        outboundBweTimerRef.current = null;
      }
      if (capCleanupTimerRef.current) {
        window.clearInterval(capCleanupTimerRef.current);
        capCleanupTimerRef.current = null;
      }
      outboundPrevStatsRef.current = null;
      inboundPrevLostRef.current.clear();
      inboundPrevBytesRef.current.clear();
      receiverAimdControllersRef.current.clear();
      bweWatchdogRef.current.reset();
    };
  }, [connected, getLocalScreenSender, localIdentity, publishDataToIdentity]);

  const sendChatMessage = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const text = chatInput.trim();
      if (!text || !connected) return;

      const localName = roomRef.current?.localParticipant?.name || name || 'Viewer';
      const localIdentityValue = roomRef.current?.localParticipant?.identity || localIdentity || 'viewer';

      const message: ChatMessage = {
        id: `${localIdentityValue}-${Date.now()}`,
        type: CHAT_MESSAGE_TYPE,
        identity: localIdentityValue,
        name: localName,
        text,
        timestamp: Date.now(),
        room: activeRoom,
      };

      setChatMessages((prev) => [...prev, message]);
      setChatInput('');
      setEmojiPickerOpen(false);

      await publishData(message);
      await saveChatMessage(message);
    },
    [chatInput, connected, name, localIdentity, activeRoom, publishData, saveChatMessage],
  );

  const uploadChatFile = useCallback(
    async (file: File) => {
      if (!adminToken) {
        appendDebug('Cannot upload chat file without admin token');
        return null;
      }

      try {
        const bytes = await file.arrayBuffer();
        const response = await fetch(
          `${resolveControlUrl(controlUrl)}/api/chat/upload?room=${encodeURIComponent(activeRoom)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
            },
            body: bytes,
          },
        );

        if (!response.ok) return null;
        const payload = (await response.json()) as { ok?: boolean; url?: string };
        if (!payload.ok || !payload.url) return null;

        return {
          url: payload.url,
          name: file.name,
          type: file.type,
        };
      } catch (error) {
        appendDebug(`Chat upload failed: ${(error as Error).message}`);
        return null;
      }
    },
    [adminToken, controlUrl, activeRoom, appendDebug],
  );

  const onChatUploadChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !connected) return;
      const upload = await uploadChatFile(file);
      if (!upload) return;

      const localName = roomRef.current?.localParticipant?.name || name || 'Viewer';
      const localIdentityValue = roomRef.current?.localParticipant?.identity || localIdentity || 'viewer';

      const message: ChatMessage = {
        id: `${localIdentityValue}-${Date.now()}`,
        type: CHAT_FILE_TYPE,
        identity: localIdentityValue,
        name: localName,
        text: chatInput.trim(),
        timestamp: Date.now(),
        room: activeRoom,
        fileUrl: upload.url,
        fileName: upload.name,
        fileType: upload.type,
      };

      setChatMessages((prev) => [...prev, message]);
      setChatInput('');
      await publishData(message);
      await saveChatMessage(message);
      event.target.value = '';
    },
    [activeRoom, chatInput, connected, localIdentity, name, publishData, saveChatMessage, uploadChatFile],
  );

  const deleteChatMessage = useCallback(
    async (message: ChatMessage) => {
      if (!adminToken || !connected || !message.id) return;
      const localIdentityValue = roomRef.current?.localParticipant?.identity || localIdentity;
      if (!localIdentityValue || message.identity !== localIdentityValue) return;

      try {
        await fetch(apiUrl('/api/chat/delete'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: message.id,
            identity: localIdentityValue,
            room: activeRoom,
          }),
        });
      } catch (error) {
        appendDebug(`Failed to delete chat message: ${(error as Error).message}`);
        return;
      }

      setChatMessages((prev) => prev.filter((entry) => entry.id !== message.id));
      await publishData({
        type: 'chat-delete',
        id: message.id,
        identity: localIdentityValue,
        room: activeRoom,
      });
    },
    [adminToken, connected, localIdentity, apiUrl, activeRoom, appendDebug, publishData],
  );

  const onChatKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void sendChatMessage();
      }
    },
    [sendChatMessage],
  );

  const addEmoji = useCallback((emoji: string) => {
    setChatInput((prev) => `${prev}${emoji}`);
    setEmojiPickerOpen(false);
  }, []);

  const resolveFileUrl = useCallback(
    (path: string) => {
      if (!path) return '';
      if (path.startsWith('http://') || path.startsWith('https://')) return path;
      return `${resolveControlUrl(controlUrl)}${path}`;
    },
    [controlUrl],
  );

  const resolveAvatarUrl = useCallback(
    (participantIdentity: string) => {
      const key = identityBase(participantIdentity);
      return avatarUrls[key] || '';
    },
    [avatarUrls],
  );

  const loadLocalAvatar = useCallback(async () => {
    if (!adminToken || !localChimeIdentity) return;
    try {
      const response = await fetch(
        `${resolveControlUrl(controlUrl)}/api/avatar/${encodeURIComponent(localChimeIdentity)}`,
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        },
      );
      if (!response.ok) return;
      const relativePath = `/api/avatar/${encodeURIComponent(localChimeIdentity)}?t=${Date.now()}`;
      const resolved = resolveFileUrl(relativePath);
      setAvatarUrls((prev) => ({ ...prev, [localChimeIdentity]: resolved }));
    } catch {
      // ignore avatar load failures
    }
  }, [adminToken, localChimeIdentity, controlUrl, resolveFileUrl]);

  const uploadAvatar = useCallback(
    async (file: File) => {
      if (!adminToken || !localChimeIdentity) return;
      try {
        const response = await fetch(
          `${resolveControlUrl(controlUrl)}/api/avatar/upload?identity=${encodeURIComponent(localChimeIdentity)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
              'Content-Type': file.type || 'application/octet-stream',
            },
            body: await file.arrayBuffer(),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; url?: string };
        if (!response.ok || !payload.ok) {
          appendDebug(`Avatar upload failed (${response.status})`);
          return;
        }

        const relativePath = payload.url || `/api/avatar/${encodeURIComponent(localChimeIdentity)}`;
        const resolved = resolveFileUrl(relativePath) + (relativePath.includes('?') ? '&' : '?') + `t=${Date.now()}`;
        setAvatarUrls((prev) => ({ ...prev, [localChimeIdentity]: resolved }));

        const room = roomRef.current;
        if (room?.localParticipant) {
          const payloadData = JSON.stringify({
            type: 'avatar-update',
            identityBase: localChimeIdentity,
            avatarUrl: relativePath,
          });
          await room.localParticipant.publishData(new TextEncoder().encode(payloadData), {
            reliable: true,
          });
        }
      } catch (error) {
        appendDebug(`Avatar upload failed: ${(error as Error).message}`);
      }
    },
    [adminToken, localChimeIdentity, controlUrl, resolveFileUrl, appendDebug],
  );

  const loadSoundboard = useCallback(async () => {
    if (!adminToken) return;

    try {
      const response = await fetch(
        apiUrl(`/api/soundboard/list?roomId=${encodeURIComponent(activeRoom)}`),
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        },
      );

      if (!response.ok) {
        setSoundboardHint(`Failed to load soundboard (${response.status})`);
        return;
      }

      const payload = (await response.json()) as {
        sounds?: Array<{ id: string; name: string; icon?: string; volume?: number }>;
      };

      const favorites = safeJsonParse<string[]>(getStoredValue('echo-soundboard-favorites'), []);

      setSoundboardSounds(
        (payload.sounds ?? []).map((sound) => ({
          id: sound.id,
          name: sound.name,
          icon: sound.icon || '🔊',
          volume: sound.volume ?? 100,
          favorite: favorites.includes(sound.id),
        })),
      );

      setSoundboardHint('');
    } catch (error) {
      setSoundboardHint(`Failed to load soundboard: ${(error as Error).message}`);
    }
  }, [adminToken, activeRoom, apiUrl]);

  const toggleSoundFavorite = useCallback((id: string) => {
    setSoundboardSounds((prev) => {
      const next = prev.map((sound) =>
        sound.id === id ? { ...sound, favorite: !sound.favorite } : sound,
      );
      setStoredValue(
        'echo-soundboard-favorites',
        JSON.stringify(next.filter((sound) => sound.favorite).map((sound) => sound.id)),
      );
      return next;
    });
  }, []);

  const ensureSoundboardAudioContext = useCallback(async () => {
    let context = soundboardAudioCtxRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContext();
      soundboardAudioCtxRef.current = context;
      const gain = context.createGain();
      gain.connect(context.destination);
      soundboardMasterGainRef.current = gain;
    }

    if (context.state === 'suspended') {
      await context.resume();
    }

    if (soundboardMasterGainRef.current) {
      soundboardMasterGainRef.current.gain.value = Math.max(0, Math.min(100, soundboardVolume)) / 100;
    }

    return context;
  }, [soundboardVolume]);

  const fetchSoundboardBuffer = useCallback(
    async (soundId: string) => {
      if (soundboardBufferCacheRef.current.has(soundId)) {
        return soundboardBufferCacheRef.current.get(soundId) ?? null;
      }

      if (!adminToken) return null;

      const context = await ensureSoundboardAudioContext();
      const response = await fetch(apiUrl(`/api/soundboard/file/${encodeURIComponent(soundId)}`), {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (!response.ok) return null;

      const buffer = await response.arrayBuffer();
      const decoded = await context.decodeAudioData(buffer.slice(0));
      soundboardBufferCacheRef.current.set(soundId, decoded);
      return decoded;
    },
    [adminToken, apiUrl, ensureSoundboardAudioContext],
  );

  const playSoundById = useCallback(
    async (soundId: string, clipVolume = 100) => {
      const context = await ensureSoundboardAudioContext();
      const masterGain = soundboardMasterGainRef.current;
      if (!masterGain) return false;

      const buffer = await fetchSoundboardBuffer(soundId);
      if (!buffer) return false;

      const previousSource = soundboardCurrentSourceRef.current;
      if (previousSource) {
        try {
          previousSource.stop();
        } catch {
          // ignore stop failures
        }
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      const clipGain = context.createGain();
      clipGain.gain.value = Math.max(0, Math.min(200, clipVolume)) / 100;
      source.connect(clipGain);
      clipGain.connect(masterGain);

      source.onended = () => {
        if (soundboardCurrentSourceRef.current === source) {
          soundboardCurrentSourceRef.current = null;
        }
      };

      soundboardCurrentSourceRef.current = source;
      source.start(0);
      return true;
    },
    [ensureSoundboardAudioContext, fetchSoundboardBuffer],
  );

  useEffect(() => {
    playSoundByIdRef.current = playSoundById;
  }, [playSoundById]);

  const playSound = useCallback(
    async (sound: SoundboardSound) => {
      const played = await playSoundById(sound.id, sound.volume);
      if (!played) {
        setSoundboardHint('Unable to play sound.');
        return;
      }

      const senderName = roomRef.current?.localParticipant?.name || name || 'Viewer';
      setSoundboardHint(`Played ${sound.name}`);

      const payloads = buildSoundboardBroadcastPayloads({
        room: activeRoom,
        soundId: sound.id,
        senderName,
        soundName: sound.name,
      });

      await Promise.all(payloads.map((payload) => publishData(payload)));
    },
    [playSoundById, name, activeRoom, publishData],
  );

  const exitSoundboardEditMode = useCallback(() => {
    setSoundboardEditingId(null);
    setSoundboardSelectedIcon(SOUNDBOARD_ICONS[0]);
    setSoundNameInput('');
    setSoundFileLabel('Select audio');
    soundUploadFileRef.current = null;
    setSoundboardHint('');
  }, []);

  const enterSoundboardEditMode = useCallback((sound: SoundboardSound) => {
    setSoundboardEditingId(sound.id);
    setSoundNameInput(sound.name || '');
    setSoundboardSelectedIcon(sound.icon || SOUNDBOARD_ICONS[0]);
    setSoundClipVolume(Number.isFinite(sound.volume) ? sound.volume : 100);
    setSoundboardHint(`Editing "${sound.name || 'Sound'}". Update name/icon/volume and click Save.`);
    setSoundFileLabel('Select audio');
    soundUploadFileRef.current = null;
  }, []);

  const updateSound = useCallback(async () => {
    if (!adminToken || !soundboardEditingId) return;

    const name = (soundNameInput.trim() || 'Sound').slice(0, 60);
    const icon = soundboardSelectedIcon || SOUNDBOARD_ICONS[0];
    const volume = Math.max(0, Math.min(200, Math.round(soundClipVolume)));

    try {
      const response = await fetch(apiUrl('/api/soundboard/update'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          roomId: activeRoom,
          soundId: soundboardEditingId,
          name,
          icon,
          volume,
        }),
      });

      if (!response.ok) {
        setSoundboardHint(`Save failed (${response.status})`);
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as { sound?: { id: string; name: string; icon?: string; volume?: number } };
      if (payload.sound?.id) {
        setSoundboardSounds((prev) =>
          prev.map((sound) =>
            sound.id === payload.sound!.id
              ? {
                  ...sound,
                  name: payload.sound!.name,
                  icon: payload.sound!.icon || sound.icon,
                  volume: payload.sound!.volume ?? sound.volume,
                }
              : sound,
          ),
        );
      } else {
        await loadSoundboard();
      }

      await publishData({
        type: 'sound-updated',
        room: activeRoom,
        soundId: soundboardEditingId,
      });

      setSoundboardHint('Saved!');
      exitSoundboardEditMode();
    } catch (error) {
      setSoundboardHint(`Save failed: ${(error as Error).message}`);
    }
  }, [
    adminToken,
    soundboardEditingId,
    soundNameInput,
    soundboardSelectedIcon,
    soundClipVolume,
    apiUrl,
    activeRoom,
    loadSoundboard,
    publishData,
    exitSoundboardEditMode,
  ]);

  const uploadSound = useCallback(async () => {
    if (!adminToken) return;

    if (soundboardEditingId) {
      await updateSound();
      return;
    }

    if (!soundUploadFileRef.current) {
      setSoundboardHint('Choose a sound file first.');
      return;
    }

    const qs = new URLSearchParams();
    qs.set('roomId', activeRoom);
    if (soundNameInput.trim()) qs.set('name', soundNameInput.trim());
    qs.set('icon', soundboardSelectedIcon || SOUNDBOARD_ICONS[0]);
    qs.set('volume', String(Math.max(0, Math.min(200, Math.round(soundClipVolume)))));

    try {
      const response = await fetch(apiUrl(`/api/soundboard/upload?${qs.toString()}`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': soundUploadFileRef.current.type || 'application/octet-stream',
        },
        body: await soundUploadFileRef.current.arrayBuffer(),
      });

      if (!response.ok) {
        setSoundboardHint(`Upload failed (${response.status})`);
        return;
      }

      setSoundboardHint('Sound uploaded.');
      soundUploadFileRef.current = null;
      setSoundFileLabel('Select audio');
      setSoundNameInput('');
      setSoundboardSelectedIcon(SOUNDBOARD_ICONS[0]);
      await loadSoundboard();
    } catch (error) {
      setSoundboardHint(`Upload failed: ${(error as Error).message}`);
    }
  }, [
    adminToken,
    soundboardEditingId,
    updateSound,
    activeRoom,
    soundNameInput,
    soundboardSelectedIcon,
    soundClipVolume,
    apiUrl,
    loadSoundboard,
  ]);

  useEffect(() => {
    if (soundboardCompactOpen || soundboardEditOpen) {
      void loadSoundboard();
    }
  }, [soundboardCompactOpen, soundboardEditOpen, soundboardReloadTick, loadSoundboard]);

  useEffect(() => {
    if (!settingsOpen) return;
    if (!connected || !localChimeIdentity) return;
    void checkLocalChimeState('enter');
    void checkLocalChimeState('exit');
  }, [settingsOpen, connected, localChimeIdentity, checkLocalChimeState]);

  useEffect(() => {
    if (!connected) return;
    if (!localChimeIdentity) return;
    void loadLocalAvatar();
  }, [connected, localChimeIdentity, loadLocalAvatar]);

  useEffect(() => {
    if (!connected) return;
    void broadcastDeviceId();
    prefetchRoomChimeBuffers();
  }, [connected, localIdentityBase]);

  const jamApplyVolume = useCallback(() => {
    const gain = jamGainRef.current;
    if (!gain) return;
    gain.gain.value = roomAudioMuted ? 0 : Math.max(0, Math.min(100, jamVolume)) / 100;
  }, [roomAudioMuted, jamVolume]);

  const stopJamAudioStream = useCallback(() => {
    jamStoppingRef.current = true;

    if (jamAudioWsRef.current) {
      try {
        jamAudioWsRef.current.close();
      } catch {
        // ignore
      }
      jamAudioWsRef.current = null;
    }

    if (jamAudioCtxRef.current) {
      void jamAudioCtxRef.current.close().catch(() => undefined);
      jamAudioCtxRef.current = null;
      jamGainRef.current = null;
    }

    jamNextPlayRef.current = 0;
  }, []);

  const startJamAudioStream = useCallback(() => {
    if (!adminToken || !connected) return;
    if (jamAudioWsRef.current) return;

    jamStoppingRef.current = false;

    const url = new URL(apiUrl('/api/jam/audio'));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', adminToken);

    const audioCtx = new AudioContext();
    const gain = audioCtx.createGain();
    gain.connect(audioCtx.destination);
    jamAudioCtxRef.current = audioCtx;
    jamGainRef.current = gain;
    jamNextPlayRef.current = audioCtx.currentTime;

    const ws = new WebSocket(url.toString());
    ws.binaryType = 'arraybuffer';
    jamAudioWsRef.current = ws;

    ws.onopen = () => {
      jamRetriesRef.current = 0;
      setJamStatus('Jam audio stream connected.');
      jamApplyVolume();
    };

    ws.onmessage = (event) => {
      const context = jamAudioCtxRef.current;
      const gainNode = jamGainRef.current;
      if (!context || !gainNode) return;

      if (!(event.data instanceof ArrayBuffer)) return;

      void context.decodeAudioData(event.data.slice(0)).then((buffer) => {
        if (!jamAudioCtxRef.current || !jamGainRef.current) return;

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gainNode);

        const now = context.currentTime;
        const startAt = Math.max(now + 0.05, jamNextPlayRef.current || now + 0.05);
        source.start(startAt);
        jamNextPlayRef.current = startAt + buffer.duration;
      }).catch(() => undefined);
    };

    ws.onclose = () => {
      jamAudioWsRef.current = null;
      if (jamStoppingRef.current) return;

      if (jamRetriesRef.current >= 3) {
        setJamError('Jam audio stream disconnected.');
        return;
      }

      jamRetriesRef.current += 1;
      const delay = 1000 * jamRetriesRef.current;
      setTimeout(() => {
        if (!jamStoppingRef.current) startJamAudioStream();
      }, delay);
    };

    ws.onerror = () => {
      setJamError('Jam audio stream error.');
    };
  }, [adminToken, apiUrl, connected, jamApplyVolume]);

  useEffect(() => {
    jamApplyVolume();
  }, [jamApplyVolume]);

  const fetchJamState = useCallback(async () => {
    if (!adminToken) return;

    try {
      const response = await fetch(apiUrl('/api/jam/state'), {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (!response.ok) return;

      const payload = (await response.json()) as JamState;
      setJamState(payload);

      if (payload.active && payload.listeners.some((listener) => identityBase(listener) === localIdentityBase)) {
        startJamAudioStream();
      } else {
        stopJamAudioStream();
      }
    } catch (error) {
      setJamError(`Jam state failed: ${(error as Error).message}`);
    }
  }, [adminToken, apiUrl, localIdentityBase, startJamAudioStream, stopJamAudioStream]);

  useEffect(() => {
    if (!jamOpen || !adminToken) return;

    void fetchJamState();
    const timer = window.setInterval(() => {
      void fetchJamState();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [jamOpen, adminToken, fetchJamState]);

  useEffect(() => {
    if (!jamOpen || !adminToken) return;

    if (jamSearch.trim().length < 2) {
      setJamSearchResults([]);
      return;
    }

    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch(apiUrl('/api/jam/search'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: jamSearch.trim() }),
        });

        if (!response.ok) return;
        const payload = (await response.json()) as JamTrack[];
        setJamSearchResults(payload);
      } catch {
        // ignore search errors
      }
    }, 300);

    return () => window.clearTimeout(handle);
  }, [jamSearch, jamOpen, adminToken, apiUrl]);

  const generateRandomString = (length: number) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => chars[value % chars.length]).join('');
  };

  const generateCodeChallenge = async (verifier: string) => {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const connectSpotify = useCallback(async () => {
    if (!adminToken) return;

    try {
      setJamError('');
      setJamStatus('Connecting to Spotify…');

      const state = generateRandomString(32);
      const verifier = generateRandomString(128);
      const challenge = await generateCodeChallenge(verifier);

      spotifyAuthStateRef.current = state;
      spotifyVerifierRef.current = verifier;

      const initResponse = await fetch(apiUrl('/api/jam/spotify-init'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state, verifier, challenge }),
      });

      if (!initResponse.ok) {
        setJamError(`Spotify init failed (${initResponse.status})`);
        return;
      }

      const initData = (await initResponse.json()) as { auth_url?: string };
      if (!initData.auth_url) {
        setJamError('Spotify auth URL missing');
        return;
      }

      window.open(initData.auth_url, '_blank', 'noopener');

      let tries = 0;
      const poll = window.setInterval(async () => {
        tries += 1;
        if (tries > 90) {
          window.clearInterval(poll);
          setJamError('Spotify login timed out');
          return;
        }

        const authState = spotifyAuthStateRef.current;
        const authVerifier = spotifyVerifierRef.current;
        if (!authState || !authVerifier) return;

        try {
          const codeResponse = await fetch(
            `${apiUrl('/api/jam/spotify-code')}?state=${encodeURIComponent(authState)}`,
            {
              headers: {
                Authorization: `Bearer ${adminToken}`,
              },
            },
          );

          if (!codeResponse.ok) return;

          const codePayload = (await codeResponse.json()) as { code?: string };
          if (!codePayload.code) return;

          window.clearInterval(poll);

          const tokenResponse = await fetch(apiUrl('/api/jam/spotify-token'), {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ code: codePayload.code, verifier: authVerifier }),
          });

          if (!tokenResponse.ok) {
            setJamError(`Spotify token exchange failed (${tokenResponse.status})`);
            return;
          }

          setJamStatus('Spotify connected.');
          void fetchJamState();
        } catch {
          // ignore polling errors
        }
      }, 2000);
    } catch (error) {
      setJamError(`Spotify connect error: ${(error as Error).message}`);
    }
  }, [adminToken, apiUrl, fetchJamState]);

  const jamAction = useCallback(
    async (
      endpoint: string,
      options?: {
        method?: 'POST' | 'GET';
        body?: unknown;
        onSuccess?: () => void;
      },
    ) => {
      if (!adminToken) return;

      try {
        const response = await fetch(apiUrl(endpoint), {
          method: options?.method ?? 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });

        if (!response.ok) {
          setJamError(`${endpoint} failed (${response.status})`);
          return;
        }

        options?.onSuccess?.();
        setJamError('');
        await fetchJamState();
      } catch (error) {
        setJamError(`${endpoint} failed: ${(error as Error).message}`);
      }
    },
    [adminToken, apiUrl, fetchJamState],
  );

  const addJamTrack = useCallback(
    async (track: JamTrack) => {
      await jamAction('/api/jam/queue', {
        body: {
          ...track,
          added_by: localIdentity || name || 'viewer',
        },
      });
    },
    [jamAction, localIdentity, name],
  );

  const removeJamTrack = useCallback(
    async (index: number) => {
      await jamAction('/api/jam/queue-remove', {
        body: {
          index,
          identity: localIdentity,
        },
      });
    },
    [jamAction, localIdentity],
  );

  const uploadBugScreenshot = useCallback(async () => {
    if (!bugScreenshotFile || !adminToken) return null;

    try {
      const formData = new FormData();
      formData.append('file', bugScreenshotFile);

      const response = await fetch(apiUrl('/api/chat/upload'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        body: formData,
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as { ok?: boolean; url?: string };
      if (!payload.ok || !payload.url) return null;

      setBugScreenshotUrl(payload.url);
      return payload.url;
    } catch {
      return null;
    }
  }, [bugScreenshotFile, adminToken, apiUrl]);

  const submitBugReport = useCallback(async () => {
    if (!adminToken) {
      setBugStatus('Not connected.');
      return;
    }

    if (!bugDescription.trim()) {
      setBugStatus('Please describe the issue.');
      return;
    }

    setBugStatus('Sending...');

    const screenshotUrl = bugScreenshotUrl || (await uploadBugScreenshot());

    try {
      const response = await fetch(apiUrl('/api/bug-report'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: bugDescription.trim(),
          identity: localIdentity,
          name: name || localIdentity || 'Viewer',
          room: activeRoom,
          screenshot_url: screenshotUrl || undefined,
        }),
      });

      if (!response.ok) {
        setBugStatus(`Failed (${response.status})`);
        return;
      }

      setBugStatus('Report sent! Thank you.');
      setBugDescription('');
      setBugScreenshotFile(null);
      setBugScreenshotUrl(null);
    } catch (error) {
      setBugStatus(`Error: ${(error as Error).message}`);
    }
  }, [
    adminToken,
    bugDescription,
    bugScreenshotUrl,
    uploadBugScreenshot,
    apiUrl,
    localIdentity,
    name,
    activeRoom,
  ]);

  const fetchAdminDashboard = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch(apiUrl('/admin/api/dashboard'), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as AdminDashboardResponse;
      setAdminDashboard(payload);
    } catch {
      // silent admin polling failure
    }
  }, [adminToken, apiUrl]);

  const adminKick = useCallback(
    async (roomId: string, participantIdentity: string) => {
      if (!adminToken) return;
      try {
        await fetch(
          apiUrl(`/v1/rooms/${encodeURIComponent(roomId)}/kick/${encodeURIComponent(participantIdentity)}`),
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
            },
          },
        );
        await fetchAdminDashboard();
      } catch {
        // silent admin action failure
      }
    },
    [adminToken, apiUrl, fetchAdminDashboard],
  );

  const adminMute = useCallback(
    async (roomId: string, participantIdentity: string) => {
      if (!adminToken) return;
      try {
        await fetch(
          apiUrl(`/v1/rooms/${encodeURIComponent(roomId)}/mute/${encodeURIComponent(participantIdentity)}`),
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${adminToken}`,
            },
          },
        );
        await fetchAdminDashboard();
      } catch {
        // silent admin action failure
      }
    },
    [adminToken, apiUrl, fetchAdminDashboard],
  );

  const fetchAdminHistory = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch(apiUrl('/admin/api/sessions'), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as AdminSessionsResponse;
      setAdminSessions(payload);
    } catch {
      // silent admin polling failure
    }
  }, [adminToken, apiUrl]);

  const fetchAdminMetrics = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch(apiUrl('/admin/api/metrics'), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as AdminMetricsResponse;
      setAdminMetrics(payload);
    } catch {
      // silent admin polling failure
    }
  }, [adminToken, apiUrl]);

  const fetchAdminDashboardMetrics = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch(apiUrl('/admin/api/metrics/dashboard'), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as AdminDashboardMetricsResponse;
      setAdminDashboardMetrics(payload);
    } catch {
      // silent admin polling failure
    }
  }, [adminToken, apiUrl]);

  const fetchAdminBugs = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch(apiUrl('/admin/api/bugs'), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as AdminBugsResponse;
      setAdminBugs(payload);
    } catch {
      // silent admin polling failure
    }
  }, [adminToken, apiUrl]);

  const fetchAdminDeploys = useCallback(async () => {
    if (!adminToken) return;
    try {
      const response = await fetch(apiUrl('/admin/api/deploys'), {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as AdminDeploysResponse;
      setAdminDeploys(payload);
    } catch {
      // silent admin polling failure
    }
  }, [adminToken, apiUrl]);

  const refreshAdminDash = useCallback(async () => {
    await Promise.all([
      fetchAdminDashboard(),
      fetchAdminHistory(),
      fetchAdminMetrics(),
      fetchAdminDashboardMetrics(),
      fetchAdminBugs(),
    ]);
  }, [fetchAdminDashboard, fetchAdminHistory, fetchAdminMetrics, fetchAdminDashboardMetrics, fetchAdminBugs]);

  useEffect(() => {
    if (!isAdminMode || !adminDashOpen || !adminToken) {
      if (adminDashTimerRef.current) {
        window.clearInterval(adminDashTimerRef.current);
        adminDashTimerRef.current = null;
      }
      return;
    }

    void refreshAdminDash();

    if (adminDashTimerRef.current) {
      window.clearInterval(adminDashTimerRef.current);
    }

    adminDashTimerRef.current = window.setInterval(() => {
      void fetchAdminDashboard();
      void fetchAdminMetrics();
    }, 3_000);

    return () => {
      if (adminDashTimerRef.current) {
        window.clearInterval(adminDashTimerRef.current);
        adminDashTimerRef.current = null;
      }
    };
  }, [
    isAdminMode,
    adminDashOpen,
    adminToken,
    refreshAdminDash,
    fetchAdminDashboard,
    fetchAdminMetrics,
  ]);

  useEffect(() => {
    if (!isAdminMode || !adminDashOpen || !adminToken) return;
    if (adminDashTab !== 'deploys') return;
    void fetchAdminDeploys();
  }, [isAdminMode, adminDashOpen, adminDashTab, adminToken, fetchAdminDeploys]);

  useEffect(() => {
    if (isAdminMode) {
      document.body.classList.add('admin-mode');
    } else {
      document.body.classList.remove('admin-mode');
    }
    return () => {
      document.body.classList.remove('admin-mode');
    };
  }, [isAdminMode]);

  useEffect(() => {
    setStoredValue('admin-panel-width', String(Math.round(adminPanelWidth)));
  }, [adminPanelWidth]);

  const copyDebugLog = useCallback(async () => {
    const text = debugLog.map((line) => line.text).join('\n');
    await navigator.clipboard.writeText(text);
  }, [debugLog]);

  const canUseRoomControls = connected && Boolean(adminToken);

  const adminRooms = adminDashboard?.rooms ?? [];
  const adminEvents = adminSessions?.events ?? [];
  const adminQualityUsers = adminMetrics?.users ?? [];
  const adminMetricsSummary = adminDashboardMetrics?.summary;
  const adminPerUserMetrics = adminDashboardMetrics?.per_user ?? [];
  const adminBugReports = adminBugs?.reports ?? [];
  const adminDeployCommits = adminDeploys?.commits ?? [];

  const bugsByUser = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const report of adminBugReports) {
      const nameKey = report.name || report.reporter || report.identity || 'Unknown';
      grouped.set(nameKey, (grouped.get(nameKey) ?? 0) + 1);
    }
    return Array.from(grouped.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [adminBugReports]);

  const bugsByDay = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const report of adminBugReports) {
      const key = new Date(report.timestamp * 1000).toISOString().slice(0, 10);
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    return Array.from(grouped.entries())
      .map(([dayKey, count]) => ({ dayKey, count }))
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  }, [adminBugReports]);

  const toggleAdminDash = () => {
    setAdminDashOpen((prev) => !prev);
  };

  const startAdminResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const maxWidth = window.innerWidth * 0.8;
      const minWidth = 400;
      const next = Math.max(minWidth, Math.min(maxWidth, window.innerWidth - moveEvent.clientX));
      setAdminPanelWidth(next);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <main className="app">
      {updateBannerVersion && !updateDismissed ? (
        <div
          id="update-banner"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 500,
            background: 'linear-gradient(90deg, rgba(56,189,248,0.15), rgba(139,92,246,0.15))',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderBottom: '1px solid rgba(56,189,248,0.3)',
            padding: '8px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            fontSize: '13px',
            color: 'var(--text, #e2e8f0)',
          }}
        >
          <span>
            Update available: <strong>v{updateBannerVersion}</strong> — restart the app to update
          </span>
          <button
            type="button"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted, #94a3b8)',
              cursor: 'pointer',
              fontSize: '16px',
              padding: '2px 6px',
            }}
            title="Dismiss"
            onClick={() => setUpdateDismissed(true)}
          >
            ×
          </button>
        </div>
      ) : null}

      <header>
        <div className="header-brand">
          <img src="/badge.jpg" alt="Fellowship Badge" className="header-badge" />
          <div>
            <h1>Echo Chamber</h1>
            <p>The Fellowship of the Boatrace</p>
          </div>
        </div>
      </header>

      <section id="connect-panel" className="panel">
        <div className="grid">
          <label>
            Control URL
            <input
              id="control-url"
              type="text"
              value={controlUrl}
              placeholder="https://127.0.0.1:9443"
              onChange={(event) => setField('controlUrl', event.target.value)}
            />
          </label>
          <label>
            SFU URL
            <input
              id="sfu-url"
              type="text"
              value={sfuUrl}
              placeholder="ws://127.0.0.1:7880"
              onChange={(event) => setField('sfuUrl', event.target.value)}
            />
          </label>
          <input id="room" type="hidden" value={activeRoom} readOnly />
          <input id="identity" type="hidden" value={identity} readOnly />
          <label>
            Name
            <input
              id="name"
              type="text"
              value={name}
              onChange={(event) => setField('name', event.target.value)}
            />
          </label>
          <label>
            Admin password
            <input
              id="admin-password"
              type="password"
              value={adminPassword}
              placeholder="Enter admin password"
              onChange={(event) => setField('adminPassword', event.target.value)}
            />
          </label>
        </div>

        <div className="actions">
          <button id="connect" onClick={onConnect} disabled={provisioning}>
            {connected ? 'Reconnect' : 'Connect'}
          </button>
          <button id="disconnect" onClick={onDisconnect} disabled={!connected && !provisioning}>
            Disconnect
          </button>
        </div>

        <div className="actions publish-actions">
          <button id="toggle-mic" disabled={!canUseRoomControls} className={micEnabled ? 'is-on' : ''} onClick={() => void toggleMic()}>
            {micEnabled ? 'Disable Mic' : 'Enable Mic'}
          </button>
          <button id="toggle-cam" disabled={!canUseRoomControls} className={camEnabled ? 'is-on' : ''} onClick={() => void toggleCamera()}>
            {camEnabled ? 'Disable Camera' : 'Enable Camera'}
          </button>
          <button
            id="toggle-screen"
            disabled={!canUseRoomControls}
            className={screenEnabled ? 'is-on' : ''}
            onClick={() => void toggleScreenShare()}
          >
            {screenEnabled ? 'Stop Screen' : 'Share Screen'}
          </button>
        </div>

        <div className="actions device-actions">
          <label className="device-field">
            Mic
            <select
              id="mic-select"
              disabled={!connected}
              value={selectedMicId}
              onChange={(event) => void switchMicDevice(event.target.value)}
            >
              <option value="">Default</option>
              {micDevices.map((device) => (
                <option key={device.deviceId || device.label} value={device.deviceId}>
                  {device.label || 'Microphone'}
                </option>
              ))}
            </select>
          </label>
          <label className="device-field">
            Camera
            <select
              id="cam-select"
              disabled={!connected}
              value={selectedCamId}
              onChange={(event) => void switchCamDevice(event.target.value)}
            >
              <option value="">Default</option>
              {camDevices.map((device) => (
                <option key={device.deviceId || device.label} value={device.deviceId}>
                  {device.label || 'Camera'}
                </option>
              ))}
            </select>
          </label>
          <label className="device-field">
            Output
            <select
              id="speaker-select"
              disabled={!connected}
              value={selectedSpeakerId}
              onChange={(event) => setSelectedSpeakerId(event.target.value)}
            >
              <option value="">Default</option>
              {speakerDevices.map((device) => (
                <option key={device.deviceId || device.label} value={device.deviceId}>
                  {device.label || 'Speaker'}
                </option>
              ))}
            </select>
          </label>
          <button id="refresh-devices" disabled={!connected && !provisioning} onClick={() => void refreshDevices()}>
            Refresh Devices
          </button>
        </div>

        <div id="device-status" className="status device-status">
          {deviceStatus}
        </div>
        <div id="status" className={`status${snapshot.matches('failed') ? ' error' : ''}`}>
          {statusText}
        </div>

        <div id="online-users" className="online-users">
          {onlineUsersQuery.isLoading ? <div className="online-users-empty">Checking who is online…</div> : null}
          {onlineUsersQuery.data && onlineUsersQuery.data.length > 0 ? (
            <>
              <div className="online-users-header">Currently Online ({onlineUsersQuery.data.length})</div>
              <div className="online-users-list">
                {onlineUsersQuery.data.map((user, index) => (
                  <span
                    key={`${user.identity ?? user.name ?? 'online'}-${index}`}
                    className="online-user-pill"
                    title={user.room ? `In room: ${user.room}` : ''}
                  >
                    {user.name ?? user.identity ?? 'Unknown'}
                  </span>
                ))}
              </div>
            </>
          ) : null}
          {onlineUsersQuery.data && onlineUsersQuery.data.length === 0 ? (
            <div className="online-users-empty">No one is currently online</div>
          ) : null}
          {onlineUsersQuery.isError ? <div className="online-users-empty">Online user polling unavailable.</div> : null}
        </div>
      </section>

      <section className="panel room-panel">
        <div className="room-top">
          <div>
            <div className="room-title">Rooms</div>
            <div id="room-list" className="room-list">
              {FIXED_ROOMS.map((roomId) => {
                const participants = roomStatusMap.get(roomId) ?? [];
                return (
                  <button
                    key={roomId}
                    type="button"
                    className={`room-status-btn${roomId === activeRoom ? ' is-active' : ''}${participants.length > 0 ? ' has-users' : ''}`}
                    onClick={() => onSwitchRoom(roomId)}
                  >
                    <span className="room-status-name">{ROOM_DISPLAY_NAMES[roomId]}</span>
                    <span className="room-status-count">{participants.length > 0 ? participants.length : ''}</span>
                    {participants.length > 0 ? (
                      <div className="room-status-tooltip">
                        {participants.map((participant) => (
                          <div key={participant.identity} className="room-status-tooltip-name">
                            {participant.name ?? participant.identity}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div id="jam-banner" className={`jam-banner${jamState?.active ? '' : ' hidden'}`}>
            {jamState?.now_playing?.album_art_url ? (
              <img className="jam-banner-art" src={jamState.now_playing.album_art_url} alt="Now playing" />
            ) : (
              <img className="jam-banner-art" src="/badge.jpg" alt="Now playing" />
            )}
            <div className="jam-banner-info">
              <div className="jam-banner-title">
                {jamState?.now_playing?.name || 'Jam active'}
              </div>
              <div className="jam-banner-artist">
                {jamState?.now_playing?.artist || `${jamState?.listener_count || 0} listening`}
              </div>
            </div>
            <span className="jam-banner-live">JAM</span>
          </div>

          <div className="room-actions">
            <button
              id="open-admin-dash"
              type="button"
              className={`admin-only${isAdminMode ? '' : ' hidden'}`}
              onClick={toggleAdminDash}
            >
              Admin
            </button>
            <button id="open-settings" type="button" disabled={!connected} onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
            <button id="open-bug-report" type="button" className="bug-report-btn" disabled={!connected} onClick={() => setBugReportOpen(true)}>
              Report Bug
            </button>
            <button id="disconnect-top" type="button" disabled={!connected} onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        </div>

        <div className={`room-layout${chatOpen ? ' chat-open' : ''}`}>
          <div className="room-main">
            <div className="grid-header">
              <h2>Screens</h2>
            </div>
            <div id="screen-grid" className="media-grid screens-grid">
              {screenParticipants.length > 0 ? (
                screenParticipants.map((participant) => (
                  <article key={`${participant.identity}-screen`} className="tile">
                    <h3>{participant.name}</h3>
                    <TrackRenderer
                      track={participant.screenTrack}
                      className="h-full w-full rounded-lg bg-black object-contain"
                      muted={participant.isLocal || roomAudioMuted}
                      onMounted={(element) => {
                        if (!participant.isLocal) registerRemoteMediaElement(element, true);
                      }}
                      onUnmounted={(element) => {
                        if (!participant.isLocal) registerRemoteMediaElement(element, false);
                      }}
                    />
                  </article>
                ))
              ) : (
                <article className="tile">
                  <h3>Room preview</h3>
                  <div className="hint">No shared screens yet.</div>
                </article>
              )}
            </div>
          </div>

          <aside className="room-sidebar">
            <div className="sidebar-header">
              <div className="sidebar-title-row">
                <h2>Active Users</h2>
                <div className="sidebar-actions">
                  <button id="refresh-videos" type="button" className="hidden" style={{ background: '#10b981', color: 'white' }}>
                    Enable Videos
                  </button>
                  <button id="debug-toggle" type="button" onClick={() => setDebugOpen(true)}>
                    Debug
                  </button>
                  <button
                    id="open-chat"
                    type="button"
                    disabled={!connected}
                    onClick={() => setChatOpen(true)}
                    className={unreadChatCount > 0 ? 'has-unread' : ''}
                  >
                    Chat
                    <span id="chat-badge" className={`chat-badge${unreadChatCount > 0 ? '' : ' hidden'}`}>
                      {unreadChatCount > 99 ? '99+' : unreadChatCount}
                    </span>
                  </button>
                  <button id="toggle-room-audio" type="button" disabled={!connected} onClick={() => setRoomAudioMuted((prev) => !prev)}>
                    {roomAudioMuted ? 'Unmute All' : 'Mute All'}
                  </button>
                </div>
                <div className="sidebar-actions">
                  <button
                    id="open-soundboard"
                    type="button"
                    disabled={!connected}
                    onClick={() => {
                      void ensureSoundboardAudioContext().catch(() => undefined);
                      setSoundboardCompactOpen(true);
                      setSoundboardEditOpen(false);
                    }}
                  >
                    Soundboard
                  </button>
                  <button id="open-camera-lobby" type="button" disabled={!connected} onClick={() => setCameraLobbyOpen(true)}>
                    Camera Lobby
                  </button>
                  <button id="open-theme" type="button" onClick={() => setThemeOpen(true)}>
                    Theme
                  </button>
                  <button id="open-jam" type="button" disabled={!connected} onClick={() => setJamOpen(true)}>
                    Jam
                  </button>
                </div>
              </div>
            </div>

            <div id="user-list" className="user-list">
              {participantViews.length === 0 ? <div className="hint">No active users in this room yet.</div> : null}
              {participantViews.map((participant) => (
                <article key={participant.identity} className={`user-card${participant.cameraTrack ? ' has-camera' : ''}`}>
                  <div className="user-header">
                    <div
                      className={`user-avatar${participant.isLocal ? ' user-avatar-local' : ''}`}
                      title={participant.isLocal ? 'Click to upload avatar' : undefined}
                      style={participant.isLocal ? { cursor: participant.cameraTrack ? 'default' : 'pointer' } : undefined}
                      onClick={() => {
                        if (!participant.isLocal) return;
                        if (participant.cameraTrack) return;
                        localAvatarInputRef.current?.click();
                      }}
                    >
                      {participant.cameraTrack ? (
                        <TrackRenderer
                          track={participant.cameraTrack}
                          className="h-full w-full object-cover"
                          muted={participant.isLocal}
                          onMounted={(element) => {
                            if (!participant.isLocal) {
                              registerRemoteMediaElement(element, true);
                              attachCameraRecovery(
                                participant.identity,
                                participant.cameraPublication,
                                participant.cameraTrack,
                                element,
                              );
                            }
                          }}
                          onUnmounted={(element) => {
                            if (!participant.isLocal) {
                              registerRemoteMediaElement(element, false);
                              detachCameraRecovery(participant.identity);
                            }
                          }}
                        />
                      ) : resolveAvatarUrl(participant.identity) ? (
                        <img className="avatar-img" src={resolveAvatarUrl(participant.identity)} alt={participant.name} />
                      ) : (
                        getInitials(participant.name)
                      )}
                      {participant.isLocal ? (
                        <input
                          ref={localAvatarInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              void uploadAvatar(file);
                            }
                            event.currentTarget.value = '';
                          }}
                        />
                      ) : null}
                    </div>
                    <div className="user-meta">
                      <h3 className="user-name">{participant.name}</h3>
                      <div className="user-status">
                        <span className={`pill${participant.micTrack ? ' is-on' : ''}`}>
                          {participant.micTrack ? 'Mic On' : 'Mic Off'}
                        </span>
                        <span className={`pill${participant.screenTrack ? ' is-active' : ''}`}>
                          {participant.screenTrack ? 'Sharing' : 'No Screen'}
                        </span>
                        {participant.speaking ? <span className="pill is-active">Speaking</span> : null}
                      </div>
                    </div>
                  </div>
                  <div className="user-controls">
                    {!participant.isLocal ? (
                      <>
                        <button className="mute-button" type="button" onClick={() => setRoomAudioMuted((prev) => !prev)}>
                          {roomAudioMuted ? 'Unmute' : 'Mute'}
                        </button>
                        <label className="device-field user-volume-field">
                          Mic Volume ({Math.round(getParticipantVolume(participantVolumesRef.current, participant.identity, 'mic') * 100)}%)
                          <input
                            type="range"
                            min={0}
                            max={300}
                            step={10}
                            value={Math.round(getParticipantVolume(participantVolumesRef.current, participant.identity, 'mic') * 100)}
                            onChange={(event) =>
                              updateParticipantVolume(
                                participant.identity,
                                'mic',
                                Number(event.target.value) / 100,
                              )
                            }
                          />
                        </label>
                        <label className="device-field user-volume-field">
                          Screen Audio ({Math.round(getParticipantVolume(participantVolumesRef.current, participant.identity, 'screen') * 100)}%)
                          <input
                            type="range"
                            min={0}
                            max={300}
                            step={10}
                            value={Math.round(getParticipantVolume(participantVolumesRef.current, participant.identity, 'screen') * 100)}
                            onChange={(event) =>
                              updateParticipantVolume(
                                participant.identity,
                                'screen',
                                Number(event.target.value) / 100,
                              )
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </aside>

          <div id="chat-panel" className={`chat-panel${chatOpen ? '' : ' hidden'}`} role="dialog" aria-label="Chat">
            <div className="chat-header">
              <h3>Chat</h3>
              <div className="chat-actions">
                <button id="close-chat" type="button" onClick={() => setChatOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            <div id="chat-messages" className="chat-messages">
              {chatMessages.map((message) => (
                <article key={message.id} className="chat-message" data-msg-id={message.id}>
                  <div className="chat-message-header">
                    <span className={`chat-message-author${message.identity === localIdentity ? ' self' : ''}`}>{message.name || message.identity}</span>
                    <span className="chat-message-time">{formatChatTime(message.timestamp)}</span>
                  </div>
                  {message.identity === localIdentity && message.id ? (
                    <button
                      type="button"
                      className="chat-message-delete"
                      title="Delete message"
                      onClick={() => void deleteChatMessage(message)}
                    >
                      ×
                    </button>
                  ) : null}
                  {message.fileUrl ? (
                    <>
                      {message.fileType?.startsWith('image/') ? (
                        <img className="chat-message-image" src={resolveFileUrl(message.fileUrl)} alt={message.fileName || 'Chat upload'} />
                      ) : null}
                      {message.fileType?.startsWith('audio/') ? (
                        <audio className="chat-message-audio" controls src={resolveFileUrl(message.fileUrl)} />
                      ) : null}
                      {message.fileType?.startsWith('video/') ? (
                        <video className="chat-message-image" controls src={resolveFileUrl(message.fileUrl)} />
                      ) : null}
                      {!message.fileType?.startsWith('image/') && !message.fileType?.startsWith('audio/') && !message.fileType?.startsWith('video/') ? (
                        <a className="chat-message-file" href={resolveFileUrl(message.fileUrl)} target="_blank" rel="noreferrer">
                          <div className="chat-message-file-icon">📄</div>
                          <div className="chat-message-file-name">{message.fileName || 'File'}</div>
                        </a>
                      ) : null}
                    </>
                  ) : null}
                  {message.text ? <div className="chat-message-content">{message.text}</div> : null}
                </article>
              ))}
              {chatMessages.length === 0 ? <div className="hint">No messages yet.</div> : null}
            </div>
            <form className="chat-input-container" onSubmit={sendChatMessage}>
              <label htmlFor="chat-file-input" id="chat-upload-btn" className="chat-upload-btn" title="Upload file or image">
                📎
              </label>
              <button
                id="chat-emoji-btn"
                type="button"
                className="chat-emoji-btn"
                title="Add emoji"
                onClick={() => setEmojiPickerOpen((prev) => !prev)}
              >
                😊
              </button>
              <input
                type="file"
                id="chat-file-input"
                className="hidden"
                accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt"
                onChange={(event) => void onChatUploadChange(event)}
              />
              <div id="chat-emoji-picker" className={`chat-emoji-picker${emojiPickerOpen ? '' : ' hidden'}`}>
                {EMOJI_LIST.map((emoji) => (
                  <button key={emoji} type="button" className="chat-emoji" onClick={() => addEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
              <textarea
                id="chat-input"
                className="chat-input"
                placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                rows={2}
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={onChatKeyDown}
              />
              <button id="chat-send-btn" type="submit" className="chat-send-btn" disabled={!connected}>
                Send
              </button>
            </form>
          </div>
        </div>

        <div id="audio-bucket" className="audio-bucket" aria-hidden>
          {participantViews
            .filter((participant) => !participant.isLocal)
            .map((participant) => (
              <div key={`audio-${participant.identity}`}>
                {participant.micTrack ? (
                  <TrackRenderer
                    track={participant.micTrack}
                    className="hidden"
                    muted={false}
                    onMounted={(element) => registerRemoteMediaElement(element, true, { identity: participant.identity, kind: 'mic' })}
                    onUnmounted={(element) => registerRemoteMediaElement(element, false, { identity: participant.identity, kind: 'mic' })}
                  />
                ) : null}
                {participant.screenAudioTrack ? (
                  <TrackRenderer
                    track={participant.screenAudioTrack}
                    className="hidden"
                    muted={false}
                    onMounted={(element) => registerRemoteMediaElement(element, true, { identity: participant.identity, kind: 'screen' })}
                    onUnmounted={(element) => registerRemoteMediaElement(element, false, { identity: participant.identity, kind: 'screen' })}
                  />
                ) : null}
              </div>
            ))}
        </div>
      </section>

      <div id="settings-panel" className={`settings-panel${settingsOpen ? '' : ' hidden'}`} role="dialog" aria-label="Settings">
        <div className="settings-header">
          <h3>Settings</h3>
          <button id="close-settings" type="button" onClick={() => setSettingsOpen(false)}>
            Close
          </button>
        </div>
        <div id="settings-device-panel" className="settings-body">
          <div className="device-actions">
            <label className="device-field">
              Mic
              <select value={selectedMicId} onChange={(event) => void switchMicDevice(event.target.value)}>
                <option value="">Default</option>
                {micDevices.map((device) => (
                  <option key={`settings-mic-${device.deviceId}`} value={device.deviceId}>
                    {device.label || 'Microphone'}
                  </option>
                ))}
              </select>
            </label>
            <label className="device-field">
              Camera
              <select value={selectedCamId} onChange={(event) => void switchCamDevice(event.target.value)}>
                <option value="">Default</option>
                {camDevices.map((device) => (
                  <option key={`settings-cam-${device.deviceId}`} value={device.deviceId}>
                    {device.label || 'Camera'}
                  </option>
                ))}
              </select>
            </label>
            <label className="device-field">
              Output
              <select value={selectedSpeakerId} onChange={(event) => setSelectedSpeakerId(event.target.value)}>
                <option value="">Default</option>
                {speakerDevices.map((device) => (
                  <option key={`settings-speaker-${device.deviceId}`} value={device.deviceId}>
                    {device.label || 'Speaker'}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void refreshDevices()}>
              Refresh Devices
            </button>
          </div>

          <div className="device-actions">
            <label className="device-field">
              <span>RNNoise Mic Cancel</span>
              <input
                type="checkbox"
                checked={noiseCancelEnabled}
                onChange={(event) => setNoiseCancelEnabled(event.target.checked)}
              />
            </label>
            <label className="device-field">
              Suppression Level
              <select
                value={noiseCancelLevel}
                onChange={(event) => {
                  const level = Number(event.target.value);
                  setNoiseCancelLevel(level === 0 || level === 1 ? level : 2);
                }}
              >
                <option value={0}>Off</option>
                <option value={1}>Medium</option>
                <option value={2}>Strong</option>
              </select>
            </label>
          </div>

          <div id="chime-settings-section" className="chime-settings-section">
            <div className="chime-settings-title">Custom Sounds</div>
            {(['enter', 'exit'] as const).map((kind) => (
              <div key={kind} className="chime-upload-row">
                <label className="chime-label">{kind === 'enter' ? 'Enter Sound' : 'Exit Sound'}</label>
                <div className="chime-controls">
                  <input
                    type="file"
                    accept="audio/mpeg,audio/wav,audio/ogg,audio/webm,.mp3,.wav,.ogg,.webm"
                    className="hidden"
                    id={`chime-${kind}-file`}
                    onChange={(event) => {
                      chimeFileRef.current[kind] = event.target.files?.[0] ?? null;
                      if (chimeFileRef.current[kind]) {
                        setChimeStatus((prev) => ({ ...prev, [kind]: chimeFileRef.current[kind]?.name || '' }));
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="chime-btn"
                    onClick={() => {
                      const input = document.getElementById(`chime-${kind}-file`) as HTMLInputElement | null;
                      input?.click();
                    }}
                  >
                    Pick
                  </button>
                  <button type="button" className="chime-btn" onClick={() => void uploadChime(kind)}>
                    Upload
                  </button>
                  <button
                    type="button"
                    className={`chime-btn chime-preview${chimeExists[kind] ? '' : ' hidden'}`}
                    onClick={() => void previewChime(kind)}
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    className={`chime-btn chime-remove${chimeExists[kind] ? '' : ' hidden'}`}
                    onClick={() => void removeChime(kind)}
                  >
                    Remove
                  </button>
                  <span className="chime-status">{chimeStatus[kind]}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div id="soundboard-compact" className={`soundboard-compact${soundboardCompactOpen ? '' : ' hidden'}`} role="dialog" aria-label="Soundboard Quick Play">
        <div className="soundboard-compact-header">
          <h3>Soundboard</h3>
          <button
            id="close-soundboard"
            type="button"
            className="soundboard-compact-close"
            title="Close"
            onClick={() => {
              setSoundboardCompactOpen(false);
              setSoundboardEditOpen(false);
              exitSoundboardEditMode();
            }}
          >
            Back
          </button>
        </div>
        <button
          id="open-soundboard-edit"
          type="button"
          className="soundboard-compact-btn"
          onClick={() => {
            setSoundboardEditOpen(true);
            setSoundboardCompactOpen(false);
          }}
        >
          Edit Soundboard
        </button>
        <button
          id="toggle-soundboard-volume-compact"
          type="button"
          className="soundboard-compact-btn"
          aria-expanded={soundboardVolumeOpen}
          aria-controls="soundboard-volume-panel-compact"
          onClick={() => setSoundboardVolumeOpen((prev) => !prev)}
        >
          Soundboard Volume
        </button>
        <div
          id="soundboard-volume-panel-compact"
          className={`soundboard-volume-compact${soundboardVolumeOpen ? '' : ' hidden'}`}
          aria-hidden={!soundboardVolumeOpen}
        >
          <div className="soundboard-volume-row">
            <input
              id="soundboard-volume"
              type="range"
              min="0"
              max="100"
              value={soundboardVolume}
              onChange={(event) => setSoundboardVolume(Number(event.target.value))}
            />
            <span id="soundboard-volume-value" className="soundboard-volume-value">
              {soundboardVolume}%
            </span>
          </div>
        </div>
        <div id="soundboard-compact-grid" className="soundboard-compact-grid">
          {sortSoundboardByOrder(
            soundboardSounds.filter((sound) => sound.favorite),
            soundboardCustomOrder,
          ).map((sound) => (
              <button
                key={`compact-${sound.id}`}
                className="sound-icon-btn is-favorite"
                type="button"
                title={sound.name}
                onClick={() => void playSound(sound)}
              >
                {sound.icon}
              </button>
            ))}
        </div>
      </div>

      <div id="soundboard" className={`soundboard soundboard-edit${soundboardEditOpen ? '' : ' hidden'}`} role="dialog" aria-label="Soundboard Edit">
        <div className="soundboard-header">
          <h3>Soundboard</h3>
          <div className="soundboard-actions">
            <button
              id="toggle-soundboard-volume"
              type="button"
              aria-expanded={soundboardVolumeOpen}
              aria-controls="soundboard-volume-panel"
              onClick={() => setSoundboardVolumeOpen((prev) => !prev)}
            >
              Soundboard Volume
            </button>
            <button
              id="back-to-soundboard"
              type="button"
              onClick={() => {
                setSoundboardEditOpen(false);
                setSoundboardCompactOpen(true);
                exitSoundboardEditMode();
              }}
            >
              Back to Soundboard
            </button>
          </div>
        </div>
        <div
          id="soundboard-volume-panel"
          className={`soundboard-volume${soundboardVolumeOpen ? '' : ' hidden'}`}
          aria-hidden={!soundboardVolumeOpen}
        >
          <div className="soundboard-volume-row">
            <input
              id="soundboard-volume-edit"
              type="range"
              min="0"
              max="100"
              value={soundboardVolume}
              onChange={(event) => setSoundboardVolume(Number(event.target.value))}
            />
            <span id="soundboard-volume-value-edit" className="soundboard-volume-value">
              {soundboardVolume}%
            </span>
          </div>
        </div>
        <div className="soundboard-search">
          <input id="sound-search" type="text" placeholder="Find the perfect sound" value={soundSearch} onChange={(event) => setSoundSearch(event.target.value)} />
        </div>
        <div id="soundboard-grid" className="soundboard-grid">
          {filteredSoundboard.map((sound) => (
            <div
              key={sound.id}
              className={`sound-tile${sound.favorite ? ' is-favorite' : ''}${soundboardEditingId === sound.id ? ' is-editing' : ''}`}
            >
              <button type="button" className="sound-tile-main" onClick={() => void playSound(sound)}>
                <span className="sound-icon">{sound.icon}</span>
                <span className="sound-name">{sound.name}</span>
              </button>
              <button
                type="button"
                className={`sound-fav${sound.favorite ? ' is-active' : ''}`}
                title="Favorite"
                onClick={() => toggleSoundFavorite(sound.id)}
              >
                ★
              </button>
              <button
                type="button"
                className="sound-edit"
                title="Edit"
                onClick={() => enterSoundboardEditMode(sound)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20h9"></path>
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="soundboard-upload">
          <div className="soundboard-upload-row">
            <input
              id="sound-name"
              type="text"
              maxLength={60}
              placeholder="Name (e.g. Hooray!)"
              value={soundNameInput}
              onChange={(event) => setSoundNameInput(event.target.value)}
            />
            <button id="sound-upload-button" type="button" onClick={() => void uploadSound()}>
              {soundboardEditingId ? 'Save' : 'Upload'}
            </button>
            <button
              id="sound-cancel-edit"
              type="button"
              className={soundboardEditingId ? '' : 'hidden'}
              onClick={exitSoundboardEditMode}
            >
              Cancel
            </button>
            <label className="sound-file">
              <input
                id="sound-file"
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  soundUploadFileRef.current = file;
                  setSoundFileLabel(file ? file.name : 'Select audio');
                }}
              />
              <span id="sound-file-label">{soundFileLabel}</span>
            </label>
          </div>
          <div className="soundboard-upload-volume">
            <div className="soundboard-upload-volume-label">Clip volume</div>
            <input
              id="sound-clip-volume"
              type="range"
              min="0"
              max="200"
              value={soundClipVolume}
              onChange={(event) => setSoundClipVolume(Number(event.target.value))}
            />
            <div id="sound-clip-volume-value" className="soundboard-volume-value">
              {soundClipVolume}%
            </div>
          </div>
          <div className={`soundboard-icons${soundboardEditingId ? '' : ' hidden'}`} id="soundboard-icons-section">
            <div className="soundboard-icons-label">Pick an icon</div>
            <div id="soundboard-icon-grid" className="soundboard-icon-grid">
              {SOUNDBOARD_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  className={`sound-icon-btn${soundboardSelectedIcon === icon ? ' is-selected' : ''}`}
                  onClick={() => setSoundboardSelectedIcon(icon)}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
          <div id="soundboard-hint" className="hint">
            {soundboardHint || 'Tip: favorite sounds appear in quick play.'}
          </div>
        </div>
      </div>

      <div id="camera-lobby" className={`camera-lobby${cameraLobbyOpen ? '' : ' hidden'}`} role="dialog" aria-label="Camera Lobby">
        <div className="camera-lobby-header">
          <h3>Camera Lobby</h3>
          <div className="camera-lobby-actions">
            <button id="lobby-toggle-mic" type="button" className={`lobby-control-btn${micEnabled ? '' : ' active'}`} onClick={() => void toggleMic()}>
              <span className="mic-icon">🎤</span> {micEnabled ? 'Mute Mic' : 'Unmute Mic'}
            </button>
            <button id="lobby-toggle-camera" type="button" className={`lobby-control-btn${camEnabled ? '' : ' active'}`} onClick={() => void toggleCamera()}>
              <span className="camera-icon">📹</span> {camEnabled ? 'Turn Off Camera' : 'Turn On Camera'}
            </button>
            <button id="close-camera-lobby" type="button" onClick={() => setCameraLobbyOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div
          id="camera-lobby-grid"
          className="camera-lobby-grid"
          data-count={Math.max(participantViews.length, 1)}
        >
          {participantViews.length > 0 ? (
            participantViews.map((participant) => (
              <div key={`lobby-${participant.identity}`} className={`camera-lobby-tile${participant.speaking ? ' speaking' : ''}`}>
                {participant.cameraTrack ? (
                  <TrackRenderer
                    track={participant.cameraTrack}
                    className="h-full w-full object-contain"
                    muted={participant.isLocal}
                    onMounted={(element) => {
                      if (!participant.isLocal) registerRemoteMediaElement(element, true);
                    }}
                    onUnmounted={(element) => {
                      if (!participant.isLocal) registerRemoteMediaElement(element, false);
                    }}
                  />
                ) : resolveAvatarUrl(participant.identity) ? (
                  <img className="avatar-img" src={resolveAvatarUrl(participant.identity)} alt={participant.name} />
                ) : (
                  <div className="avatar-placeholder">{getInitials(participant.name)}</div>
                )}
                <div className="name-label">{participant.name}</div>
              </div>
            ))
          ) : (
            <div className="camera-lobby-tile">
              <div className="avatar-placeholder">EC</div>
              <div className="name-label">Waiting for cameras…</div>
            </div>
          )}
        </div>
      </div>

      <div id="theme-panel" className={`theme-panel${themeOpen ? '' : ' hidden'}`} role="dialog" aria-label="Theme">
        <div className="theme-header">
          <h3>Theme</h3>
          <button id="close-theme" type="button" onClick={() => setThemeOpen(false)}>
            Close
          </button>
        </div>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`theme-card${activeTheme === theme.id ? ' is-active' : ''}`}
              data-theme={theme.id}
              onClick={() => setActiveTheme(theme.id)}
            >
              <div className={`theme-preview ${theme.previewClass}`}></div>
              <span className="theme-name">{theme.label}</span>
            </button>
          ))}
        </div>
        <div className="theme-opacity">
          <div className="theme-opacity-label">UI Transparency</div>
          <div className="theme-opacity-row">
            <input
              id="ui-opacity-slider"
              type="range"
              min="20"
              max="100"
              value={uiOpacity}
              onChange={(event) => setUiOpacity(Number(event.target.value))}
            />
            <span id="ui-opacity-value" className="theme-opacity-value">
              {uiOpacity}%
            </span>
          </div>
        </div>
      </div>

      <div id="bug-report-modal" className={`bug-report-modal${bugReportOpen ? '' : ' hidden'}`} role="dialog" aria-label="Bug Report">
        <div className="bug-report-content">
          <div className="bug-report-header">
            <h3>Report a Bug</h3>
            <button id="close-bug-report" type="button" onClick={() => setBugReportOpen(false)}>
              Close
            </button>
          </div>
          <div className="bug-report-body">
            <textarea
              id="bug-report-desc"
              className="bug-report-textarea"
              placeholder="Describe what happened..."
              rows={4}
              maxLength={1000}
              value={bugDescription}
              onChange={(event) => setBugDescription(event.target.value)}
            />
            <div className="bug-report-screenshot-row">
              <label htmlFor="bug-report-file" id="bug-report-screenshot-btn" className="bug-report-screenshot-btn">
                Attach Screenshot
              </label>
              <input
                type="file"
                id="bug-report-file"
                className="hidden"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setBugScreenshotFile(file);
                }}
              />
              <span id="bug-report-file-name" className="bug-report-file-name">
                {bugScreenshotFile?.name || ''}
              </span>
            </div>
            <div id="bug-report-screenshot-preview" className={`bug-report-screenshot-preview${bugScreenshotFile ? '' : ' hidden'}`}>
              {bugScreenshotFile ? <img src={URL.createObjectURL(bugScreenshotFile)} alt="Screenshot preview" /> : null}
            </div>
            <div id="bug-report-stats" className="bug-stats-preview">
              Runtime: room={activeRoom} users={participantViews.length} chat={chatMessages.length} screens={screenParticipants.length}
            </div>
            <div className="bug-report-actions">
              <button id="submit-bug-report" type="button" onClick={() => void submitBugReport()}>
                Send Report
              </button>
            </div>
            <div id="bug-report-status" className="bug-report-status">
              {bugStatus}
            </div>
          </div>
        </div>
      </div>

      <div id="jam-panel" className={`jam-panel${jamOpen ? '' : ' hidden'}`} role="dialog" aria-label="Jam Session">
        <div className="jam-header">
          <h3>Jam Session</h3>
          <button id="close-jam" type="button" onClick={() => setJamOpen(false)}>
            Close
          </button>
        </div>
        <div className="jam-body">
          <div className="jam-spotify-row">
            <span id="jam-spotify-status" className={`jam-spotify-status${jamState?.spotify_connected ? ' connected' : ''}`}>
              {jamState?.spotify_connected ? 'Connected' : 'Not Connected'}
            </span>
            <button
              id="jam-connect-spotify"
              type="button"
              className="jam-connect-btn"
              disabled={!canUseRoomControls}
              onClick={() => void connectSpotify()}
            >
              Connect Spotify
            </button>
          </div>

          <div id="jam-host-controls" className="jam-host-controls" style={{ display: isJamHost || !jamState?.active ? 'flex' : 'none' }}>
            <button
              id="jam-start-btn"
              type="button"
              className="jam-start-btn"
              style={{ display: jamState?.active ? 'none' : 'block' }}
              disabled={!canUseRoomControls || !jamState?.spotify_connected}
              onClick={() =>
                void jamAction('/api/jam/start', {
                  body: { identity: localIdentity },
                  onSuccess: () => {
                    setJamStatus('Jam started.');
                    void publishData({
                      type: 'jam-started',
                      host: name || localIdentity || 'Host',
                      room: activeRoom,
                    });
                  },
                })
              }
            >
              Start Jam
            </button>
            <button
              id="jam-stop-btn"
              type="button"
              className="jam-stop-btn"
              style={{ display: jamState?.active ? 'block' : 'none' }}
              onClick={() =>
                void jamAction('/api/jam/stop', {
                  body: { identity: localIdentity },
                  onSuccess: () => {
                    setJamStatus('Jam ended.');
                    stopJamAudioStream();
                    void publishData({ type: 'jam-stopped', room: activeRoom });
                  },
                })
              }
            >
              End Jam
            </button>
            <button
              id="jam-skip-btn"
              type="button"
              className="jam-skip-btn"
              style={{ display: jamState?.active ? 'block' : 'none' }}
              disabled={!isJamHost}
              onClick={() => void jamAction('/api/jam/skip')}
            >
              Skip
            </button>
          </div>

          <div id="jam-now-playing" className="jam-now-playing">
            {jamState?.now_playing ? (
              <>
                <img className="jam-now-playing-art" src={jamState.now_playing.album_art_url} alt={jamState.now_playing.name} />
                <div className="jam-now-playing-info">
                  <div className="jam-now-playing-name">{jamState.now_playing.name}</div>
                  <div className="jam-now-playing-artist">{jamState.now_playing.artist}</div>
                  <div className="jam-progress">
                    <div
                      className="jam-progress-bar"
                      style={{
                        width: jamState.now_playing.duration_ms
                          ? `${Math.min(100, (jamState.now_playing.progress_ms / jamState.now_playing.duration_ms) * 100)}%`
                          : '0%',
                      }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="jam-now-playing-empty">No music playing</div>
            )}
          </div>

          <div id="jam-actions-section" className="jam-actions" style={{ display: jamState?.active ? 'flex' : 'none' }}>
            <button
              id="jam-join-btn"
              type="button"
              className="jam-join-btn"
              style={{ display: isJamListening ? 'none' : 'inline-flex' }}
              onClick={() =>
                void jamAction('/api/jam/join', {
                  body: { identity: localIdentity },
                  onSuccess: () => {
                    startJamAudioStream();
                    setJamStatus('Joined jam.');
                  },
                })
              }
            >
              Join Jam
            </button>
            <button
              id="jam-leave-btn"
              type="button"
              className="jam-leave-btn"
              style={{ display: isJamListening ? 'inline-flex' : 'none' }}
              onClick={() =>
                void jamAction('/api/jam/leave', {
                  body: { identity: localIdentity },
                  onSuccess: () => {
                    stopJamAudioStream();
                    setJamStatus('Left jam.');
                  },
                })
              }
            >
              Leave Jam
            </button>
            <span id="jam-listener-count" className="jam-listener-count">
              {jamState?.listener_count || 0} listening
            </span>
          </div>

          <div className="jam-volume-section">
            <label className="jam-volume-label">Jam Volume</label>
            <div className="jam-volume-row">
              <input
                id="jam-volume-slider"
                type="range"
                min="0"
                max="100"
                value={jamVolume}
                onChange={(event) => setJamVolume(Number(event.target.value))}
              />
              <span id="jam-volume-value" className="jam-volume-value">
                {jamVolume}%
              </span>
            </div>
          </div>

          <div className="jam-search-queue-row">
            <div id="jam-search-section" className="jam-search-section" style={{ display: isJamHost ? 'flex' : 'none' }}>
              <input
                id="jam-search-input"
                type="text"
                className="jam-search-input"
                placeholder="Search for a song..."
                value={jamSearch}
                onChange={(event) => setJamSearch(event.target.value)}
              />
              <div id="jam-results" className="jam-results">
                {jamSearchResults.map((track) => (
                  <div key={track.spotify_uri} className="jam-result-item">
                    <img className="jam-result-art" src={track.album_art_url} alt={track.name} />
                    <div className="jam-result-info">
                      <div className="jam-result-name">{track.name}</div>
                      <div className="jam-result-artist">{track.artist}</div>
                    </div>
                    <button className="jam-result-add" type="button" onClick={() => void addJamTrack(track)}>
                      +
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div id="jam-queue-section" className="jam-queue-section" style={{ display: jamState?.active ? 'flex' : 'none' }}>
              <div className="jam-queue-title">Queue</div>
              <div id="jam-queue-list" className="jam-queue-list">
                {jamState?.queue?.length ? (
                  jamState.queue.map((track, index) => (
                    <div key={`${track.spotify_uri}-${index}`} className="jam-queue-item">
                      <img className="jam-result-art" src={track.album_art_url} alt={track.name} />
                      <div className="jam-result-info">
                        <div className="jam-result-name">{track.name}</div>
                        <div className="jam-result-artist">{track.artist}</div>
                      </div>
                      {isJamHost ? (
                        <button className="jam-queue-remove" type="button" onClick={() => void removeJamTrack(index)}>
                          ✕
                        </button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="jam-queue-empty">Queue is empty</div>
                )}
              </div>
            </div>
          </div>

          <div id="jam-status" className={`jam-status${jamError ? ' error' : ''}`}>
            {jamError || jamStatus}
          </div>
        </div>
      </div>

      <div
        id="admin-dash-panel"
        className={`admin-only admin-dash-panel${isAdminMode && adminDashOpen ? '' : ' hidden'}`}
        style={{ ['--admin-panel-width' as any]: `${adminPanelWidth}px` }}
      >
        <div className="admin-dash-header">
          <h3>Admin Dashboard</h3>
          <button type="button" className="admin-dash-close" onClick={toggleAdminDash}>
            &times;
          </button>
        </div>
        <div className="admin-dash-tabs">
          <button
            type="button"
            className={`adm-tab${adminDashTab === 'live' ? ' active' : ''}`}
            onClick={() => setAdminDashTab('live')}
          >
            Live
          </button>
          <button
            type="button"
            className={`adm-tab${adminDashTab === 'history' ? ' active' : ''}`}
            onClick={() => setAdminDashTab('history')}
          >
            History
          </button>
          <button
            type="button"
            className={`adm-tab${adminDashTab === 'metrics' ? ' active' : ''}`}
            onClick={() => setAdminDashTab('metrics')}
          >
            Metrics
          </button>
          <button
            type="button"
            className={`adm-tab${adminDashTab === 'bugs' ? ' active' : ''}`}
            onClick={() => setAdminDashTab('bugs')}
          >
            Bugs
          </button>
          <button
            type="button"
            className={`adm-tab${adminDashTab === 'deploys' ? ' active' : ''}`}
            onClick={() => setAdminDashTab('deploys')}
          >
            Deploys
          </button>
        </div>

        <div id="admin-dash-live" className={`admin-dash-content${adminDashTab === 'live' ? '' : ' hidden'}`}>
          <div className="adm-stat-row">
            <span className="adm-stat-label">
              Online
              {adminDashboard?.server_version ? ` · v${adminDashboard.server_version}` : ''}
            </span>
            <span className="adm-stat-value">{adminDashboard?.total_online ?? 0}</span>
          </div>
          {adminRooms.length > 0 ? (
            adminRooms.map((roomEntry) => {
              const participants = roomEntry.participants ?? [];
              return (
                <div key={roomEntry.room_id} className="adm-room-card">
                  <div className="adm-room-header">
                    {roomEntry.room_id}{' '}
                    <span className="adm-room-count">{participants.length}</span>
                  </div>
                  {participants.map((participant) => {
                    const stats = participant.stats;
                    return (
                      <div key={participant.identity} className="adm-participant">
                        <span>{participant.name || participant.identity}</span>
                        <span className="adm-time">{formatDuration(participant.online_seconds)}</span>
                        {participant.viewer_version ? (
                          <span className="adm-badge adm-badge-ok">v{participant.viewer_version}</span>
                        ) : (
                          <span className="adm-badge adm-badge-bad">STALE</span>
                        )}
                        {stats?.ice_remote_type ? (
                          <span className={`adm-badge adm-ice-${stats.ice_remote_type}`}>{stats.ice_remote_type}</span>
                        ) : null}
                        {stats?.screen_fps != null ? (
                          <span className="adm-chip">
                            {stats.screen_fps}fps {stats.screen_width}x{stats.screen_height}
                          </span>
                        ) : null}
                        {stats?.quality_limitation && stats.quality_limitation !== 'none' ? (
                          <span className="adm-badge adm-badge-warn">{stats.quality_limitation}</span>
                        ) : null}
                        <button
                          type="button"
                          className="adm-show-all-btn"
                          onClick={() => void adminMute(roomEntry.room_id, participant.identity)}
                        >
                          Mute
                        </button>
                        <button
                          type="button"
                          className="adm-show-all-btn"
                          onClick={() => void adminKick(roomEntry.room_id, participant.identity)}
                        >
                          Kick
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })
          ) : (
            <div className="adm-empty">No active rooms</div>
          )}
        </div>

        <div id="admin-dash-history" className={`admin-dash-content${adminDashTab === 'history' ? '' : ' hidden'}`}>
          {adminEvents.length > 0 ? (
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>User</th>
                  <th>Room</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {adminEvents.map((event, index) => {
                  const isJoin = event.event_type === 'join';
                  return (
                    <tr key={`${event.identity}-${event.timestamp}-${index}`}>
                      <td>{formatAdminTime(event.timestamp)}</td>
                      <td>
                        <span className={`adm-badge ${isJoin ? 'adm-join' : 'adm-leave'}`}>
                          {isJoin ? 'JOIN' : 'LEAVE'}
                        </span>
                      </td>
                      <td>{event.name || event.identity}</td>
                      <td>{event.room_id}</td>
                      <td>{event.duration_secs != null ? formatDuration(event.duration_secs) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="adm-empty">No session history</div>
          )}
        </div>

        <div id="admin-dash-metrics" className={`admin-dash-content${adminDashTab === 'metrics' ? '' : ' hidden'}`}>
          {adminMetricsSummary ? (
            <div className="adm-cards">
              <div className="adm-card">
                <div className="adm-card-value">{adminMetricsSummary.total_sessions ?? 0}</div>
                <div className="adm-card-label">Sessions (30d)</div>
              </div>
              <div className="adm-card">
                <div className="adm-card-value">{adminMetricsSummary.unique_users ?? 0}</div>
                <div className="adm-card-label">Unique Users</div>
              </div>
              <div className="adm-card">
                <div className="adm-card-value">{adminMetricsSummary.total_hours ?? 0}</div>
                <div className="adm-card-label">Total Hours</div>
              </div>
              <div className="adm-card">
                <div className="adm-card-value">{adminMetricsSummary.avg_duration_mins ?? 0}m</div>
                <div className="adm-card-label">Avg Duration</div>
              </div>
            </div>
          ) : null}

          {adminPerUserMetrics.length > 0 ? (
            <div className="adm-section">
              <div className="adm-section-title">User Leaderboard (30d)</div>
              {adminPerUserMetrics.map((user) => {
                const max = adminPerUserMetrics[0]?.session_count || 1;
                const pct = Math.max(2, ((user.session_count || 0) / max) * 100);
                return (
                  <div key={`${user.identity}-${user.name ?? ''}`} className="adm-leaderboard-bar" style={{ cursor: 'default' }}>
                    <span className="adm-leaderboard-name">{user.name || user.identity}</span>
                    <div className="adm-leaderboard-fill" style={{ width: `${pct}%` }} />
                    <span className="adm-leaderboard-count">
                      {user.session_count} ({user.total_hours}h)
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {adminQualityUsers.length > 0 ? (
            <>
              <div className="adm-cards">
                <div className="adm-card">
                  <div className="adm-card-value">
                    {(adminQualityUsers.reduce((sum, user) => sum + user.avg_fps, 0) / adminQualityUsers.length).toFixed(1)}
                  </div>
                  <div className="adm-card-label">Avg FPS</div>
                </div>
                <div className="adm-card">
                  <div className="adm-card-value">
                    {(
                      adminQualityUsers.reduce((sum, user) => sum + user.avg_bitrate_kbps, 0) /
                      adminQualityUsers.length /
                      1000
                    ).toFixed(1)}
                  </div>
                  <div className="adm-card-label">Avg Mbps</div>
                </div>
                <div className="adm-card">
                  <div className="adm-card-value">
                    {(adminQualityUsers.reduce((sum, user) => sum + user.pct_bandwidth_limited, 0) / adminQualityUsers.length).toFixed(1)}%
                  </div>
                  <div className="adm-card-label">BW Limited</div>
                </div>
                <div className="adm-card">
                  <div className="adm-card-value">
                    {(adminQualityUsers.reduce((sum, user) => sum + user.pct_cpu_limited, 0) / adminQualityUsers.length).toFixed(1)}%
                  </div>
                  <div className="adm-card-label">CPU Limited</div>
                </div>
              </div>

              <table className="adm-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Avg FPS</th>
                    <th>Avg Mbps</th>
                    <th>Encoder</th>
                    <th>ICE</th>
                    <th>Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {adminQualityUsers.map((user) => (
                    <tr key={`${user.identity}-${user.name ?? ''}`}>
                      <td>{user.name || user.identity}</td>
                      <td>{user.avg_fps.toFixed(1)}</td>
                      <td>{(user.avg_bitrate_kbps / 1000).toFixed(1)}</td>
                      <td>{user.encoder || '—'}</td>
                      <td>{user.ice_remote_type || user.ice_local_type || '—'}</td>
                      <td>{user.sample_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="adm-empty">No quality data yet</div>
          )}

          {bugsByUser.length > 0 ? (
            <div className="adm-section">
              <div className="adm-section-title">Bug Reports by User</div>
              {bugsByUser.map((entry) => {
                const max = bugsByUser[0]?.count || 1;
                const pct = (entry.count / max) * 100;
                return (
                  <div key={entry.name} className="adm-leaderboard-bar" style={{ cursor: 'default' }}>
                    <span className="adm-leaderboard-name">{entry.name}</span>
                    <div className="adm-leaderboard-fill" style={{ width: `${pct}%` }} />
                    <span className="adm-leaderboard-count">{entry.count}</span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {bugsByDay.length > 0 ? (
            <div className="adm-section">
              <div className="adm-section-title">Bugs by Day</div>
              <div className="adm-bugs-by-day">
                {bugsByDay.map((entry) => {
                  const max = Math.max(...bugsByDay.map((item) => item.count));
                  const pct = max > 0 ? (entry.count / max) * 100 : 0;
                  const label = new Date(`${entry.dayKey}T12:00:00`).toLocaleDateString([], {
                    month: 'short',
                    day: 'numeric',
                  });
                  return (
                    <div key={entry.dayKey} className="adm-bug-day-col">
                      <div className="adm-bug-day-bar" style={{ height: `${pct}%` }} title={`${label}: ${entry.count} bugs`} />
                      <div className="adm-bug-day-count">{entry.count}</div>
                      <div className="adm-bug-day-label">{label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div id="admin-dash-bugs" className={`admin-dash-content${adminDashTab === 'bugs' ? '' : ' hidden'}`}>
          {adminBugReports.length > 0 ? (
            adminBugReports.map((report, index) => (
              <div key={`${report.timestamp}-${index}`} className="adm-bug">
                <div className="adm-bug-header">
                  <strong>{report.name || report.reporter || report.identity || 'Unknown'}</strong>
                  <span className="adm-time">{formatAdminTime(report.timestamp)}</span>
                </div>
                <div className="adm-bug-desc">{report.description}</div>
              </div>
            ))
          ) : (
            <div className="adm-empty">No bug reports</div>
          )}
        </div>

        <div id="admin-dash-deploys" className={`admin-dash-content${adminDashTab === 'deploys' ? '' : ' hidden'}`}>
          {adminDeployCommits.length > 0 ? (
            <div className="adm-deploy-list">
              {adminDeployCommits.map((commit, index) => {
                const status = commit.deploy_status || 'pending';
                const statusClass =
                  status === 'success'
                    ? 'adm-deploy-success'
                    : status === 'failed'
                      ? 'adm-deploy-failed'
                      : status === 'rollback'
                        ? 'adm-deploy-rollback'
                        : 'adm-deploy-pending';
                const statusLabel =
                  status === 'success'
                    ? 'deployed'
                    : status === 'failed'
                      ? 'failed'
                      : status === 'rollback'
                        ? 'rolled back'
                        : 'pending';

                return (
                  <div key={`${commit.sha ?? commit.short_sha ?? 'deploy'}-${index}`} className="adm-deploy-row">
                    <div className="adm-deploy-status">
                      <span className={`adm-deploy-badge ${statusClass}`}>{statusLabel}</span>
                    </div>
                    <div className="adm-deploy-info">
                      <div className="adm-deploy-msg">{commit.message || '(no message)'}</div>
                      <div className="adm-deploy-meta">
                        <span className="adm-deploy-sha">{commit.short_sha || commit.sha || ''}</span>
                        <span className="adm-deploy-author">{commit.author || 'unknown'}</span>
                        <span className="adm-deploy-time">{formatDeployTime(commit.timestamp || commit.deploy_timestamp)}</span>
                        {commit.deploy_duration != null ? <span className="adm-deploy-dur">{commit.deploy_duration}s</span> : null}
                      </div>
                      {commit.deploy_error ? <div className="adm-deploy-err">{commit.deploy_error}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="adm-empty">No deploy history yet</div>
          )}
        </div>

        <div className="admin-dash-resize-handle" onMouseDown={startAdminResize} />
      </div>

      <div id="debug-panel" className={`debug-panel${debugOpen ? '' : ' hidden'}`}>
        <div className="debug-panel-header">
          <div>Debug Log</div>
          <div className="debug-panel-actions">
            <button id="debug-copy" type="button" onClick={() => void copyDebugLog()}>
              Copy
            </button>
            <button id="debug-clear" type="button" onClick={() => setDebugLog([])}>
              Clear
            </button>
            <button id="debug-close" type="button" onClick={() => setDebugOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <pre id="debug-log">{debugLog.map((line) => line.text).join('\n')}</pre>
      </div>
    </main>
  );
}
