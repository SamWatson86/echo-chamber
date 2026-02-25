import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCodecBitrateHints,
  installSdpCodecHintParity,
  mungeSdpWithParityHints,
  mungeVideoBandwidth,
  upgradeH264ProfileLevel,
} from '@/features/media/sdpCodecHintParity';

const SAMPLE_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 profile-level-id=42e01f;packetization-mode=1',
  'a=rtpmap:97 VP8/90000',
  'a=fmtp:97 max-fs=12288',
  '',
].join('\r\n');

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__echoViewerNextSdpHintsInstalled;
  delete (globalThis as Record<string, unknown>).RTCPeerConnection;
});

describe('SDP/codec hint parity', () => {
  it('applies video bandwidth lines to video m-sections', () => {
    const munged = mungeVideoBandwidth(SAMPLE_SDP, 25000);
    expect(munged).toContain('b=AS:25000');
    expect(munged).toContain('b=TIAS:25000000');
  });

  it('adds x-google bitrate hints to codec fmtp lines when missing', () => {
    const munged = addCodecBitrateHints(SAMPLE_SDP, {
      startBitrateKbps: 9000,
      minBitrateKbps: 4000,
      maxBitrateKbps: 20000,
    });

    expect(munged).toContain('x-google-start-bitrate=9000');
    expect(munged).toContain('x-google-min-bitrate=4000');
    expect(munged).toContain('x-google-max-bitrate=20000');
  });

  it('upgrades local H264 profile+level but keeps remote profile unchanged', () => {
    const local = upgradeH264ProfileLevel(SAMPLE_SDP, 'local');
    const remote = upgradeH264ProfileLevel(SAMPLE_SDP, 'remote');

    expect(local).toContain('profile-level-id=640033');
    expect(remote).toContain('profile-level-id=42e033');
  });

  it('munges full SDP with parity hints in one pass', () => {
    const full = mungeSdpWithParityHints(SAMPLE_SDP, 'offer');
    expect(full).toContain('b=AS:25000');
    expect(full).toContain('x-google-start-bitrate=10000');
    expect(full).toContain('profile-level-id=640033');
  });

  it('installs RTCPeerConnection hooks once with guardrails', async () => {
    const createOffer = vi.fn(async () => ({ type: 'offer', sdp: SAMPLE_SDP }));
    const setLocalDescription = vi.fn(async (_desc?: RTCSessionDescriptionInit) => undefined);
    const setRemoteDescription = vi.fn(async (_desc?: RTCSessionDescriptionInit) => undefined);

    class MockPeerConnection {
      async createOffer() {
        return createOffer();
      }

      async setLocalDescription(desc?: RTCSessionDescriptionInit) {
        return setLocalDescription(desc);
      }

      async setRemoteDescription(desc: RTCSessionDescriptionInit) {
        return setRemoteDescription(desc);
      }
    }

    (globalThis as Record<string, unknown>).RTCPeerConnection = MockPeerConnection;

    installSdpCodecHintParity();
    installSdpCodecHintParity();

    const pc = new MockPeerConnection() as unknown as RTCPeerConnection;
    const offer = await pc.createOffer();
    await (pc as any).setLocalDescription({ type: 'offer', sdp: SAMPLE_SDP } as RTCSessionDescriptionInit);
    await (pc as any).setRemoteDescription({ type: 'answer', sdp: SAMPLE_SDP } as RTCSessionDescriptionInit);

    expect(offer.sdp).toContain('x-google-start-bitrate=10000');
    expect(setLocalDescription).toHaveBeenCalledTimes(1);
    expect(setRemoteDescription).toHaveBeenCalledTimes(1);
  });
});
