// English — the canonical key catalog for tc-vrsns2. Every other locale is a
// Partial of these keys (see ../index.ts): any key a locale omits falls back
// to the English string here, so adding a key here can never break a build.
// Keys are flat dotted paths grouped by UI area. `{param}` marks an
// interpolation slot filled by t(key, { param }).

export const en = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'A peer-to-peer metaverse — no servers, just people.',

  // Join screen
  'join.heading': 'Enter the world',
  'join.roomLabel': 'Room',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Letters, digits, hyphen and underscore. Up to 64 characters.',
  'join.nameLabel': 'Display name',
  'join.namePlaceholder': 'Your name',
  'join.colorLabel': 'Accent color',
  'join.languageLabel': 'Language',
  'join.join': 'Join',
  'join.connecting': 'Connecting…',
  'join.random': 'Random room',
  'join.recent': 'Recent',
  'join.roomInvalid': 'Room name may use letters, digits, hyphen and underscore only (max 64).',
  'join.nameRequired': 'Please enter a display name.',

  // HUD / heads-up display
  'hud.peers': '{count} online',
  'hud.you': 'You',
  'hud.voiceOn': 'Voice on',
  'hud.voiceMuted': 'Voice muted',
  'hud.voiceError': 'Mic error',
  'hud.voiceRequesting': 'Requesting mic…',
  'hud.hintMove': 'Move',
  'hud.hintChat': 'Chat',
  'hud.hintMic': 'Mic',
  'hud.hintView': 'View',
  'hud.hintJump': 'Jump',
  'hud.hintSprint': 'Sprint',
  'hud.hintMenu': 'Menu',

  // Main menu
  'menu.title': 'Menu',
  'menu.avatar': 'Avatar',
  'menu.world': 'World',
  'menu.objects': 'Objects',
  'menu.room': 'Room',
  'menu.settings': 'Settings',
  'menu.leave': 'Leave',
  'menu.close': 'Close',

  // Avatar panel
  'avatar.title': 'Avatar',
  'avatar.subtitle': 'Choose or upload a VRM avatar.',
  'avatar.upload': 'Upload VRM',
  'avatar.uploading': 'Loading…',
  'avatar.default': 'Default',
  'avatar.equip': 'Equip',
  'avatar.equipped': 'Equipped',
  'avatar.remove': 'Remove',
  'avatar.selectPrompt': 'Select an avatar to preview.',
  'avatar.name': 'Name',
  'avatar.author': 'Author',
  'avatar.license': 'License',
  'avatar.invalid': 'That file is not a valid VRM.',
  'avatar.saved': 'Saved to your avatars.',
  'avatar.townTitle': 'Characters from tc-town',
  'avatar.townEquip': 'Equip',
  'avatar.townNoModel': 'No VRM avatar available for this character.',

  // World (environment) panel
  'world.title': 'World',
  'world.subtitle': 'Load a 3D environment for everyone in the room.',
  'world.upload': 'Upload world',
  'world.uploading': 'Loading world…',
  'world.apply': 'Apply for everyone',
  'world.applied': 'Applied',
  'world.reset': 'Reset to default',
  'world.default': 'Default grid',
  'world.selectPrompt': 'Select a world to preview.',
  'world.name': 'Name',
  'world.format': 'Format',
  'world.invalid': 'Unsupported world format. Use GLB, GLTF, PLY, SPLAT or KSPLAT.',
  'world.hint': 'GLB / GLTF meshes and Gaussian-splat scenes are supported.',

  // Objects panel
  'objects.title': 'Objects',
  'objects.subtitle': 'Place shared 3D props in the world.',
  'objects.upload': 'Upload model',
  'objects.uploading': 'Loading model…',
  'objects.place': 'Place in front of me',
  'objects.placed': 'Placed',
  'objects.remove': 'Remove',
  'objects.clear': 'Clear all',
  'objects.selectPrompt': 'Select a model to place.',
  'objects.count': '{count} placed',
  'objects.empty': 'No objects placed yet.',
  'objects.invalid': 'That file is not a valid GLTF/GLB model.',

  // Room panel
  'room.title': 'Room',
  'room.subtitle': 'Invite others or switch rooms.',
  'room.current': 'Current room',
  'room.inviteUrl': 'Invite link',
  'room.copy': 'Copy link',
  'room.copied': 'Copied!',
  'room.idLabel': 'Room name',
  'room.idPlaceholder': 'Type a room name',
  'room.enter': 'Enter',
  'room.create': 'Create',
  'room.random': 'Random',
  'room.switchHint': 'Switching rooms disconnects you from the current one.',

  // Settings panel
  'settings.title': 'Settings',
  'settings.displayName': 'Display name',
  'settings.color': 'Accent color',
  'settings.language': 'Language',
  'settings.quality': 'Graphics quality',
  'settings.qualityLow': 'Low',
  'settings.qualityMedium': 'Medium',
  'settings.qualityHigh': 'High',
  'settings.save': 'Save',
  'settings.saved': 'Saved',

  // Chat
  'chat.placeholder': 'Say something…',
  'chat.send': 'Send',
  'chat.open': 'Open chat',
  'chat.close': 'Close chat',

  // Common
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.ok': 'OK',
  'common.loading': 'Loading…',
  'common.error': 'Something went wrong.',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.retry': 'Retry',
} as const

export type TranslationKey = keyof typeof en
export type Dict = Partial<Record<TranslationKey, string>>

export default en
