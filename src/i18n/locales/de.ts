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
  'npc.approach': 'Annäherungsradius',
  'npc.approachOff': 'Aus',
  'npc.approachValue': '{n} m',

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
  'world.transferLabel': 'Diese Welt als Datei speichern',
  'world.transferHint': 'Exportiere die Umgebung und die Objekte dieses Raums als Datei, die du später wiederverwenden oder mit jemandem teilen kannst.',
  'world.exportButton': 'Als Datei exportieren',
  'world.importButton': 'Aus Datei importieren',
  'world.importParseError': 'Diese Datei ist kein Weltexport, den diese App lesen kann.',
  'world.importSummaryTitle': 'Datei "{fileName}" importieren?',
  'world.importObjectCount': '{count} Objekt(e) in dieser Datei.',
  'world.importHasEnvironment': 'Diese Datei legt außerdem die Umgebung des Raums fest.',
  'world.importUnavailable': '{count} von {total} Assets in dieser Datei sind noch nicht auf diesem Gerät. Bis dahin werden sie leer angezeigt, genau wie alles andere, das fehlt.',
  'world.importAllAvailable': 'Alle Assets, die diese Datei benötigt, sind bereits auf diesem Gerät.',
  'world.importConfirm': 'Importieren',
  'world.importing': 'Wird importiert…',
  'world.skyLabel': 'Himmel',
  'world.skySet': 'Himmel festlegen',
  'world.skyRemove': 'Himmel entfernen',
  'world.skyNone': 'Keiner',
  'world.skyTooLarge': 'Dieses Bild ist zu groß. Das Limit liegt bei {size} MB.',
  'world.skyInvalid': 'Nicht unterstütztes Himmelsbild. Verwende JPEG, PNG oder WebP.',

  // Objects panel
  'objects.title': 'Objekte',
  'objects.subtitle': 'Platziere geteilte Objekte, Bilder, Videos und Töne in der Welt.',
  'objects.upload': 'Datei hochladen',
  'objects.uploading': 'Datei wird geladen…',
  'objects.place': 'Vor mir platzieren',
  'objects.placeBox': 'Box platzieren',
  'objects.boxName': 'Box',
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
  'objects.size': 'Größe',
  'objects.placedBy': 'platziert von {name}',
  'objects.orphans': '{count} stammen von Leuten, die gegangen sind. Sie bleiben, bis du den Raum verlässt, und niemand kann sie bearbeiten.',

  // Numerische Position/Drehung — für jedes platzierte Objekt, eingestellt
  // über die Bearbeitungsleiste (EditToolbar.tsx); die exakte Alternative
  // zum Ziehen der Verschieben-/Drehen-Gizmos.
  'objects.transform': 'Position & Drehung',
  'objects.posX': 'X',
  'objects.posY': 'Y',
  'objects.posZ': 'Z',
  'objects.rotationDeg': 'Winkel',

  // Lautstärke / Hörweite / Volllautstärke-Radius / Klangversatz — nur bei
  // Audio- und Video-Objekten, eingestellt über die Bearbeitungsleiste
  // (EditToolbar.tsx)
  'objects.volume': 'Lautstärke',
  'objects.volumeValue': '{n}%',
  'objects.range': 'Hörweite',
  'objects.rangeValue': '{n} m',
  'objects.rangeExact': 'Hörweite (m)',
  'objects.falloffStart': 'Volllautstärke-Radius (m)',

  'objects.falloffStartShort': 'Volle Lautst.',
  'objects.audioOffset': 'Klangversatz',
  'objects.audioOffsetX': 'Klangversatz X (m)',
  'objects.audioOffsetY': 'Klangversatz Y (m)',
  'objects.audioOffsetZ': 'Klangversatz Z (m)',

  // Box-Erscheinungsbild — nur bei Objekten vom Typ „Box“, eingestellt über
  // die Bearbeitungsleiste (EditToolbar.tsx)
  'objects.box.badge': 'Box',
  'objects.box.width': 'Breite',
  'objects.box.height': 'Höhe',
  'objects.box.depth': 'Tiefe',
  'objects.box.color': 'Farbe',
  'objects.box.uploadTexture': 'Textur hochladen',
  'objects.box.removeTexture': 'Textur entfernen',
  'objects.box.tile': 'Kachelgröße',

  // Drop-Import-Overlay — eine Datei irgendwo in der App fallenlassen
  'dropImport.title': 'Das zu deiner Welt hinzufügen?',
  'dropImport.descAvatar': 'Das wird als dein Avatar getragen.',
  'dropImport.descModel': 'Das wird als 3D-Modell in der Welt platziert.',
  'dropImport.descImage': 'Das wird als Bild in der Welt platziert.',
  'dropImport.descVideo': 'Das wird als Videobildschirm in der Welt platziert.',
  'dropImport.descAudio': 'Das wird als Klang in der Welt platziert.',
  'dropImport.descWorld': 'Das wird zur Umgebung, die alle im Raum sehen.',
  'dropImport.descManifest': 'Das fügt ihre Objekte (und die Umgebung, falls vorhanden) zum Raum hinzu.',
  'dropImport.addToWorld': 'Zur Welt hinzufügen',
  'dropImport.setAsWorldEnvironment': 'Oder stattdessen als Weltumgebung festlegen',
  'dropImport.saveOnly': 'Nur im Inventar speichern',
  'dropImport.lockedHint': 'Nicht verfügbar, solange diese Welt gesperrt ist.',
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
