import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useActorRef, useSelector } from '@xstate/react';
import { connectionMachine } from '@/features/connection/connectionMachine';
import { useViewerPrefsStore } from '@/stores/viewerPrefsStore';
import { useOnlineUsersQuery } from '@/features/connection/useOnlineUsersQuery';
import { useRoomStatusQuery } from '@/features/connection/useRoomStatusQuery';
import type { RoomStatusParticipant } from '@/lib/api';

const FIXED_ROOMS = ['main', 'breakout-1', 'breakout-2', 'breakout-3'] as const;
const ROOM_DISPLAY_NAMES: Record<(typeof FIXED_ROOMS)[number], string> = {
  main: 'Main',
  'breakout-1': 'Breakout 1',
  'breakout-2': 'Breakout 2',
  'breakout-3': 'Breakout 3',
};

const THEMES = [
  { id: 'frost', label: 'Frost', previewClass: 'frost-preview' },
  { id: 'cyberpunk', label: 'Cyberpunk', previewClass: 'cyberpunk-preview' },
  { id: 'aurora', label: 'Aurora', previewClass: 'aurora-preview' },
  { id: 'ember', label: 'Ember', previewClass: 'ember-preview' },
  { id: 'matrix', label: 'Matrix', previewClass: 'matrix-preview' },
  { id: 'midnight', label: 'Midnight', previewClass: 'midnight-preview' },
  { id: 'ultra-instinct', label: 'Ultra Instinct', previewClass: 'ultra-instinct-preview' },
] as const;

const EMOJI_LIST = ['😀', '😂', '🔥', '👏', '🎉', '👀', '🫡', '🤝', '🎧', '🛶', '💯', '✅'];
const DEFAULT_SOUNDS = [
  { id: 'airhorn', name: 'Airhorn', icon: '📣', favorite: true },
  { id: 'laugh', name: 'Laugh Track', icon: '😂', favorite: true },
  { id: 'drumroll', name: 'Drumroll', icon: '🥁', favorite: false },
  { id: 'applause', name: 'Applause', icon: '👏', favorite: true },
  { id: 'sad', name: 'Sad Trombone', icon: '🎺', favorite: false },
  { id: 'win', name: 'Victory', icon: '🏆', favorite: false },
];

