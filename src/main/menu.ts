import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * A proper application menu so Artemis behaves like a real desktop app: an Artemis
 * app menu (About / Hide / Quit), a File menu (New Chat / Quit), and the standard
 * Edit / View / Window roles so copy-paste, reload, zoom, devtools, and fullscreen
 * all work. Note: the *bold app-menu name* and the Dock/permissions name come from
 * the app bundle — in development that's "Electron"; a packaged build shows "Artemis".
 */
export function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const newChat = (): void => {
    BrowserWindow.getFocusedWindow()?.webContents.send('menu:new-chat')
  }
  const openSettings = (): void => {
    BrowserWindow.getFocusedWindow()?.webContents.send('menu:settings')
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: 'Artemis',
            submenu: [
              { role: 'about', label: 'About Artemis' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
              { type: 'separator' },
              { role: 'hide', label: 'Hide Artemis' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit Artemis' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+Shift+N', click: newChat },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
          : ([
              { label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings },
              { type: 'separator' }
            ] as MenuItemConstructorOptions[])),
        { role: 'quit', label: isMac ? 'Quit Artemis' : 'Quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as MenuItemConstructorOptions[]))
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
