// 日本語 (Japanese). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const ja: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'サーバー不要のP2Pメタバース。つながるのは人と人だけ。',

  // Join screen
  'join.heading': 'ワールドに入る',
  'join.roomLabel': 'ルーム',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': '英数字・ハイフン・アンダースコアが使えます（最大64文字）。',
  'join.nameLabel': '表示名',
  'join.namePlaceholder': 'あなたの名前',
  'join.colorLabel': 'アクセントカラー',
  'join.languageLabel': '言語',
  'join.join': '入室',
  'join.connecting': '接続中…',
  'join.random': 'ランダムルーム',
  'join.recent': '最近',
  'join.roomInvalid': 'ルーム名は英数字・ハイフン・アンダースコアのみ使えます（最大64文字）。',
  'join.nameRequired': '表示名を入力してください。',
  'join.makePublic': '公開ルームとして参加',

  // Resume（前回のルームへの自動再参加）
  'resume.message': '前回のルーム「{roomId}」に再開中…',

  // HUD
  'hud.peers': '{count}人がオンライン',
  'hud.you': 'あなた',
  'hud.voiceOn': 'ボイスオン',
  'hud.voiceMuted': 'ミュート中',
  'hud.voiceError': 'マイクエラー',
  'hud.voiceRequesting': 'マイクを要求中…',
  'hud.hintMove': '移動',
  'hud.hintChat': 'チャット',
  'hud.hintMic': 'マイク',
  'hud.hintView': '視点',
  'hud.hintJump': 'ジャンプ',
  'hud.hintSprint': 'ダッシュ',
  'hud.hintMenu': 'メニュー',

  // Main menu
  'menu.title': 'メニュー',
  'menu.avatar': 'アバター',
  'menu.world': 'ワールド',
  'menu.objects': 'オブジェクト',
  'menu.room': 'ルーム',
  'menu.settings': '設定',
  'menu.leave': '退室',
  'menu.close': '閉じる',

  // Avatar panel
  'avatar.title': 'アバター',
  'avatar.subtitle': 'VRMアバターを選ぶかアップロードします。',
  'avatar.upload': 'VRMをアップロード',
  'avatar.uploading': '読み込み中…',
  'avatar.default': 'デフォルト',
  'avatar.equip': '装備する',
  'avatar.equipped': '装備中',
  'avatar.remove': '削除',
  'avatar.selectPrompt': 'プレビューするアバターを選択してください。',
  'avatar.name': '名前',
  'avatar.author': '作者',
  'avatar.license': 'ライセンス',
  'avatar.invalid': '有効なVRMファイルではありません。',
  'avatar.saved': 'アバターに保存しました。',
  'avatar.townTitle': 'tc-townのキャラクター',
  'avatar.townEquip': '装備する',
  'avatar.townNoModel': 'このキャラクターは装備できるVRMがありません。',

  // World panel
  'world.title': 'ワールド',
  'world.subtitle': 'ルーム全員に共有する3D環境を読み込みます。',
  'world.upload': 'ワールドをアップロード',
  'world.uploading': 'ワールドを読み込み中…',
  'world.apply': '全員に適用',
  'world.applied': '適用済み',
  'world.reset': 'デフォルトに戻す',
  'world.default': 'デフォルトのグリッド',
  'world.selectPrompt': 'プレビューするワールドを選択してください。',
  'world.name': '名前',
  'world.format': '形式',
  'world.invalid': '対応していない形式です。GLB・GLTF・PLY・SPLAT・KSPLATを使用してください。',
  'world.hint': 'GLB／GLTFメッシュとガウシアンスプラットに対応しています。',

  // Objects panel
  'objects.title': 'オブジェクト',
  'objects.subtitle': '共有できる3Dオブジェクトをワールドに配置します。',
  'objects.upload': 'モデルをアップロード',
  'objects.uploading': 'モデルを読み込み中…',
  'objects.place': '目の前に配置',
  'objects.placed': '配置済み',
  'objects.remove': '削除',
  'objects.clear': 'すべて削除',
  'objects.selectPrompt': '配置するモデルを選択してください。',
  'objects.count': '{count}個を配置中',
  'objects.empty': 'まだオブジェクトがありません。',
  'objects.invalid': '有効なGLTF／GLBモデルではありません。',

  // Room panel
  'room.title': 'ルーム',
  'room.subtitle': '他の人を招待したり、ルームを切り替えます。',
  'room.current': '現在のルーム',
  'room.inviteUrl': '招待リンク',
  'room.copy': 'リンクをコピー',
  'room.copied': 'コピーしました！',
  'room.idLabel': 'ルーム名',
  'room.idPlaceholder': 'ルーム名を入力',
  'room.enter': '入室',
  'room.create': '作成',
  'room.random': 'ランダム',
  'room.switchHint': 'ルームを切り替えると現在のルームから切断されます。',
  'room.visibility.label': '公開設定',
  'room.visibility.public': '公開（だれでも発見できます）',
  'room.visibility.private': '非公開（IDを知っている人のみ）',

  // Discover panel
  'discover.title': '公開ルーム',
  'discover.empty': '公開ルームはまだ見つかっていません',
  'discover.join': '参加',
  'discover.peers': '{count}人',
  'discover.justNow': 'たった今',
  'discover.secondsAgo': '{count}秒前',

  // Settings panel
  'settings.title': '設定',
  'settings.displayName': '表示名',
  'settings.color': 'アクセントカラー',
  'settings.language': '言語',
  'settings.quality': 'グラフィック品質',
  'settings.qualityLow': '低',
  'settings.qualityMedium': '中',
  'settings.qualityHigh': '高',
  'settings.save': '保存',
  'settings.saved': '保存しました',

  // Chat
  'chat.placeholder': 'メッセージを入力…',
  'chat.send': '送信',
  'chat.open': 'チャットを開く',
  'chat.close': 'チャットを閉じる',

  // Common
  'common.close': '閉じる',
  'common.cancel': 'キャンセル',
  'common.ok': 'OK',
  'common.loading': '読み込み中…',
  'common.error': '問題が発生しました。',
  'common.copy': 'コピー',
  'common.copied': 'コピー済み',
  'common.retry': '再試行',
}

export default ja
