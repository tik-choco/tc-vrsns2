// हिन्दी (Hindi). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const hi: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'एक पीयर-टू-पीयर मेटावर्स — कोई सर्वर नहीं, बस लोग।',

  // Join screen
  'join.heading': 'दुनिया में प्रवेश करें',
  'join.roomLabel': 'रूम',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'अक्षर, अंक, हाइफ़न और अंडरस्कोर। अधिकतम 64 अक्षर।',
  'join.nameLabel': 'प्रदर्शित नाम',
  'join.namePlaceholder': 'आपका नाम',
  'join.colorLabel': 'एक्सेंट रंग',
  'join.languageLabel': 'भाषा',
  'join.join': 'शामिल हों',
  'join.connecting': 'कनेक्ट हो रहा है…',
  'join.random': 'रैंडम रूम',
  'join.recent': 'हाल के',
  'join.roomInvalid': 'रूम नाम में केवल अक्षर, अंक, हाइफ़न और अंडरस्कोर हो सकते हैं (अधिकतम 64)।',
  'join.nameRequired': 'कृपया एक प्रदर्शित नाम दर्ज करें।',
  'join.makePublic': 'सार्वजनिक रूम के रूप में शामिल हों',

  // Resume
  'resume.message': 'आपका पिछला रूम "{roomId}" फिर से शुरू हो रहा है…',

  // HUD
  'hud.peers': '{count} ऑनलाइन',
  'hud.you': 'आप',
  'hud.voiceOn': 'वॉइस चालू',
  'hud.voiceMuted': 'वॉइस म्यूट',
  'hud.voiceError': 'माइक त्रुटि',
  'hud.voiceRequesting': 'माइक का अनुरोध हो रहा है…',
  'hud.hintMove': 'चलें',
  'hud.hintChat': 'चैट',
  'hud.hintMic': 'माइक',
  'hud.hintView': 'व्यू',
  'hud.hintJump': 'कूदें',
  'hud.hintSprint': 'दौड़ें',
  'hud.hintMenu': 'मेन्यू',

  // Main menu
  'menu.title': 'मेन्यू',
  'menu.avatar': 'अवतार',
  'menu.world': 'दुनिया',
  'menu.objects': 'ऑब्जेक्ट',
  'menu.room': 'रूम',
  'menu.settings': 'सेटिंग्स',
  'menu.leave': 'छोड़ें',
  'menu.close': 'बंद करें',

  // Avatar panel
  'avatar.title': 'अवतार',
  'avatar.subtitle': 'कोई VRM अवतार चुनें या अपलोड करें।',
  'avatar.upload': 'VRM अपलोड करें',
  'avatar.uploading': 'लोड हो रहा है…',
  'avatar.default': 'डिफ़ॉल्ट',
  'avatar.equip': 'पहनें',
  'avatar.equipped': 'पहना हुआ',
  'avatar.remove': 'हटाएं',
  'avatar.selectPrompt': 'प्रीव्यू के लिए कोई अवतार चुनें।',
  'avatar.name': 'नाम',
  'avatar.author': 'निर्माता',
  'avatar.license': 'लाइसेंस',
  'avatar.invalid': 'यह फ़ाइल एक मान्य VRM नहीं है।',
  'avatar.saved': 'आपके अवतारों में सहेजा गया।',

  // World panel
  'world.title': 'दुनिया',
  'world.subtitle': 'रूम में सभी के लिए एक 3D वातावरण लोड करें।',
  'world.upload': 'दुनिया अपलोड करें',
  'world.uploading': 'दुनिया लोड हो रही है…',
  'world.apply': 'सभी पर लागू करें',
  'world.applied': 'लागू किया गया',
  'world.reset': 'डिफ़ॉल्ट पर रीसेट करें',
  'world.default': 'डिफ़ॉल्ट ग्रिड',
  'world.selectPrompt': 'प्रीव्यू के लिए कोई दुनिया चुनें।',
  'world.name': 'नाम',
  'world.format': 'फ़ॉर्मैट',
  'world.invalid': 'असमर्थित दुनिया फ़ॉर्मैट। GLB, GLTF, PLY, SPLAT या KSPLAT का उपयोग करें।',
  'world.hint': 'GLB / GLTF मेश और Gaussian-splat सीन समर्थित हैं।',

  // Objects panel
  'objects.title': 'ऑब्जेक्ट',
  'objects.subtitle': 'दुनिया में साझा 3D प्रॉप्स रखें।',
  'objects.upload': 'मॉडल अपलोड करें',
  'objects.uploading': 'मॉडल लोड हो रहा है…',
  'objects.place': 'मेरे सामने रखें',
  'objects.placed': 'रखा गया',
  'objects.remove': 'हटाएं',
  'objects.clear': 'सभी हटाएं',
  'objects.selectPrompt': 'रखने के लिए कोई मॉडल चुनें।',
  'objects.count': '{count} रखे गए',
  'objects.empty': 'अभी तक कोई ऑब्जेक्ट नहीं रखा गया।',
  'objects.invalid': 'यह फ़ाइल एक मान्य GLTF / GLB मॉडल नहीं है।',

  // Room panel
  'room.title': 'रूम',
  'room.subtitle': 'दूसरों को आमंत्रित करें या रूम बदलें।',
  'room.current': 'वर्तमान रूम',
  'room.inviteUrl': 'आमंत्रण लिंक',
  'room.copy': 'लिंक कॉपी करें',
  'room.copied': 'कॉपी हो गया!',
  'room.idLabel': 'रूम नाम',
  'room.idPlaceholder': 'रूम नाम लिखें',
  'room.enter': 'प्रवेश करें',
  'room.create': 'बनाएं',
  'room.random': 'रैंडम',
  'room.switchHint': 'रूम बदलने पर आप वर्तमान रूम से डिस्कनेक्ट हो जाएंगे।',
  'room.visibility.label': 'दृश्यता',
  'room.visibility.public': 'सार्वजनिक (कोई भी खोज सकता है)',
  'room.visibility.private': 'निजी (केवल आईडी जानने वाले)',

  // Discover panel
  'discover.title': 'सार्वजनिक रूम',
  'discover.empty': 'अभी तक कोई सार्वजनिक रूम नहीं मिला।',
  'discover.join': 'शामिल हों',
  'discover.peers': '{count} ऑनलाइन',
  'discover.justNow': 'अभी अभी',
  'discover.secondsAgo': '{count} सेकंड पहले',

  // Settings panel
  'settings.title': 'सेटिंग्स',
  'settings.displayName': 'प्रदर्शित नाम',
  'settings.color': 'एक्सेंट रंग',
  'settings.language': 'भाषा',
  'settings.quality': 'ग्राफ़िक्स क्वालिटी',
  'settings.qualityLow': 'कम',
  'settings.qualityMedium': 'मध्यम',
  'settings.qualityHigh': 'उच्च',
  'settings.save': 'सहेजें',
  'settings.saved': 'सहेजा गया',

  // Chat
  'chat.placeholder': 'कुछ कहें…',
  'chat.send': 'भेजें',
  'chat.open': 'चैट खोलें',
  'chat.close': 'चैट बंद करें',

  // Common
  'common.close': 'बंद करें',
  'common.cancel': 'रद्द करें',
  'common.ok': 'ठीक है',
  'common.loading': 'लोड हो रहा है…',
  'common.error': 'कुछ गलत हो गया।',
  'common.copy': 'कॉपी करें',
  'common.copied': 'कॉपी हो गया',
  'common.retry': 'फिर से कोशिश करें',
}

export default hi
