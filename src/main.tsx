import { render } from 'preact'
import { App } from './app'
import './style.css'
import { writeAppManifest } from './lib/appManifest.js'
import { BUS_VERSION } from './lib/sharedBus.js'
import { publishSpaceSnapshot } from './storage/catalog.js'
import { applyTheme, loadTheme } from './ui/theme.js'

// Applied synchronously before the first paint so there's no flash of the
// wrong theme while waiting for any component to mount and react to the
// stored preference — this is just to win the race against the initial
// render (see ui/theme.ts).
applyTheme(loadTheme())

render(<App />, document.getElementById('app')!)
writeAppManifest({
  app: 'tc-vrsns2',
  busVersion: BUS_VERSION,
  publishes: ['vrsns2-space-inbox'],
  consumes: ['character-index'],
  reads: [
    'tc-storage-did-identity-v1',
    'tc-chat-did-identity-v1',
    'tc-vrm-viewer-did-identity-v1',
  ],
})

// The space snapshot otherwise only refreshes on a catalog mutation, so a
// user whose catalog predates the topic would stay invisible to tc-storage
// until they next add or remove something. One boot-time publish closes that.
publishSpaceSnapshot()
