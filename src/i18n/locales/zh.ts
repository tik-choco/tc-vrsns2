// 中文 (Chinese, Simplified). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const zh: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': '点对点元宇宙——没有服务器，只有人。',

  // Join screen
  'join.heading': '进入世界',
  'join.roomLabel': '房间',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': '可使用字母、数字、连字符和下划线，最多 64 个字符。',
  'join.nameLabel': '昵称',
  'join.namePlaceholder': '你的名字',
  'join.colorLabel': '主题色',
  'join.languageLabel': '语言',
  'join.join': '加入',
  'join.connecting': '连接中…',
  'join.random': '随机房间',
  'join.recent': '最近',
  'join.roomInvalid': '房间名只能包含字母、数字、连字符和下划线（最多 64 个字符）。',
  'join.nameRequired': '请输入昵称。',

  // HUD
  'hud.peers': '{count} 人在线',
  'hud.you': '你',
  'hud.voiceOn': '语音已开',
  'hud.voiceMuted': '已静音',
  'hud.voiceError': '麦克风错误',
  'hud.voiceRequesting': '正在请求麦克风…',
  'hud.hintMove': '移动',
  'hud.hintChat': '聊天',
  'hud.hintMic': '麦克风',
  'hud.hintView': '视角',
  'hud.hintJump': '跳跃',
  'hud.hintSprint': '奔跑',
  'hud.hintMenu': '菜单',

  // Main menu
  'menu.title': '菜单',
  'menu.avatar': '虚拟形象',
  'menu.world': '世界',
  'menu.objects': '物体',
  'menu.room': '房间',
  'menu.settings': '设置',
  'menu.leave': '离开',
  'menu.close': '关闭',

  // Avatar panel
  'avatar.title': '虚拟形象',
  'avatar.subtitle': '选择或上传一个 VRM 虚拟形象。',
  'avatar.upload': '上传 VRM',
  'avatar.uploading': '加载中…',
  'avatar.default': '默认',
  'avatar.equip': '使用',
  'avatar.equipped': '使用中',
  'avatar.remove': '删除',
  'avatar.selectPrompt': '选择一个虚拟形象进行预览。',
  'avatar.name': '名称',
  'avatar.author': '作者',
  'avatar.license': '许可',
  'avatar.invalid': '该文件不是有效的 VRM。',
  'avatar.saved': '已保存到你的虚拟形象。',

  // World panel
  'world.title': '世界',
  'world.subtitle': '为房间内所有人加载一个 3D 环境。',
  'world.upload': '上传世界',
  'world.uploading': '正在加载世界…',
  'world.apply': '应用于所有人',
  'world.applied': '已应用',
  'world.reset': '恢复默认',
  'world.default': '默认网格',
  'world.selectPrompt': '选择一个世界进行预览。',
  'world.name': '名称',
  'world.format': '格式',
  'world.invalid': '不支持的世界格式。请使用 GLB、GLTF、PLY、SPLAT 或 KSPLAT。',
  'world.hint': '支持 GLB / GLTF 网格和高斯泼溅场景。',

  // Objects panel
  'objects.title': '物体',
  'objects.subtitle': '在世界中放置共享的 3D 道具。',
  'objects.upload': '上传模型',
  'objects.uploading': '正在加载模型…',
  'objects.place': '放到我面前',
  'objects.placed': '已放置',
  'objects.remove': '删除',
  'objects.clear': '全部清除',
  'objects.selectPrompt': '选择要放置的模型。',
  'objects.count': '已放置 {count} 个',
  'objects.empty': '还没有放置任何物体。',
  'objects.invalid': '该文件不是有效的 GLTF / GLB 模型。',

  // Room panel
  'room.title': '房间',
  'room.subtitle': '邀请他人或切换房间。',
  'room.current': '当前房间',
  'room.inviteUrl': '邀请链接',
  'room.copy': '复制链接',
  'room.copied': '已复制！',
  'room.idLabel': '房间名',
  'room.idPlaceholder': '输入房间名',
  'room.enter': '进入',
  'room.create': '创建',
  'room.random': '随机',
  'room.switchHint': '切换房间会断开你与当前房间的连接。',

  // Settings panel
  'settings.title': '设置',
  'settings.displayName': '昵称',
  'settings.color': '主题色',
  'settings.language': '语言',
  'settings.quality': '画质',
  'settings.qualityLow': '低',
  'settings.qualityMedium': '中',
  'settings.qualityHigh': '高',
  'settings.save': '保存',
  'settings.saved': '已保存',

  // Chat
  'chat.placeholder': '说点什么…',
  'chat.send': '发送',
  'chat.open': '打开聊天',
  'chat.close': '关闭聊天',

  // Common
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.ok': '确定',
  'common.loading': '加载中…',
  'common.error': '出错了。',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.retry': '重试',
}

export default zh
