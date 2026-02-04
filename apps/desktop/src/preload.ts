import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("echoDesktop", {
  setOutputDevice: (deviceId: string) => ipcRenderer.invoke("audio-output:set", deviceId),
  outputSupported: () => ipcRenderer.invoke("audio-output:supported"),
  restart: () => ipcRenderer.invoke("app:restart"),
  getPrefs: () => ipcRenderer.invoke("desktop:prefs:get"),
  setPrefs: (prefs: { password?: string; avatar?: string }) => ipcRenderer.invoke("desktop:prefs:set", prefs)
});