function getStoredValue(key: string): string | null {
  try {
    const storage = globalThis.localStorage as { getItem?: (k: string) => string | null } | undefined;
    if (!storage || typeof storage.getItem !== 'function') return null;
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredValue(key: string, value: string): void {
  try {
    const storage = globalThis.localStorage as { setItem?: (k: string, v: string) => void } | undefined;
    if (!storage || typeof storage.setItem !== 'function') return;
    storage.setItem(key, value);
  } catch {
    // ignore storage errors
  }
}

type ChatMessage = {
  id: string;
  author: string;
  text: string;
  timestamp: number;
  self: boolean;
};

type DebugEntry = {
  id: number;
  text: string;
};

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '??';
}

function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stableRoomId(room: string): (typeof FIXED_ROOMS)[number] {
  if (FIXED_ROOMS.includes(room as (typeof FIXED_ROOMS)[number])) {
    return room as (typeof FIXED_ROOMS)[number];
  }
  return 'main';
}

export function App() {
  const actorRef = useActorRef(connectionMachine);
  const snapshot = useSelector(actorRef, (state) => state);

  const { controlUrl, sfuUrl, room, name, identity, adminPassword, setField } = useViewerPrefsStore();

  const [micEnabled, setMicEnabled] = useState(false);
  const [camEnabled, setCamEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  const [roomAudioMuted, setRoomAudioMuted] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState(0);

  const [soundboardCompactOpen, setSoundboardCompactOpen] = useState(false);
  const [soundboardEditOpen, setSoundboardEditOpen] = useState(false);
  const [soundboardVolumeOpen, setSoundboardVolumeOpen] = useState(false);
  const [soundboardVolume, setSoundboardVolume] = useState(100);
  const [soundSearch, setSoundSearch] = useState('');
  const [sounds, setSounds] = useState(DEFAULT_SOUNDS);
  const [soundboardHint, setSoundboardHint] = useState('');

  const [cameraLobbyOpen, setCameraLobbyOpen] = useState(false);
  const [lobbyMicMuted, setLobbyMicMuted] = useState(false);
  const [lobbyCameraMuted, setLobbyCameraMuted] = useState(false);

  const [themeOpen, setThemeOpen] = useState(false);
  const [activeTheme, setActiveTheme] = useState<string>(() => getStoredValue('echo-core-theme') ?? 'frost');
  const [uiOpacity, setUiOpacity] = useState<number>(() => {
    const raw = Number.parseInt(getStoredValue('echo-core-ui-opacity') ?? '100', 10);
    if (Number.isNaN(raw)) return 100;
    return Math.max(20, Math.min(100, raw));
  });

  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugDescription, setBugDescription] = useState('');
  const [bugStatus, setBugStatus] = useState('');

  const [jamOpen, setJamOpen] = useState(false);
  const [jamVolume, setJamVolume] = useState(50);

  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);

  const [deviceStatus, setDeviceStatus] = useState('');
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [camDevices, setCamDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);

  const onlineUsersQuery = useOnlineUsersQuery(controlUrl.trim());

  const adminToken = snapshot.context.session?.adminToken ?? null;
  const roomStatusQuery = useRoomStatusQuery(controlUrl.trim(), adminToken);
  const activeRoom = stableRoomId((room || 'main').trim());

  const roomStatusMap = useMemo(() => {
    const map = new Map<string, RoomStatusParticipant[]>();
    (roomStatusQuery.data ?? []).forEach((entry) => {
      map.set(entry.room_id, entry.participants ?? []);
    });
    return map;
  }, [roomStatusQuery.data]);

  const activeParticipants = roomStatusMap.get(activeRoom) ?? [];
  const connected = snapshot.matches('connected');
  const provisioning = snapshot.matches('provisioning');
  const canUseRoomControls = connected && Boolean(adminToken);

  const filteredSounds = useMemo(
    () => sounds.filter((sound) => sound.name.toLowerCase().includes(soundSearch.toLowerCase())),
    [soundSearch, sounds],
  );

  const statusText = useMemo(() => {
    if (snapshot.matches('connected')) return 'Connected';
    if (snapshot.matches('provisioning')) return 'Connecting…';
    if (snapshot.matches('failed')) return `Connection failed: ${snapshot.context.lastError ?? 'Unknown error'}`;
    return 'Idle';
  }, [snapshot]);

  function appendDebug(text: string): void {
    setDebugLog((prev) => [...prev, { id: Date.now() + Math.random(), text: `[${new Date().toLocaleTimeString()}] ${text}` }]);
  }

  useEffect(() => {
    document.body.dataset.theme = activeTheme;
    setStoredValue('echo-core-theme', activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    const clamped = Math.max(20, Math.min(100, uiOpacity));
    document.documentElement.style.setProperty('--ui-bg-alpha', `${clamped / 100}`);
    setStoredValue('echo-core-ui-opacity', String(clamped));
  }, [uiOpacity]);

  useEffect(() => {
    if (chatOpen) {
      setUnreadChatCount(0);
    }
  }, [chatOpen]);

  useEffect(() => {
    if (connected) {
      appendDebug(`Connected as ${snapshot.context.session?.identity ?? 'unknown'} in ${activeRoom}`);
      setChatMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          author: 'System',
          text: `Connected to ${ROOM_DISPLAY_NAMES[activeRoom]}.`,
          timestamp: Date.now(),
          self: false,
        },
      ]);
    }
  }, [connected]);

  async function refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceStatus('Device enumeration is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices
        .getUserMedia({ audio: true, video: true })
        .catch(() => null);

      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((device) => device.kind === 'audioinput');
      const cams = devices.filter((device) => device.kind === 'videoinput');
      const speakers = devices.filter((device) => device.kind === 'audiooutput');

      setMicDevices(mics);
      setCamDevices(cams);
      setSpeakerDevices(speakers);
      setDeviceStatus(`Found ${mics.length} mic(s), ${cams.length} camera(s), ${speakers.length} speaker(s).`);

      if (!identity && mics.length > 0) {
        setField('identity', `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.floor(Math.random() * 10000)}`);
      }

      stream?.getTracks().forEach((track) => track.stop());
    } catch (error) {
      setDeviceStatus(`Unable to refresh devices: ${(error as Error).message}`);
    }
  }

  function buildConnectionRequest(nextRoom = activeRoom) {
    return {
      controlUrl: controlUrl.trim(),
      sfuUrl: sfuUrl.trim(),
      room: nextRoom,
      name: name.trim() || 'Viewer',
      identity: identity.trim(),
      adminPassword,
    };
  }

  function onConnect(): void {
    actorRef.send({ type: 'CONNECT', request: buildConnectionRequest() });
  }

  function onDisconnect(): void {
    actorRef.send({ type: 'DISCONNECT' });
    setMicEnabled(false);
    setCamEnabled(false);
    setScreenEnabled(false);
    setRoomAudioMuted(false);
    appendDebug('Disconnected from room');
  }

  function onSwitchRoom(roomId: (typeof FIXED_ROOMS)[number]): void {
    setField('room', roomId);
    appendDebug(`Room selected: ${roomId}`);

    if (connected) {
      actorRef.send({ type: 'CONNECT', request: buildConnectionRequest(roomId) });
    }
  }

  function sendChatMessage(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    const text = chatInput.trim();
    if (!text || !connected) return;

    const nextMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      author: name || 'Viewer',
      text,
      timestamp: Date.now(),
      self: true,
    };

    setChatMessages((prev) => [...prev, nextMessage]);
    setChatInput('');
    setEmojiPickerOpen(false);
    appendDebug(`Chat message sent (${text.length} chars)`);
  }

  function onChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  }

  function addEmoji(emoji: string): void {
    setChatInput((prev) => `${prev}${emoji}`);
    setEmojiPickerOpen(false);
  }

  function playSound(soundId: string): void {
    const sound = sounds.find((item) => item.id === soundId);
    if (!sound) return;
    setSoundboardHint(`Played ${sound.name} (${soundboardVolume}%).`);
    appendDebug(`Soundboard: ${sound.name}`);
  }

  function toggleFavorite(soundId: string): void {
    setSounds((prev) => prev.map((sound) => (sound.id === soundId ? { ...sound, favorite: !sound.favorite } : sound)));
  }

  function submitBugReport(): void {
    if (!bugDescription.trim()) {
      setBugStatus('Please describe the issue before sending.');
      return;
    }

    setBugStatus('Bug report queued in React viewer (server submission not wired yet).');
    appendDebug(`Bug report captured (${bugDescription.length} chars)`);
  }

  async function copyDebugLog(): Promise<void> {
    const text = debugLog.map((line) => line.text).join('\n');
    await navigator.clipboard.writeText(text);
  }

  return (
    <main className="app">
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
            <input id="sfu-url" type="text" value={sfuUrl} placeholder="ws://127.0.0.1:7880" onChange={(event) => setField('sfuUrl', event.target.value)} />
          </label>
          <input id="room" type="hidden" value={activeRoom} readOnly />
          <input id="identity" type="hidden" value={identity} readOnly />
          <label>
            Name
            <input id="name" type="text" value={name} onChange={(event) => setField('name', event.target.value)} />
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
          <button id="toggle-mic" disabled={!canUseRoomControls} className={micEnabled ? 'is-on' : ''} onClick={() => setMicEnabled((prev) => !prev)}>
            {micEnabled ? 'Disable Mic' : 'Enable Mic'}
          </button>
          <button id="toggle-cam" disabled={!canUseRoomControls} className={camEnabled ? 'is-on' : ''} onClick={() => setCamEnabled((prev) => !prev)}>
            {camEnabled ? 'Disable Camera' : 'Enable Camera'}
          </button>
          <button
            id="toggle-screen"
            disabled={!canUseRoomControls}
            className={screenEnabled ? 'is-on' : ''}
            onClick={() => setScreenEnabled((prev) => !prev)}
          >
            {screenEnabled ? 'Stop Screen' : 'Share Screen'}
          </button>
        </div>

        <div className="actions device-actions">
          <label className="device-field">
            Mic
            <select id="mic-select" disabled={!connected}>
              {micDevices.map((device) => (
                <option key={device.deviceId || device.label} value={device.deviceId}>
                  {device.label || 'Microphone'}
                </option>
              ))}
            </select>
          </label>
          <label className="device-field">
            Camera
            <select id="cam-select" disabled={!connected}>
              {camDevices.map((device) => (
                <option key={device.deviceId || device.label} value={device.deviceId}>
                  {device.label || 'Camera'}
                </option>
              ))}
            </select>
          </label>
          <label className="device-field">
            Output
            <select id="speaker-select" disabled={!connected}>
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
                  <span key={`${user.identity ?? user.name ?? 'online'}-${index}`} className="online-user-pill" title={user.room ? `In room: ${user.room}` : ''}>
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

          <div id="jam-banner" className={`jam-banner${canUseRoomControls ? '' : ' hidden'}`}>
            <img className="jam-banner-art" src="/badge.jpg" alt="" />
            <div className="jam-banner-info">
              <div className="jam-banner-title">Jam ready in React viewer</div>
              <div className="jam-banner-artist">Open Jam to connect Spotify controls</div>
            </div>
            <span className="jam-banner-live">JAM</span>
          </div>

          <div className="room-actions">
            <button id="open-admin-dash" type="button" className="admin-only hidden" disabled>
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
              {activeParticipants.length > 0 ? (
                activeParticipants.map((participant) => (
                  <div key={`${participant.identity}-screen`} className="tile">
                    <h3>{participant.name ?? participant.identity}</h3>
                    <div className="hint">No active screen share</div>
                  </div>
                ))
              ) : (
                <div className="tile">
                  <h3>Room preview</h3>
                  <div className="hint">No shared screens yet.</div>
                </div>
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
                  <button id="open-chat" type="button" disabled={!connected} onClick={() => setChatOpen(true)} className={unreadChatCount > 0 ? 'has-unread' : ''}>
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
              {activeParticipants.length === 0 ? <div className="hint">No active users in this room yet.</div> : null}
              {activeParticipants.map((participant) => (
                <article key={participant.identity} className="user-card">
                  <div className="user-header">
                    <div className="user-avatar">{getInitials(participant.name ?? participant.identity)}</div>
                    <div className="user-meta">
                      <h3 className="user-name">{participant.name ?? participant.identity}</h3>
                      <div className="user-status">
                        <span className="pill is-on">Connected</span>
                        <span className="pill">Mic unknown</span>
                      </div>
                    </div>
                  </div>
                  <div className="user-controls">
                    <button className="mute-button" type="button">
                      Mute
                    </button>
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
                <article key={message.id} className="chat-message">
                  <div className="chat-message-header">
                    <span className={`chat-message-author${message.self ? ' self' : ''}`}>{message.author}</span>
                    <span className="chat-message-time">{formatChatTime(message.timestamp)}</span>
                  </div>
                  <div className="chat-message-content">{message.text}</div>
                </article>
              ))}
              {chatMessages.length === 0 ? <div className="hint">No messages yet.</div> : null}
            </div>
            <form className="chat-input-container" onSubmit={sendChatMessage}>
              <button id="chat-upload-btn" type="button" className="chat-upload-btn" title="Upload file or image" disabled>
                📎
              </button>
              <button id="chat-emoji-btn" type="button" className="chat-emoji-btn" title="Add emoji" onClick={() => setEmojiPickerOpen((prev) => !prev)}>
                😊
              </button>
              <input type="file" id="chat-file-input" className="hidden" accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt" />
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

        <div id="audio-bucket" className="audio-bucket" />
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
              <select disabled={!connected}>
                {micDevices.map((device) => (
                  <option key={`settings-${device.deviceId || device.label}`} value={device.deviceId}>
                    {device.label || 'Microphone'}
                  </option>
                ))}
              </select>
            </label>
            <label className="device-field">
              Camera
              <select disabled={!connected}>
                {camDevices.map((device) => (
                  <option key={`settings-${device.deviceId || device.label}`} value={device.deviceId}>
                    {device.label || 'Camera'}
                  </option>
                ))}
              </select>
            </label>
            <label className="device-field">
              Output
              <select disabled={!connected}>
                {speakerDevices.map((device) => (
                  <option key={`settings-${device.deviceId || device.label}`} value={device.deviceId}>
                    {device.label || 'Speaker'}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void refreshDevices()} disabled={!connected}>
              Refresh Devices
            </button>
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
        <div id="soundboard-volume-panel-compact" className={`soundboard-volume-compact${soundboardVolumeOpen ? '' : ' hidden'}`} aria-hidden={!soundboardVolumeOpen}>
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
          {sounds.filter((sound) => sound.favorite).map((sound) => (
            <button key={`compact-${sound.id}`} className="sound-icon-btn is-favorite" type="button" title={sound.name} onClick={() => playSound(sound.id)}>
              {sound.icon}
            </button>
          ))}
        </div>
      </div>

      <div id="soundboard" className={`soundboard soundboard-edit${soundboardEditOpen ? '' : ' hidden'}`} role="dialog" aria-label="Soundboard Edit">
        <div className="soundboard-header">
          <h3>Soundboard</h3>
          <div className="soundboard-actions">
            <button id="toggle-soundboard-volume" type="button" aria-expanded={soundboardVolumeOpen} aria-controls="soundboard-volume-panel" onClick={() => setSoundboardVolumeOpen((prev) => !prev)}>
              Soundboard Volume
            </button>
            <button
              id="back-to-soundboard"
              type="button"
              onClick={() => {
                setSoundboardEditOpen(false);
                setSoundboardCompactOpen(true);
              }}
            >
              Back to Soundboard
            </button>
          </div>
        </div>
        <div id="soundboard-volume-panel" className={`soundboard-volume${soundboardVolumeOpen ? '' : ' hidden'}`} aria-hidden={!soundboardVolumeOpen}>
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
          {filteredSounds.map((sound) => (
            <div key={sound.id} className={`sound-tile${sound.favorite ? ' is-favorite' : ''}`}>
              <button type="button" className="sound-tile-main" onClick={() => playSound(sound.id)}>
                <span className="sound-icon">{sound.icon}</span>
                <span className="sound-name">{sound.name}</span>
              </button>
              <button type="button" className={`sound-fav${sound.favorite ? ' is-active' : ''}`} title="Favorite" onClick={() => toggleFavorite(sound.id)}>
                ★
              </button>
            </div>
          ))}
        </div>
        <div className="soundboard-upload">
          <div className="soundboard-upload-row">
            <input id="sound-name" type="text" maxLength={60} placeholder="Name (e.g. Hooray!)" disabled />
            <button id="sound-upload-button" type="button" disabled>
              Upload
            </button>
            <button id="sound-cancel-edit" type="button" className="hidden" disabled>
              Cancel
            </button>
            <label className="sound-file">
              <input id="sound-file" type="file" accept="audio/*" disabled />
              <span id="sound-file-label">Select audio</span>
            </label>
          </div>
          <div className="soundboard-upload-volume">
            <div className="soundboard-upload-volume-label">Clip volume</div>
            <input id="sound-clip-volume" type="range" min="0" max="200" value="100" readOnly />
            <div id="sound-clip-volume-value" className="soundboard-volume-value">
              100%
            </div>
          </div>
          <div className="soundboard-icons hidden" id="soundboard-icons-section">
            <div className="soundboard-icons-label">Pick an icon</div>
            <div id="soundboard-icon-grid" className="soundboard-icon-grid" />
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
            <button id="lobby-toggle-mic" type="button" className={`lobby-control-btn${lobbyMicMuted ? ' active' : ''}`} onClick={() => setLobbyMicMuted((prev) => !prev)}>
              <span className="mic-icon">🎤</span> {lobbyMicMuted ? 'Unmute Mic' : 'Mute Mic'}
            </button>
            <button id="lobby-toggle-camera" type="button" className={`lobby-control-btn${lobbyCameraMuted ? ' active' : ''}`} onClick={() => setLobbyCameraMuted((prev) => !prev)}>
              <span className="camera-icon">📹</span> {lobbyCameraMuted ? 'Turn On Camera' : 'Turn Off Camera'}
            </button>
            <button id="close-camera-lobby" type="button" onClick={() => setCameraLobbyOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div id="camera-lobby-grid" className="camera-lobby-grid" data-count={Math.max(activeParticipants.length, 1)}>
          {activeParticipants.length > 0 ? (
            activeParticipants.map((participant) => (
              <div key={`lobby-${participant.identity}`} className="camera-lobby-tile">
                <div className="avatar-placeholder">{getInitials(participant.name ?? participant.identity)}</div>
                <div className="name-label">{participant.name ?? participant.identity}</div>
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
            <button
              id="close-bug-report"
              type="button"
              onClick={() => {
                setBugReportOpen(false);
                setBugStatus('');
              }}
            >
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
              <button id="bug-report-screenshot-btn" type="button" className="bug-report-screenshot-btn" disabled>
                Attach Screenshot
              </button>
              <input type="file" id="bug-report-file" className="hidden" accept="image/*" />
              <span id="bug-report-file-name" className="bug-report-file-name"></span>
            </div>
            <div id="bug-report-screenshot-preview" className="bug-report-screenshot-preview hidden"></div>
            <div id="bug-report-stats" className="bug-stats-preview">
              Runtime summary: room {ROOM_DISPLAY_NAMES[activeRoom]}, users {activeParticipants.length}, chat messages {chatMessages.length}.
            </div>
            <div className="bug-report-actions">
              <button id="submit-bug-report" type="button" onClick={submitBugReport}>
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
            <span id="jam-spotify-status" className="jam-spotify-status">
              Not Connected
            </span>
            <button id="jam-connect-spotify" type="button" className="jam-connect-btn" disabled>
              Connect Spotify
            </button>
          </div>
          <div id="jam-host-controls" className="jam-host-controls">
            <button id="jam-start-btn" type="button" className="jam-start-btn" disabled>
              Start Jam
            </button>
            <button id="jam-stop-btn" type="button" className="jam-stop-btn" style={{ display: 'none' }}>
              End Jam
            </button>
            <button id="jam-skip-btn" type="button" className="jam-skip-btn" disabled>
              Skip
            </button>
          </div>
          <div id="jam-now-playing" className="jam-now-playing">
            <div className="jam-now-playing-empty">No music playing</div>
          </div>
          <div id="jam-actions-section" className="jam-actions">
            <button id="jam-join-btn" type="button" className="jam-join-btn" disabled>
              Join Jam
            </button>
            <button id="jam-leave-btn" type="button" className="jam-leave-btn" style={{ display: 'none' }}>
              Leave Jam
            </button>
            <span id="jam-listener-count" className="jam-listener-count">
              0 listening
            </span>
          </div>
          <div className="jam-volume-section">
            <label className="jam-volume-label">Jam Volume</label>
            <div className="jam-volume-row">
              <input id="jam-volume-slider" type="range" min="0" max="100" value={jamVolume} onChange={(event) => setJamVolume(Number(event.target.value))} />
              <span id="jam-volume-value" className="jam-volume-value">
                {jamVolume}%
              </span>
            </div>
          </div>
          <div className="jam-search-queue-row">
            <div id="jam-search-section" className="jam-search-section">
              <input id="jam-search-input" type="text" className="jam-search-input" placeholder="Search for a song..." disabled />
              <div id="jam-results" className="jam-results"></div>
            </div>
            <div id="jam-queue-section" className="jam-queue-section">
              <div className="jam-queue-title">Queue</div>
              <div id="jam-queue-list" className="jam-queue-list">
                <div className="jam-queue-empty">Queue is empty</div>
              </div>
            </div>
          </div>
          <div id="jam-status" className="jam-status">
            Jam wiring in progress in React viewer.
          </div>
        </div>
      </div>

      <div id="admin-dash-panel" className="admin-only hidden admin-dash-panel">
        <div className="admin-dash-header">
          <h3>Admin Dashboard</h3>
          <button type="button" className="admin-dash-close" disabled>
            &times;
          </button>
        </div>
        <div className="admin-dash-tabs">
          <button type="button" className="adm-tab active">
            Live
          </button>
          <button type="button" className="adm-tab">
            History
          </button>
          <button type="button" className="adm-tab">
            Metrics
          </button>
          <button type="button" className="adm-tab">
            Bugs
          </button>
        </div>
        <div id="admin-dash-live" className="admin-dash-content">
          <div className="adm-empty">Admin parity in progress.</div>
        </div>
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
