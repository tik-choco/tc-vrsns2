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
  'join.makePublic': '공개 방으로 참가',

  // Resume
  'resume.message': '마지막 방 "{roomId}"에 재접속하는 중…',

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
  'hud.hintEdit': '편집',
  'hud.hintJump': '점프',
  'hud.hintSprint': '달리기',
  'hud.hintMenu': '메뉴',
  'hud.locked': '월드 잠금 중',
  'hud.openEditing': '누구나 편집 가능',

  // Main menu
  'menu.title': '메뉴',
  'menu.avatar': '아바타',
  'menu.world': '월드',
  'menu.objects': '오브젝트',
  'panel.characters': '캐릭터',
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
  // R6: 직접 업로드하지 않은 아바타(tc-town 캐릭터, 다른 사람이 올린 것)에 붙는
  // 출처 라벨. 내 것처럼 보이지 않게 한다.
  'avatar.foreignSource': '{name}님의 캐릭터',
  'avatar.foreignUnknown': '다른 사람',

  // Characters panel (R5: tc-town 캐릭터를 NPC로 월드에 배치)
  'characters.title': '캐릭터',
  'characters.empty': '아직 캐릭터가 없어요.',
  'characters.hint': '캐릭터는 tc-town에서 만들어요. 그곳에서 만들면 여기 나타나요.',
  'characters.place': '월드에 배치',
  'characters.noVrm': '이 캐릭터에는 사용할 수 있는 VRM 아바타가 없어요.',
  'characters.fromTown': 'tc-town에서',

  // NPC (배치된 캐릭터가 채팅으로 답해요)
  'npc.badge': 'NPC',
  'npc.radius': '청취 반경',
  'npc.radiusValue': '{n}m',
  'npc.voice': '음성',
  'npc.voiceDefault': '기본값 (AI 설정)',
  'npc.voiceHelp': '지우면 AI 설정의 기본 음성이 사용되며, 이 캐릭터의 원래 tc-town 음성으로 복원되지 않습니다.',

  // AI panel
  'settings.ai.npcPreset': 'NPC 응답',
  'settings.ai.npcPresetHelp': '월드에 배치한 캐릭터 근처에서 누군가 말을 걸면 그 캐릭터가 되어 답해요.',

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
  'world.autosaveHint': '이 방의 월드는 이 기기에 자동 저장되어 다시 들어오면 복원돼요.',
  'world.policyLabel': '이 월드를 편집할 수 있는 사람',
  'world.policyOwner': '놓은 사람만',
  'world.policyEveryone': '모두',
  'world.policyLocked': '잠금',
  'world.policyOwnerHint': '누구나 추가할 수 있지만, 옮기거나 지우는 건 놓은 사람만 할 수 있어요.',
  'world.policyEveryoneHint': '방에 있는 누구나 놓인 것을 옮기고 크기를 바꾸고 지울 수 있어요.',
  'world.policyLockedHint': '환경도 바꿀 수 없고 놓인 것도 건드릴 수 없어요.',
  'world.lockedNotice': '이 월드는 잠겨 있어요. 편집하려면 위 설정을 바꾸세요.',

  // Objects panel
  'objects.title': '오브젝트',
  'objects.subtitle': '공유되는 소품, 이미지, 영상, 소리를 월드에 배치하세요.',
  'objects.upload': '파일 업로드',
  'objects.uploading': '파일 불러오는 중…',
  'objects.place': '내 앞에 배치',
  'objects.placed': '배치됨',
  'objects.remove': '삭제',
  'objects.clear': '전체 삭제',
  'objects.selectPrompt': '배치할 항목을 선택하세요.',
  'objects.count': '{count}개 배치됨',
  'objects.empty': '아직 배치된 오브젝트가 없어요.',
  'objects.hint': 'GLB / GLTF 모델, 이미지, 영상, 오디오를 지원해요. 영상과 오디오는 거리에 따라 소리가 줄어드는 공간 음향으로 재생돼요.',
  'objects.invalid': '이 파일은 모델·이미지·영상·오디오로 읽을 수 없어요.',
  'objects.tooLarge': '파일이 너무 커요. 최대 {size} MB예요.',
  'objects.edit': '배치된 것 편집',
  'objects.editing': '배치된 오브젝트 편집',
  'objects.editHint': '직접 놓은 것을 클릭해 선택하세요. 오른쪽 버튼을 누른 채로 시점을 돌릴 수 있어요.',
  'objects.editDone': '완료',
  'objects.deleteOne': '삭제',
  'objects.move': '이동',
  'objects.rotate': '회전',
  'objects.scale': '크기',
  'objects.placedBy': '{name} 님이 배치',
  'objects.orphans': '떠난 사람이 남긴 것이 {count}개 있어요. 방을 나갈 때까지 남지만 아무도 편집할 수 없어요.',

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
  'room.visibility.label': '공개 설정',
  'room.visibility.public': '공개 (누구나 찾을 수 있음)',
  'room.visibility.private': '비공개 (ID를 아는 사람만)',

  // Discover panel
  'discover.title': '공개 방',
  'discover.empty': '아직 발견된 공개 방이 없습니다.',
  'discover.join': '참가',
  'discover.peers': '{count}명',
  'discover.justNow': '방금 전',
  'discover.secondsAgo': '{count}초 전',

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
