import { render } from 'preact'
import { App } from './app'
import './style.css'
import { writeAppManifest } from './lib/appManifest.js'
import { BUS_VERSION } from './lib/sharedBus.js'

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
