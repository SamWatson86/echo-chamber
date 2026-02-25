import { create } from 'zustand';

type ViewerPrefs = {
  controlUrl: string;
  sfuUrl: string;
  room: string;
  name: string;
  identity: string;
  adminPassword: string;
  setField: <K extends keyof Omit<ViewerPrefs, 'setField' | 'reset'>>(key: K, value: ViewerPrefs[K]) => void;
  reset: () => void;
};

const defaults = {
  controlUrl: 'https://127.0.0.1:9443',
  sfuUrl: 'ws://127.0.0.1:7880',
  room: 'main',
  name: 'Viewer',
  identity: '',
  adminPassword: '',
};

export const useViewerPrefsStore = create<ViewerPrefs>((set) => ({
  ...defaults,
  setField: (key, value) => set(() => ({ [key]: value } as Partial<ViewerPrefs>)),
  reset: () => set(defaults),
}));
