// Русский (Russian). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const ru: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'Одноранговая метавселенная — без серверов, только люди.',

  // Join screen
  'join.heading': 'Войти в мир',
  'join.roomLabel': 'Комната',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Буквы, цифры, дефис и подчёркивание. До 64 символов.',
  'join.nameLabel': 'Отображаемое имя',
  'join.namePlaceholder': 'Ваше имя',
  'join.colorLabel': 'Акцентный цвет',
  'join.languageLabel': 'Язык',
  'join.join': 'Войти',
  'join.connecting': 'Подключение…',
  'join.random': 'Случайная комната',
  'join.recent': 'Недавние',
  'join.roomInvalid': 'В имени комнаты можно использовать только буквы, цифры, дефис и подчёркивание (не более 64).',
  'join.nameRequired': 'Введите отображаемое имя.',

  // HUD
  'hud.peers': '{count} в сети',
  'hud.you': 'Вы',
  'hud.voiceOn': 'Голос включён',
  'hud.voiceMuted': 'Голос выключен',
  'hud.voiceError': 'Ошибка микрофона',
  'hud.voiceRequesting': 'Запрос микрофона…',
  'hud.hintMove': 'Движение',
  'hud.hintChat': 'Чат',
  'hud.hintMic': 'Микрофон',
  'hud.hintView': 'Обзор',
  'hud.hintJump': 'Прыжок',
  'hud.hintSprint': 'Бег',
  'hud.hintMenu': 'Меню',

  // Main menu
  'menu.title': 'Меню',
  'menu.avatar': 'Аватар',
  'menu.world': 'Мир',
  'menu.objects': 'Объекты',
  'menu.room': 'Комната',
  'menu.settings': 'Настройки',
  'menu.leave': 'Выйти',
  'menu.close': 'Закрыть',

  // Avatar panel
  'avatar.title': 'Аватар',
  'avatar.subtitle': 'Выберите или загрузите VRM-аватар.',
  'avatar.upload': 'Загрузить VRM',
  'avatar.uploading': 'Загрузка…',
  'avatar.default': 'По умолчанию',
  'avatar.equip': 'Надеть',
  'avatar.equipped': 'Надет',
  'avatar.remove': 'Удалить',
  'avatar.selectPrompt': 'Выберите аватар для предпросмотра.',
  'avatar.name': 'Имя',
  'avatar.author': 'Автор',
  'avatar.license': 'Лицензия',
  'avatar.invalid': 'Этот файл не является корректным VRM.',
  'avatar.saved': 'Сохранено в ваших аватарах.',

  // World panel
  'world.title': 'Мир',
  'world.subtitle': 'Загрузите 3D-окружение для всех в комнате.',
  'world.upload': 'Загрузить мир',
  'world.uploading': 'Загрузка мира…',
  'world.apply': 'Применить для всех',
  'world.applied': 'Применено',
  'world.reset': 'Сбросить',
  'world.default': 'Сетка по умолчанию',
  'world.selectPrompt': 'Выберите мир для предпросмотра.',
  'world.name': 'Название',
  'world.format': 'Формат',
  'world.invalid': 'Неподдерживаемый формат мира. Используйте GLB, GLTF, PLY, SPLAT или KSPLAT.',
  'world.hint': 'Поддерживаются меши GLB / GLTF и сцены Gaussian-splat.',

  // Objects panel
  'objects.title': 'Объекты',
  'objects.subtitle': 'Размещайте общие 3D-объекты в мире.',
  'objects.upload': 'Загрузить модель',
  'objects.uploading': 'Загрузка модели…',
  'objects.place': 'Поставить передо мной',
  'objects.placed': 'Размещено',
  'objects.remove': 'Удалить',
  'objects.clear': 'Очистить всё',
  'objects.selectPrompt': 'Выберите модель для размещения.',
  'objects.count': 'Размещено: {count}',
  'objects.empty': 'Пока нет размещённых объектов.',
  'objects.invalid': 'Этот файл не является корректной моделью GLTF / GLB.',

  // Room panel
  'room.title': 'Комната',
  'room.subtitle': 'Пригласите других или смените комнату.',
  'room.current': 'Текущая комната',
  'room.inviteUrl': 'Ссылка-приглашение',
  'room.copy': 'Копировать ссылку',
  'room.copied': 'Скопировано!',
  'room.idLabel': 'Имя комнаты',
  'room.idPlaceholder': 'Введите имя комнаты',
  'room.enter': 'Войти',
  'room.create': 'Создать',
  'room.random': 'Случайная',
  'room.switchHint': 'При смене комнаты вы отключитесь от текущей.',

  // Settings panel
  'settings.title': 'Настройки',
  'settings.displayName': 'Отображаемое имя',
  'settings.color': 'Акцентный цвет',
  'settings.language': 'Язык',
  'settings.quality': 'Качество графики',
  'settings.qualityLow': 'Низкое',
  'settings.qualityMedium': 'Среднее',
  'settings.qualityHigh': 'Высокое',
  'settings.save': 'Сохранить',
  'settings.saved': 'Сохранено',

  // Chat
  'chat.placeholder': 'Напишите что-нибудь…',
  'chat.send': 'Отправить',
  'chat.open': 'Открыть чат',
  'chat.close': 'Закрыть чат',

  // Common
  'common.close': 'Закрыть',
  'common.cancel': 'Отмена',
  'common.ok': 'ОК',
  'common.loading': 'Загрузка…',
  'common.error': 'Что-то пошло не так.',
  'common.copy': 'Копировать',
  'common.copied': 'Скопировано',
  'common.retry': 'Повторить',
}

export default ru
