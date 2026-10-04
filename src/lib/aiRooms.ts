import { createRoomConsumers } from '@tik-choco/mistai'
import { createMistaiNode } from './mistaiNode'

// The host adapter shares the world's real node and room event dispatcher.
export const aiRooms = createRoomConsumers(createMistaiNode, {
  nodeIdStorageKey: 'tc-vrsns2:mistai-node-id',
})
