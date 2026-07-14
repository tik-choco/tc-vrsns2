// Deutsch (German). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const de: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'Ein Peer-to-Peer-Metaversum – keine Server, nur Menschen.',

  // Join screen
  'join.heading': 'Die Welt betreten',
  'join.roomLabel': 'Raum',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Buchstaben, Ziffern, Bindestrich und Unterstrich. Bis zu 64 Zeichen.',
  'join.nameLabel': 'Anzeigename',
  'join.namePlaceholder': 'Dein Name',
  'join.colorLabel': 'Akzentfarbe',
  'join.languageLabel': 'Sprache',
  'join.join': 'Beitreten',
  'join.connecting': 'Verbinden…',
  'join.random': 'Zufälliger Raum',
  'join.recent': 'Zuletzt',
  'join.roomInvalid': 'Der Raumname darf nur Buchstaben, Ziffern, Bindestrich und Unterstrich enthalten (max. 64).',
  'join.nameRequired': 'Bitte gib einen Anzeigenamen ein.',
  'join.makePublic': 'Als öffentlichen Raum beitreten',

  // Resume
  'resume.message': 'Dein letzter Raum „{roomId}“ wird wieder aufgenommen…',

  // HUD
  'hud.peers': '{count} online',
  'hud.you': 'Du',
  'hud.voiceOn': 'Ton an',
  'hud.voiceMuted': 'Stummgeschaltet',
  'hud.voiceError': 'Mikrofonfehler',
  'hud.voiceRequesting': 'Mikrofon anfragen…',
  'hud.hintMove': 'Bewegen',
  'hud.hintChat': 'Chat',
  'hud.hintMic': 'Mikro',
  'hud.hintView': 'Ansicht',
  'hud.hintJump': 'Springen',
  'hud.hintSprint': 'Rennen',
  'hud.hintMenu': 'Menü',

  // Main menu
  'menu.title': 'Menü',
  'menu.avatar': 'Avatar',
  'menu.world': 'Welt',
  'menu.objects': 'Objekte',
  'menu.room': 'Raum',
  'menu.settings': 'Einstellungen',
  'menu.leave': 'Verlassen',
  'menu.close': 'Schließen',

  // Avatar panel
  'avatar.title': 'Avatar',
  'avatar.subtitle': 'Wähle oder lade einen VRM-Avatar hoch.',
  'avatar.upload': 'VRM hochladen',
  'avatar.uploading': 'Wird geladen…',
  'avatar.default': 'Standard',
  'avatar.equip': 'Anlegen',
  'avatar.equipped': 'Angelegt',
  'avatar.remove': 'Entfernen',
  'avatar.selectPrompt': 'Wähle einen Avatar für die Vorschau.',
  'avatar.name': 'Name',
  'avatar.author': 'Ersteller',
  'avatar.license': 'Lizenz',
  'avatar.invalid': 'Diese Datei ist kein gültiges VRM.',
  'avatar.saved': 'In deinen Avataren gespeichert.',

  // World panel
  'world.title': 'Welt',
  'world.subtitle': 'Lade eine 3D-Umgebung für alle im Raum.',
  'world.upload': 'Welt hochladen',
  'world.uploading': 'Welt wird geladen…',
  'world.apply': 'Für alle übernehmen',
  'world.applied': 'Übernommen',
  'world.reset': 'Zurücksetzen',
  'world.default': 'Standardgitter',
  'world.selectPrompt': 'Wähle eine Welt für die Vorschau.',
  'world.name': 'Name',
  'world.format': 'Format',
  'world.invalid': 'Nicht unterstütztes Weltformat. Verwende GLB, GLTF, PLY, SPLAT oder KSPLAT.',
  'world.hint': 'GLB-/GLTF-Meshes und Gaussian-Splat-Szenen werden unterstützt.',

  // Objects panel
  'objects.title': 'Objekte',
  'objects.subtitle': 'Platziere geteilte 3D-Objekte in der Welt.',
  'objects.upload': 'Modell hochladen',
  'objects.uploading': 'Modell wird geladen…',
  'objects.place': 'Vor mir platzieren',
  'objects.placed': 'Platziert',
  'objects.remove': 'Entfernen',
  'objects.clear': 'Alle entfernen',
  'objects.selectPrompt': 'Wähle ein Modell zum Platzieren.',
  'objects.count': '{count} platziert',
  'objects.empty': 'Noch keine Objekte platziert.',
  'objects.invalid': 'Diese Datei ist kein gültiges GLTF-/GLB-Modell.',

  // Room panel
  'room.title': 'Raum',
  'room.subtitle': 'Lade andere ein oder wechsle den Raum.',
  'room.current': 'Aktueller Raum',
  'room.inviteUrl': 'Einladungslink',
  'room.copy': 'Link kopieren',
  'room.copied': 'Kopiert!',
  'room.idLabel': 'Raumname',
  'room.idPlaceholder': 'Raumnamen eingeben',
  'room.enter': 'Betreten',
  'room.create': 'Erstellen',
  'room.random': 'Zufällig',
  'room.switchHint': 'Beim Raumwechsel wirst du vom aktuellen Raum getrennt.',
  'room.visibility.label': 'Sichtbarkeit',
  'room.visibility.public': 'Öffentlich (für alle auffindbar)',
  'room.visibility.private': 'Privat (nur mit bekannter ID)',

  // Discover panel
  'discover.title': 'Öffentliche Räume',
  'discover.empty': 'Noch keine öffentlichen Räume gefunden.',
  'discover.join': 'Beitreten',
  'discover.peers': '{count} online',
  'discover.justNow': 'Gerade eben',
  'discover.secondsAgo': 'Vor {count} s',

  // Settings panel
  'settings.title': 'Einstellungen',
  'settings.displayName': 'Anzeigename',
  'settings.color': 'Akzentfarbe',
  'settings.language': 'Sprache',
  'settings.quality': 'Grafikqualität',
  'settings.qualityLow': 'Niedrig',
  'settings.qualityMedium': 'Mittel',
  'settings.qualityHigh': 'Hoch',
  'settings.save': 'Speichern',
  'settings.saved': 'Gespeichert',

  // Chat
  'chat.placeholder': 'Sag etwas…',
  'chat.send': 'Senden',
  'chat.open': 'Chat öffnen',
  'chat.close': 'Chat schließen',

  // Common
  'common.close': 'Schließen',
  'common.cancel': 'Abbrechen',
  'common.ok': 'OK',
  'common.loading': 'Wird geladen…',
  'common.error': 'Etwas ist schiefgelaufen.',
  'common.copy': 'Kopieren',
  'common.copied': 'Kopiert',
  'common.retry': 'Erneut versuchen',
}

export default de
