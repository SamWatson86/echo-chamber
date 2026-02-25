import { describe, expect, it } from 'vitest';
import { useViewerPrefsStore } from '@/stores/viewerPrefsStore';

describe('useViewerPrefsStore', () => {
  it('updates fields', () => {
    useViewerPrefsStore.getState().setField('name', 'Spencer');
    expect(useViewerPrefsStore.getState().name).toBe('Spencer');
  });

  it('resets defaults', () => {
    useViewerPrefsStore.getState().setField('room', 'custom-room');
    useViewerPrefsStore.getState().reset();
    expect(useViewerPrefsStore.getState().room).toBe('main');
  });
});
