import { render } from 'preact'
import { App } from './app'
import './style.css'
import { writeAppManifest } from './lib/appManifest.js'

render(<App />, document.getElementById('app')!)
writeAppManifest({
  app: 'tc-vrsns2',
  publishes: [],
  consumes: [],
  reads: [
    'tc-storage-snapshot-v1',
    'tc-storage-did-identity-v1',
    'tc-chat-did-identity-v1',
    'tc-vrm-viewer-did-identity-v1',
  ],
})
