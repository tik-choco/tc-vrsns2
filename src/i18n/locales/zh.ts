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
  'join.makePublic': '以公开房间加入',
  'join.errorRenderer': '此设备无法显示 3D 内容——WebGL 不可用或已被屏蔽。',
  'join.errorTimeout': '重新连接耗时过长，请重新加入。',

  // Resume
  'resume.message': '正在重新加入上次的房间「{roomId}」…',

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
  'hud.hintEdit': '编辑',
  'hud.hintJump': '跳跃',
  'hud.hintSprint': '奔跑',
  'hud.hintCrouch': '蹲下',
  'hud.hintMenu': '菜单',
  'hud.locked': '世界已锁定',
  'hud.openEditing': '任何人可编辑',

  // Main menu
  'menu.title': '菜单',
  'menu.avatar': '虚拟形象',
  'menu.world': '世界',
  'menu.objects': '物体',
  'panel.characters': '角色',
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
  // R6：非本机上传的虚拟形象（tc-town 角色或他人上传的内容）需要显示的来源标签，
  // 避免让它看起来像是自己拥有的。
  'avatar.foreignSource': '{name}的角色',
  'avatar.foreignUnknown': '别人',

  // Characters panel（R5：把 tc-town 角色作为 NPC 放入世界）
  'characters.title': '角色',
  'characters.empty': '还没有角色。',
  'characters.hint': '角色是在 tc-town 中创建的。创建后会显示在这里。',
  'characters.place': '放入世界',
  'characters.noVrm': '此角色没有可用的 VRM 虚拟形象。',
  'characters.fromTown': '来自 tc-town',

  // NPC（放置的角色会在聊天中回复）
  'npc.badge': 'NPC',
  'npc.radius': '听力范围',
  'npc.radiusValue': '{n} 米',
  'npc.voice': '语音',
  'npc.voiceDefault': '默认（AI 设置）',
  'npc.voiceHelp': '清除后将使用 AI 设置中的默认语音，而不是恢复该角色在 tc-town 中的原始语音。',

  // AI panel
  'settings.ai.npcPreset': 'NPC 回复',
  'settings.ai.npcPresetHelp': '当有人在你放置在世界中的角色附近说话时，会以该角色的身份回答。',

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
  'world.autosaveHint': '该房间的世界会自动保存在本机，下次进入时恢复。',
  'world.policyLabel': '谁可以编辑这个世界',
  'world.policyOwner': '仅放置者',
  'world.policyEveryone': '所有人',
  'world.policyLocked': '锁定',
  'world.policyOwnerHint': '任何人都能添加，但只有放置者能移动或删除自己的物体。',
  'world.policyEveryoneHint': '房间里的任何人都能移动、缩放或删除已放置的物体。',
  'world.policyLockedHint': '不能更改环境，也不能操作已放置的物体。',
  'world.lockedNotice': '该世界已锁定。要编辑请先修改上面的设置。',

  // Objects panel
  'objects.title': '物体',
  'objects.subtitle': '在世界中放置共享的道具、图片、视频和音频。',
  'objects.upload': '上传文件',
  'objects.uploading': '正在加载文件…',
  'objects.place': '放到我面前',
  'objects.placed': '已放置',
  'objects.remove': '删除',
  'objects.clear': '全部清除',
  'objects.selectPrompt': '选择要放置的内容。',
  'objects.count': '已放置 {count} 个',
  'objects.empty': '还没有放置任何物体。',
  'objects.hint': '支持 GLB / GLTF 模型、图片、视频和音频。视频和音频以空间音效播放，音量随距离衰减。',
  'objects.invalid': '无法将该文件读取为模型、图片、视频或音频。',
  'objects.tooLarge': '文件太大，上限为 {size} MB。',
  'objects.edit': '编辑已放置',
  'objects.editing': '编辑已放置的物体',
  'objects.editHint': '点击你放置的物体进行选择。按住右键可转动视角。',
  'objects.editDone': '完成',
  'objects.deleteOne': '删除',
  'objects.move': '移动',
  'objects.rotate': '旋转',
  'objects.scale': '缩放',
  'objects.placedBy': '由 {name} 放置',
  'objects.orphans': '有 {count} 个是已离开的人留下的。它们会保留到你离开房间，且无人能编辑。',

  // 音量／可听范围 — 仅音频和视频对象，通过编辑工具栏（EditToolbar.tsx）设置
  'objects.volume': '音量',
  'objects.volumeValue': '{n}%',
  'objects.range': '可听范围',
  'objects.rangeValue': '{n} 米',

  // 拖放导入浮层 — 把文件拖放到应用的任意位置时弹出
  'dropImport.title': '要将它添加到你的世界吗？',
  'dropImport.descAvatar': '它将作为你的虚拟形象被穿上。',
  'dropImport.descModel': '它将作为 3D 模型放置到世界中。',
  'dropImport.descImage': '它将作为图片放置到世界中。',
  'dropImport.descVideo': '它将作为视频屏幕放置到世界中。',
  'dropImport.descAudio': '它将作为声音放置到世界中。',
  'dropImport.descWorld': '它将成为房间里所有人看到的环境。',
  'dropImport.addToWorld': '添加到世界',
  'dropImport.setAsWorldEnvironment': '或改为设置为世界环境',
  'dropImport.saveOnly': '仅保存到物品库',
  'dropImport.unsupportedTitle': '无法添加此文件',
  'dropImport.unsupportedBody': '“{fileName}” 不是本应用可用的虚拟形象、世界或物体文件。',

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
  'room.visibility.label': '可见性',
  'room.visibility.public': '公开（任何人都可以发现）',
  'room.visibility.private': '私密（仅知道 ID 的人可加入）',

  // Discover panel
  'discover.title': '公开房间',
  'discover.empty': '暂未发现公开房间。',
  'discover.join': '加入',
  'discover.peers': '{count} 人',
  'discover.justNow': '刚刚',
  'discover.secondsAgo': '{count} 秒前',

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
