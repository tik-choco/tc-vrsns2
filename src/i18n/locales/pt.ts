// Português (Brazilian Portuguese). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const pt: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'Um metaverso ponto a ponto: sem servidores, só pessoas.',

  // Join screen
  'join.heading': 'Entrar no mundo',
  'join.roomLabel': 'Sala',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Letras, números, hífen e sublinhado. Até 64 caracteres.',
  'join.nameLabel': 'Nome de exibição',
  'join.namePlaceholder': 'Seu nome',
  'join.colorLabel': 'Cor de destaque',
  'join.languageLabel': 'Idioma',
  'join.join': 'Entrar',
  'join.connecting': 'Conectando…',
  'join.random': 'Sala aleatória',
  'join.recent': 'Recentes',
  'join.roomInvalid': 'O nome da sala aceita apenas letras, números, hífen e sublinhado (máx. 64).',
  'join.nameRequired': 'Digite um nome de exibição.',
  'join.makePublic': 'Entrar como sala pública',

  // Resume
  'resume.message': 'Retomando sua última sala "{roomId}"…',

  // HUD
  'hud.peers': '{count} online',
  'hud.you': 'Você',
  'hud.voiceOn': 'Voz ativada',
  'hud.voiceMuted': 'Voz silenciada',
  'hud.voiceError': 'Erro no microfone',
  'hud.voiceRequesting': 'Solicitando microfone…',
  'hud.hintMove': 'Mover',
  'hud.hintChat': 'Chat',
  'hud.hintMic': 'Microfone',
  'hud.hintView': 'Câmera',
  'hud.hintJump': 'Pular',
  'hud.hintSprint': 'Correr',
  'hud.hintMenu': 'Menu',

  // Main menu
  'menu.title': 'Menu',
  'menu.avatar': 'Avatar',
  'menu.world': 'Mundo',
  'menu.objects': 'Objetos',
  'menu.room': 'Sala',
  'menu.settings': 'Configurações',
  'menu.leave': 'Sair',
  'menu.close': 'Fechar',

  // Avatar panel
  'avatar.title': 'Avatar',
  'avatar.subtitle': 'Escolha ou envie um avatar VRM.',
  'avatar.upload': 'Enviar VRM',
  'avatar.uploading': 'Carregando…',
  'avatar.default': 'Padrão',
  'avatar.equip': 'Usar',
  'avatar.equipped': 'Em uso',
  'avatar.remove': 'Remover',
  'avatar.selectPrompt': 'Selecione um avatar para pré-visualizar.',
  'avatar.name': 'Nome',
  'avatar.author': 'Autor',
  'avatar.license': 'Licença',
  'avatar.invalid': 'Esse arquivo não é um VRM válido.',
  'avatar.saved': 'Salvo nos seus avatares.',

  // World panel
  'world.title': 'Mundo',
  'world.subtitle': 'Carregue um ambiente 3D para todos na sala.',
  'world.upload': 'Enviar mundo',
  'world.uploading': 'Carregando mundo…',
  'world.apply': 'Aplicar para todos',
  'world.applied': 'Aplicado',
  'world.reset': 'Restaurar padrão',
  'world.default': 'Grade padrão',
  'world.selectPrompt': 'Selecione um mundo para pré-visualizar.',
  'world.name': 'Nome',
  'world.format': 'Formato',
  'world.invalid': 'Formato de mundo não suportado. Use GLB, GLTF, PLY, SPLAT ou KSPLAT.',
  'world.hint': 'Há suporte para malhas GLB / GLTF e cenas Gaussian-splat.',

  // Objects panel
  'objects.title': 'Objetos',
  'objects.subtitle': 'Coloque objetos 3D compartilhados no mundo.',
  'objects.upload': 'Enviar modelo',
  'objects.uploading': 'Carregando modelo…',
  'objects.place': 'Colocar à minha frente',
  'objects.placed': 'Colocado',
  'objects.remove': 'Remover',
  'objects.clear': 'Limpar tudo',
  'objects.selectPrompt': 'Selecione um modelo para colocar.',
  'objects.count': '{count} colocados',
  'objects.empty': 'Nenhum objeto colocado ainda.',
  'objects.invalid': 'Esse arquivo não é um modelo GLTF / GLB válido.',

  // Room panel
  'room.title': 'Sala',
  'room.subtitle': 'Convide outras pessoas ou troque de sala.',
  'room.current': 'Sala atual',
  'room.inviteUrl': 'Link de convite',
  'room.copy': 'Copiar link',
  'room.copied': 'Copiado!',
  'room.idLabel': 'Nome da sala',
  'room.idPlaceholder': 'Digite um nome de sala',
  'room.enter': 'Entrar',
  'room.create': 'Criar',
  'room.random': 'Aleatória',
  'room.switchHint': 'Trocar de sala desconecta você da sala atual.',
  'room.visibility.label': 'Visibilidade',
  'room.visibility.public': 'Pública (qualquer pessoa pode encontrar)',
  'room.visibility.private': 'Privada (só quem souber o ID)',

  // Discover panel
  'discover.title': 'Salas públicas',
  'discover.empty': 'Nenhuma sala pública encontrada ainda.',
  'discover.join': 'Entrar',
  'discover.peers': '{count} online',
  'discover.justNow': 'Agora mesmo',
  'discover.secondsAgo': 'Há {count} s',

  // Settings panel
  'settings.title': 'Configurações',
  'settings.displayName': 'Nome de exibição',
  'settings.color': 'Cor de destaque',
  'settings.language': 'Idioma',
  'settings.quality': 'Qualidade gráfica',
  'settings.qualityLow': 'Baixa',
  'settings.qualityMedium': 'Média',
  'settings.qualityHigh': 'Alta',
  'settings.save': 'Salvar',
  'settings.saved': 'Salvo',

  // Chat
  'chat.placeholder': 'Diga algo…',
  'chat.send': 'Enviar',
  'chat.open': 'Abrir chat',
  'chat.close': 'Fechar chat',

  // Common
  'common.close': 'Fechar',
  'common.cancel': 'Cancelar',
  'common.ok': 'OK',
  'common.loading': 'Carregando…',
  'common.error': 'Algo deu errado.',
  'common.copy': 'Copiar',
  'common.copied': 'Copiado',
  'common.retry': 'Tentar de novo',
}

export default pt
