// 한국어 (Korean). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const ko: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': '서버 없는 P2P 메타버스. 오직 사람과 사람.',

  // Join screen
  'join.heading': '월드에 입장',
  'join.roomLabel': '방',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': '영문, 숫자, 하이픈, 밑줄을 사용할 수 있어요. 최대 64자.',
  'join.nameLabel': '표시 이름',
  'join.namePlaceholder': '이름',
  'join.colorLabel': '강조 색상',
  'join.languageLabel': '언어',
  'join.join': '입장',
  'join.connecting': '연결 중…',
  'join.random': '랜덤 방',
  'join.recent': '최근',
  'join.roomInvalid': '방 이름은 영문, 숫자, 하이픈, 밑줄만 사용할 수 있어요 (최대 64자).',
  'join.nameRequired': '표시 이름을 입력해 주세요.',

  // HUD
  'hud.peers': '{count}명 접속 중',
  'hud.you': '나',
  'hud.voiceOn': '음성 켜짐',
  'hud.voiceMuted': '음소거됨',
  'hud.voiceError': '마이크 오류',
  'hud.voiceRequesting': '마이크 요청 중…',
  'hud.hintMove': '이동',
  'hud.hintChat': '채팅',
  'hud.hintMic': '마이크',
  'hud.hintView': '시점',
  'hud.hintJump': '점프',
  'hud.hintSprint': '달리기',
  'hud.hintMenu': '메뉴',

  // Main menu
  'menu.title': '메뉴',
  'menu.avatar': '아바타',
  'menu.world': '월드',
  'menu.objects': '오브젝트',
  'menu.room': '방',
  'menu.settings': '설정',
  'menu.leave': '나가기',
  'menu.close': '닫기',

  // Avatar panel
  'avatar.title': '아바타',
  'avatar.subtitle': 'VRM 아바타를 선택하거나 업로드하세요.',
  'avatar.upload': 'VRM 업로드',
  'avatar.uploading': '불러오는 중…',
  'avatar.default': '기본',
  'avatar.equip': '착용',
  'avatar.equipped': '착용 중',
  'avatar.remove': '삭제',
  'avatar.selectPrompt': '미리 볼 아바타를 선택하세요.',
  'avatar.name': '이름',
  'avatar.author': '제작자',
  'avatar.license': '라이선스',
  'avatar.invalid': '유효한 VRM 파일이 아니에요.',
  'avatar.saved': '내 아바타에 저장했어요.',

  // World panel
  'world.title': '월드',
  'world.subtitle': '방에 있는 모두를 위한 3D 환경을 불러오세요.',
  'world.upload': '월드 업로드',
  'world.uploading': '월드 불러오는 중…',
  'world.apply': '모두에게 적용',
  'world.applied': '적용됨',
  'world.reset': '기본값으로 초기화',
  'world.default': '기본 그리드',
  'world.selectPrompt': '미리 볼 월드를 선택하세요.',
  'world.name': '이름',
  'world.format': '형식',
  'world.invalid': '지원하지 않는 월드 형식이에요. GLB, GLTF, PLY, SPLAT 또는 KSPLAT을 사용하세요.',
  'world.hint': 'GLB / GLTF 메시와 가우시안 스플랫 씬을 지원해요.',

  // Objects panel
  'objects.title': '오브젝트',
  'objects.subtitle': '공유되는 3D 소품을 월드에 배치하세요.',
  'objects.upload': '모델 업로드',
  'objects.uploading': '모델 불러오는 중…',
  'objects.place': '내 앞에 배치',
  'objects.placed': '배치됨',
  'objects.remove': '삭제',
  'objects.clear': '전체 삭제',
  'objects.selectPrompt': '배치할 모델을 선택하세요.',
  'objects.count': '{count}개 배치됨',
  'objects.empty': '아직 배치된 오브젝트가 없어요.',
  'objects.invalid': '유효한 GLTF / GLB 모델이 아니에요.',

  // Room panel
  'room.title': '방',
  'room.subtitle': '다른 사람을 초대하거나 방을 옮기세요.',
  'room.current': '현재 방',
  'room.inviteUrl': '초대 링크',
  'room.copy': '링크 복사',
  'room.copied': '복사했어요!',
  'room.idLabel': '방 이름',
  'room.idPlaceholder': '방 이름 입력',
  'room.enter': '입장',
  'room.create': '만들기',
  'room.random': '랜덤',
  'room.switchHint': '방을 옮기면 현재 방에서 연결이 끊겨요.',

  // Settings panel
  'settings.title': '설정',
  'settings.displayName': '표시 이름',
  'settings.color': '강조 색상',
  'settings.language': '언어',
  'settings.quality': '그래픽 품질',
  'settings.qualityLow': '낮음',
  'settings.qualityMedium': '보통',
  'settings.qualityHigh': '높음',
  'settings.save': '저장',
  'settings.saved': '저장됨',

  // Chat
  'chat.placeholder': '메시지를 입력하세요…',
  'chat.send': '보내기',
  'chat.open': '채팅 열기',
  'chat.close': '채팅 닫기',

  // Common
  'common.close': '닫기',
  'common.cancel': '취소',
  'common.ok': '확인',
  'common.loading': '불러오는 중…',
  'common.error': '문제가 발생했어요.',
  'common.copy': '복사',
  'common.copied': '복사됨',
  'common.retry': '다시 시도',
}

export default ko
