import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '..')
const asset = (name: string): string => resolve(projectRoot, 'assets', name)

describe('desktop shell assets', () => {
  it('uses the original black-and-white SplitSquare mark', async () => {
    const svg = await readFile(asset('icon.svg'), 'utf8')
    expect(svg).toContain('<title>SplitSquare mark</title>')
    expect(svg).toContain('fill="#111111"')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).not.toContain('4D6BFE')
  })

  it('ships a transparent 1024px PNG and all Windows ICO frames', async () => {
    const png = await readFile(asset('icon.png'))
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(1024)
    expect(png[25]).toBe(6)

    const ico = await readFile(asset('icon.ico'))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBe(10)
    const dimensions = Array.from({ length: count }, (_value, index) => {
      const offset = 6 + index * 16
      const width = ico[offset] === 0 ? 256 : ico[offset]
      const height = ico[offset + 1] === 0 ? 256 : ico[offset + 1]
      return `${String(width)}x${String(height)}`
    })
    expect(dimensions).toEqual([
      '16x16', '20x20', '24x24', '32x32', '40x40',
      '48x48', '64x64', '96x96', '128x128', '256x256',
    ])
  })

  it('renders one integrated menu row and a separate navigation row', async () => {
    const html = await readFile(asset('shell.html'), 'utf8')
    expect(html).toContain('class="titlebar"')
    expect(html).toContain('SplitSquare Harness')
    expect(html.match(/data-menu=/g)).toHaveLength(5)
    expect(html).toContain('class="toolbar"')
    expect(html).toContain('data-command="toggle-sidebar"')
    expect(html).toContain('data-command="back"')
    expect(html).toContain('data-command="forward"')
  })

  it('keeps draggable and interactive title-bar regions separate', async () => {
    const css = await readFile(asset('shell.css'), 'utf8')
    expect(css).toContain('-webkit-app-region: drag')
    expect(css).toContain('-webkit-app-region: no-drag')

    const preload = await readFile(asset('shell-preload.cjs'), 'utf8')
    expect(preload).toContain("contextBridge.exposeInMainWorld('splitSquareShell'")
    expect(preload).not.toContain('exposeInMainWorld(\'ipcRenderer\'')
  })
})
