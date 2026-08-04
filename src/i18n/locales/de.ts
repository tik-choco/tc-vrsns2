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
  'join.errorRenderer': 'Dieses Gerät kann kein 3D anzeigen – WebGL ist nicht verfügbar oder wird blockiert.',
  'join.errorTimeout': 'Die Wiederverbindung hat zu lange gedauert. Bitte versuche es erneut.',

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
  'hud.hintEdit': 'Bearbeiten',
  'hud.hintJump': 'Springen',
  'hud.hintSprint': 'Rennen',
  'hud.hintCrouch': 'Ducken',
  'hud.hintMenu': 'Menü',
  'hud.locked': 'Welt gesperrt',
  'hud.openEditing': 'Alle dürfen bearbeiten',

  // Main menu
  'menu.title': 'Menü',
  'menu.avatar': 'Avatar',
  'menu.world': 'Welt',
  'menu.objects': 'Objekte',
  'panel.characters': 'Charaktere',
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
  // R6: Herkunftshinweis für einen Avatar, den du nicht selbst hochgeladen
  // hast (ein tc-town-Charakter oder der Upload einer anderen Person) —
  // damit er nie wie dein eigener wirkt.
  'avatar.foreignSource': 'Charakter von {name}',
  'avatar.foreignUnknown': 'jemand anderem',

  // Characters panel (R5: einen tc-town-Charakter als NPC in der Welt platzieren)
  'characters.title': 'Charaktere',
  'characters.empty': 'Noch keine Charaktere.',
  'characters.hint': 'Charaktere werden in tc-town erstellt. Sobald du dort einen anlegst, erscheint er hier.',
  'characters.place': 'In der Welt platzieren',
  'characters.noVrm': 'Für diesen Charakter ist kein VRM-Avatar verfügbar.',
  'characters.fromTown': 'Aus tc-town',

  // NPC (ein platzierter Charakter, der im Chat antwortet)
  'npc.badge': 'NPC',
  'npc.radius': 'Hörradius',
  'npc.radiusValue': '{n} m',
  'npc.voice': 'Stimme',
  'npc.voiceDefault': 'Standard (AI-Einstellungen)',
  'npc.voiceHelp': 'Wird die Auswahl geleert, gilt die Standardstimme aus den AI-Einstellungen, nicht die ursprüngliche tc-town-Stimme dieser Figur.',

  // AI panel
  'settings.ai.npcPreset': 'NPC-Antworten',
  'settings.ai.npcPresetHelp': 'Antwortet in der Rolle des Charakters, wenn jemand in der Nähe eines von dir platzierten Charakters spricht.',

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
  'world.autosaveHint': 'Dieser Raum wird automatisch auf diesem Gerät gespeichert und ist bei deiner Rückkehr wieder da.',
  'world.policyLabel': 'Wer diese Welt bearbeiten darf',
  'world.policyOwner': 'Nur wer platziert hat',
  'world.policyEveryone': 'Alle',
  'world.policyLocked': 'Gesperrt',
  'world.policyOwnerHint': 'Alle dürfen etwas hinzufügen, aber nur wer etwas platziert hat, darf es bewegen oder löschen.',
  'world.policyEveryoneHint': 'Alle im Raum dürfen Platziertes bewegen, skalieren oder löschen.',
  'world.policyLockedHint': 'Niemand darf die Umgebung ändern oder Platziertes anfassen.',
  'world.lockedNotice': 'Diese Welt ist gesperrt. Ändere die Einstellung oben, um sie zu bearbeiten.',

  // Objects panel
  'objects.title': 'Objekte',
  'objects.subtitle': 'Platziere geteilte Objekte, Bilder, Videos und Töne in der Welt.',
  'objects.upload': 'Datei hochladen',
  'objects.uploading': 'Datei wird geladen…',
  'objects.place': 'Vor mir platzieren',
  'objects.placed': 'Platziert',
  'objects.remove': 'Entfernen',
  'objects.clear': 'Alle entfernen',
  'objects.selectPrompt': 'Wähle etwas zum Platzieren.',
  'objects.count': '{count} platziert',
  'objects.empty': 'Noch keine Objekte platziert.',
  'objects.hint': 'GLB-/GLTF-Modelle, Bilder, Video und Audio werden unterstützt. Video und Audio klingen positionsabhängig – der Ton wird mit der Entfernung leiser.',
  'objects.invalid': 'Diese Datei ließ sich nicht als Modell, Bild, Video oder Audio lesen.',
  'objects.tooLarge': 'Diese Datei ist zu groß. Das Limit liegt bei {size} MB.',
  'objects.edit': 'Platzierte bearbeiten',
  'objects.editing': 'Platzierte Objekte bearbeiten',
  'objects.editHint': 'Klicke etwas an, das du platziert hast. Rechte Taste halten, um dich umzusehen.',
  'objects.editDone': 'Fertig',
  'objects.deleteOne': 'Löschen',
  'objects.move': 'Bewegen',
  'objects.rotate': 'Drehen',
  'objects.scale': 'Skalieren',
  'objects.placedBy': 'platziert von {name}',
  'objects.orphans': '{count} stammen von Leuten, die gegangen sind. Sie bleiben, bis du den Raum verlässt, und niemand kann sie bearbeiten.',

  // Drop-Import-Overlay — eine Datei irgendwo in der App fallenlassen
  'dropImport.title': 'Das zu deiner Welt hinzufügen?',
  'dropImport.descAvatar': 'Das wird als dein Avatar getragen.',
  'dropImport.descModel': 'Das wird als 3D-Modell in der Welt platziert.',
  'dropImport.descImage': 'Das wird als Bild in der Welt platziert.',
  'dropImport.descVideo': 'Das wird als Videobildschirm in der Welt platziert.',
  'dropImport.descAudio': 'Das wird als Klang in der Welt platziert.',
  'dropImport.descWorld': 'Das wird zur Umgebung, die alle im Raum sehen.',
  'dropImport.addToWorld': 'Zur Welt hinzufügen',
  'dropImport.setAsWorldEnvironment': 'Oder stattdessen als Weltumgebung festlegen',
  'dropImport.saveOnly': 'Nur im Inventar speichern',
  'dropImport.unsupportedTitle': 'Diese Datei kann nicht hinzugefügt werden',
  'dropImport.unsupportedBody': '„{fileName}“ ist keine Avatar-, Welt- oder Objektdatei, die diese App verwenden kann.',

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
