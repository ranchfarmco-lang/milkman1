// The bridge between SUGAR Browser's own chrome (a web page) and the main
// process (which owns the tabs and SUGAR). Everything privileged goes through
// here, and nothing else is exposed: the chrome cannot reach Node, the
// filesystem or Electron itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("browser", {
  /** The current tabs, and which one is showing. */
  state: () => ipcRenderer.invoke("browser:state"),

  /** Every change to the tabs or the page, pushed from the main process. */
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("browser:state", handler);
    return () => ipcRenderer.removeListener("browser:state", handler);
  },

  /** Every step SUGAR reports while it works (§8: visible progress). */
  onSugar: (listener) => {
    const handler = (_event, event) => listener(event);
    ipcRenderer.on("browser:sugar-event", handler);
    return () => ipcRenderer.removeListener("browser:sugar-event", handler);
  },

  newTab: (url) => ipcRenderer.invoke("browser:new-tab", url ?? null),
  closeTab: (id) => ipcRenderer.invoke("browser:close-tab", id),
  activateTab: (id) => ipcRenderer.invoke("browser:activate-tab", id),

  go: (url) => ipcRenderer.invoke("browser:go", url),
  back: () => ipcRenderer.invoke("browser:back"),
  forward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  stop: () => ipcRenderer.invoke("browser:stop"),
  home: () => ipcRenderer.invoke("browser:home"),

  /** The Edit actions: cut, copy, paste, select all, undo, redo on the page. */
  edit: (action) => ipcRenderer.invoke("browser:edit", action),
  copyLink: () => ipcRenderer.invoke("browser:copy-link"),
  savePage: () => ipcRenderer.invoke("browser:save-page"),

  find: (text, options) => ipcRenderer.invoke("browser:find", { text, ...(options ?? {}) }),
  findStop: () => ipcRenderer.invoke("browser:find-stop"),
  zoom: (delta) => ipcRenderer.invoke("browser:zoom", delta),
  devtools: () => ipcRenderer.invoke("browser:devtools"),
  openExternal: (url) => ipcRenderer.invoke("browser:open-external", url),

  newWindow: () => ipcRenderer.invoke("browser:new-window"),
  newPrivateWindow: () => ipcRenderer.invoke("browser:new-private-window"),
  clearBrowsingData: () => ipcRenderer.invoke("browser:clear-data"),

  settings: () => ipcRenderer.invoke("browser:settings"),
  saveSettings: (patch) => ipcRenderer.invoke("browser:settings-save", patch),
  online: () => ipcRenderer.invoke("browser:online"),

  bookmarks: () => ipcRenderer.invoke("browser:bookmarks"),
  history: (query) => ipcRenderer.invoke("browser:history", query),

  updatesLocal: () => ipcRenderer.invoke("browser:updates-local"),
  updateCheck: () => ipcRenderer.invoke("browser:update-check"),

  /** Ask SUGAR to do something, in words. */
  sugar: (text) => ipcRenderer.invoke("browser:sugar", text),

  /** What local AI servers answered, if any. */
  sugarProviders: () => ipcRenderer.invoke("browser:sugar-providers"),

  /** Resize the strip, for the SUGAR panel, the find bar and downloads. */
  setChromeHeight: (height) => ipcRenderer.invoke("browser:set-chrome-height", height),
  openDownloadsFolder: () => ipcRenderer.invoke("browser:open-downloads"),
});
