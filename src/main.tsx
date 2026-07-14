import { render } from 'preact'
import { App } from './app'
import './style.css'
import { writeAppManifest } from './lib/appManifest.js'
import { BUS_VERSION } from './lib/sharedBus.js'
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
  publishes: [],
  consumes: ['character-index'],
  reads: [
    'tc-storage-snapshot-v1',
    'tc-storage-did-identity-v1',
    'tc-chat-did-identity-v1',
    'tc-vrm-viewer-did-identity-v1',
  ],
})
