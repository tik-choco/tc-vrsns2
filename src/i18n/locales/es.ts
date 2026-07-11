// Español (Spanish). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const es: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'Un metaverso entre pares: sin servidores, solo personas.',

  // Join screen
  'join.heading': 'Entra al mundo',
  'join.roomLabel': 'Sala',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Letras, números, guion y guion bajo. Hasta 64 caracteres.',
  'join.nameLabel': 'Nombre visible',
  'join.namePlaceholder': 'Tu nombre',
  'join.colorLabel': 'Color de acento',
  'join.languageLabel': 'Idioma',
  'join.join': 'Entrar',
  'join.connecting': 'Conectando…',
  'join.random': 'Sala aleatoria',
  'join.recent': 'Recientes',
  'join.roomInvalid': 'El nombre de la sala solo admite letras, números, guion y guion bajo (máx. 64).',
  'join.nameRequired': 'Escribe un nombre visible.',

  // HUD
  'hud.peers': '{count} en línea',
  'hud.you': 'Tú',
  'hud.voiceOn': 'Voz activada',
  'hud.voiceMuted': 'Voz silenciada',
  'hud.voiceError': 'Error de micrófono',
  'hud.voiceRequesting': 'Pidiendo micrófono…',
  'hud.hintMove': 'Moverse',
  'hud.hintChat': 'Chat',
  'hud.hintMic': 'Micrófono',
  'hud.hintView': 'Vista',
  'hud.hintJump': 'Saltar',
  'hud.hintSprint': 'Correr',
  'hud.hintMenu': 'Menú',

  // Main menu
  'menu.title': 'Menú',
  'menu.avatar': 'Avatar',
  'menu.world': 'Mundo',
  'menu.objects': 'Objetos',
  'menu.room': 'Sala',
  'menu.settings': 'Ajustes',
  'menu.leave': 'Salir',
  'menu.close': 'Cerrar',

  // Avatar panel
  'avatar.title': 'Avatar',
  'avatar.subtitle': 'Elige o sube un avatar VRM.',
  'avatar.upload': 'Subir VRM',
  'avatar.uploading': 'Cargando…',
  'avatar.default': 'Predeterminado',
  'avatar.equip': 'Equipar',
  'avatar.equipped': 'Equipado',
  'avatar.remove': 'Quitar',
  'avatar.selectPrompt': 'Selecciona un avatar para verlo.',
  'avatar.name': 'Nombre',
  'avatar.author': 'Autor',
  'avatar.license': 'Licencia',
  'avatar.invalid': 'Ese archivo no es un VRM válido.',
  'avatar.saved': 'Guardado en tus avatares.',

  // World panel
  'world.title': 'Mundo',
  'world.subtitle': 'Carga un entorno 3D para todos los de la sala.',
  'world.upload': 'Subir mundo',
  'world.uploading': 'Cargando mundo…',
  'world.apply': 'Aplicar a todos',
  'world.applied': 'Aplicado',
  'world.reset': 'Restablecer',
  'world.default': 'Cuadrícula predeterminada',
  'world.selectPrompt': 'Selecciona un mundo para verlo.',
  'world.name': 'Nombre',
  'world.format': 'Formato',
  'world.invalid': 'Formato de mundo no compatible. Usa GLB, GLTF, PLY, SPLAT o KSPLAT.',
  'world.hint': 'Se admiten mallas GLB / GLTF y escenas Gaussian-splat.',

  // Objects panel
  'objects.title': 'Objetos',
  'objects.subtitle': 'Coloca objetos 3D compartidos en el mundo.',
  'objects.upload': 'Subir modelo',
  'objects.uploading': 'Cargando modelo…',
  'objects.place': 'Colocar frente a mí',
  'objects.placed': 'Colocado',
  'objects.remove': 'Quitar',
  'objects.clear': 'Quitar todo',
  'objects.selectPrompt': 'Selecciona un modelo para colocarlo.',
  'objects.count': '{count} colocados',
  'objects.empty': 'Aún no hay objetos colocados.',
  'objects.invalid': 'Ese archivo no es un modelo GLTF / GLB válido.',

  // Room panel
  'room.title': 'Sala',
  'room.subtitle': 'Invita a otros o cambia de sala.',
  'room.current': 'Sala actual',
  'room.inviteUrl': 'Enlace de invitación',
  'room.copy': 'Copiar enlace',
  'room.copied': '¡Copiado!',
  'room.idLabel': 'Nombre de la sala',
  'room.idPlaceholder': 'Escribe un nombre de sala',
  'room.enter': 'Entrar',
  'room.create': 'Crear',
  'room.random': 'Aleatoria',
  'room.switchHint': 'Cambiar de sala te desconecta de la actual.',

  // Settings panel
  'settings.title': 'Ajustes',
  'settings.displayName': 'Nombre visible',
  'settings.color': 'Color de acento',
  'settings.language': 'Idioma',
  'settings.quality': 'Calidad gráfica',
  'settings.qualityLow': 'Baja',
  'settings.qualityMedium': 'Media',
  'settings.qualityHigh': 'Alta',
  'settings.save': 'Guardar',
  'settings.saved': 'Guardado',

  // Chat
  'chat.placeholder': 'Di algo…',
  'chat.send': 'Enviar',
  'chat.open': 'Abrir chat',
  'chat.close': 'Cerrar chat',

  // Common
  'common.close': 'Cerrar',
  'common.cancel': 'Cancelar',
  'common.ok': 'Aceptar',
  'common.loading': 'Cargando…',
  'common.error': 'Algo salió mal.',
  'common.copy': 'Copiar',
  'common.copied': 'Copiado',
  'common.retry': 'Reintentar',
}

export default es
