'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const COMMAND_CHANNEL = 'shell:command'
const STATE_CHANNEL = 'shell:state'

contextBridge.exposeInMainWorld('splitSquareShell', Object.freeze({
  command(command) {
    ipcRenderer.send(COMMAND_CHANNEL, command)
  },
  onState(listener) {
    if (typeof listener !== 'function') return () => {}
    const handler = (_event, state) => listener(state)
    ipcRenderer.on(STATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler)
  },
}))
