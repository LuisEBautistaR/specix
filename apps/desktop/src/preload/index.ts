/**
 * Runs sandboxed with context isolation: the page cannot reach ipcRenderer or
 * Node, only the named functions below. Arguments are validated again in main.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IpcChannels, type LangStatus, type UpdateState, type WorkspaceView } from "@shared/ipc";
import type { Prefs } from "@shared/prefs";
import type { SpecixApi } from "./api";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: SpecixApi = {
  lang: {
    status: () => ipcRenderer.invoke(IpcChannels.langStatus),
    analyze: (text, file) => ipcRenderer.invoke(IpcChannels.langAnalyze, text, file ?? null),
    docs: (text, file) => ipcRenderer.invoke(IpcChannels.langDocs, text, file ?? null),
    complete: (cursor) => ipcRenderer.invoke(IpcChannels.langComplete, cursor),
    hover: (cursor) => ipcRenderer.invoke(IpcChannels.langHover, cursor),
    definition: (cursor) => ipcRenderer.invoke(IpcChannels.langDefinition, cursor),
    path: (cursor) => ipcRenderer.invoke(IpcChannels.langPath, cursor),
    ping: () => ipcRenderer.invoke(IpcChannels.langPing),
    crashHost: () => ipcRenderer.invoke(IpcChannels.langCrashHost),
    onStatus: (listener) => subscribe<LangStatus>(IpcChannels.langStatusChanged, listener),
  },
  app: {
    info: () => ipcRenderer.invoke(IpcChannels.appInfo),
  },
  workspace: {
    get: () => ipcRenderer.invoke(IpcChannels.wsGet),
    openDialog: () => ipcRenderer.invoke(IpcChannels.wsOpenDialog),
    createDialog: (name) => ipcRenderer.invoke(IpcChannels.wsCreateDialog, name),
    read: (path) => ipcRenderer.invoke(IpcChannels.wsRead, path),
    write: (path, text) => ipcRenderer.invoke(IpcChannels.wsWrite, path, text),
    createApi: (request) => ipcRenderer.invoke(IpcChannels.wsCreateApi, request),
    createVersion: (request) => ipcRenderer.invoke(IpcChannels.wsCreateVersion, request),
    publish: (request) => ipcRenderer.invoke(IpcChannels.wsPublish, request),
    setDefault: (request) => ipcRenderer.invoke(IpcChannels.wsSetDefault, request),
    updateSettings: (change) => ipcRenderer.invoke(IpcChannels.wsSettings, change),
    onChanged: (listener) => subscribe<WorkspaceView | null>(IpcChannels.wsChanged, listener),
  },
  docs: {
    export: (request) => ipcRenderer.invoke(IpcChannels.docsExport, request),
    openExport: () => ipcRenderer.invoke(IpcChannels.docsOpenExport),
  },
  prefs: {
    get: () => ipcRenderer.invoke(IpcChannels.prefsGet),
    set: (prefs) => ipcRenderer.invoke(IpcChannels.prefsSet, prefs),
    revealProfile: () => ipcRenderer.invoke(IpcChannels.prefsRevealProfile),
    onChanged: (listener) => subscribe<Prefs>(IpcChannels.prefsChanged, listener),
  },
  updates: {
    get: () => ipcRenderer.invoke(IpcChannels.updatesGet),
    check: () => ipcRenderer.invoke(IpcChannels.updatesCheck),
    install: () => ipcRenderer.invoke(IpcChannels.updatesInstall),
    onChanged: (listener) => subscribe<UpdateState>(IpcChannels.updatesChanged, listener),
  },
};

contextBridge.exposeInMainWorld("specix", api);
