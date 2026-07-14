// العربية (Arabic). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const ar: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'عالم افتراضي بين الأقران — بلا خوادم، فقط أشخاص.',

  // Join screen
  'join.heading': 'ادخل إلى العالم',
  'join.roomLabel': 'الغرفة',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'حروف وأرقام وشرطة وشرطة سفلية. حتى 64 حرفًا.',
  'join.nameLabel': 'الاسم المعروض',
  'join.namePlaceholder': 'اسمك',
  'join.colorLabel': 'اللون المميز',
  'join.languageLabel': 'اللغة',
  'join.join': 'انضمام',
  'join.connecting': 'جارٍ الاتصال…',
  'join.random': 'غرفة عشوائية',
  'join.recent': 'الأخيرة',
  'join.roomInvalid': 'يمكن أن يحتوي اسم الغرفة على حروف وأرقام وشرطة وشرطة سفلية فقط (بحد أقصى 64).',
  'join.nameRequired': 'يرجى إدخال اسم معروض.',
  'join.makePublic': 'الانضمام كغرفة عامة',

  // HUD
  'hud.peers': '{count} متصل',
  'hud.you': 'أنت',
  'hud.voiceOn': 'الصوت مفعّل',
  'hud.voiceMuted': 'الصوت مكتوم',
  'hud.voiceError': 'خطأ في الميكروفون',
  'hud.voiceRequesting': 'جارٍ طلب الميكروفون…',
  'hud.hintMove': 'التحرك',
  'hud.hintChat': 'الدردشة',
  'hud.hintMic': 'الميكروفون',
  'hud.hintView': 'المشهد',
  'hud.hintJump': 'القفز',
  'hud.hintSprint': 'الركض',
  'hud.hintMenu': 'القائمة',

  // Main menu
  'menu.title': 'القائمة',
  'menu.avatar': 'الأفاتار',
  'menu.world': 'العالم',
  'menu.objects': 'العناصر',
  'menu.room': 'الغرفة',
  'menu.settings': 'الإعدادات',
  'menu.leave': 'مغادرة',
  'menu.close': 'إغلاق',

  // Avatar panel
  'avatar.title': 'الأفاتار',
  'avatar.subtitle': 'اختر أفاتار VRM أو ارفع واحدًا.',
  'avatar.upload': 'رفع VRM',
  'avatar.uploading': 'جارٍ التحميل…',
  'avatar.default': 'افتراضي',
  'avatar.equip': 'ارتداء',
  'avatar.equipped': 'مُرتدى',
  'avatar.remove': 'إزالة',
  'avatar.selectPrompt': 'اختر أفاتار لمعاينته.',
  'avatar.name': 'الاسم',
  'avatar.author': 'المؤلف',
  'avatar.license': 'الترخيص',
  'avatar.invalid': 'هذا الملف ليس أفاتار VRM صالحًا.',
  'avatar.saved': 'تم الحفظ في أفاتاراتك.',

  // World panel
  'world.title': 'العالم',
  'world.subtitle': 'حمّل بيئة ثلاثية الأبعاد لكل من في الغرفة.',
  'world.upload': 'رفع عالم',
  'world.uploading': 'جارٍ تحميل العالم…',
  'world.apply': 'تطبيق للجميع',
  'world.applied': 'تم التطبيق',
  'world.reset': 'إعادة للافتراضي',
  'world.default': 'الشبكة الافتراضية',
  'world.selectPrompt': 'اختر عالمًا لمعاينته.',
  'world.name': 'الاسم',
  'world.format': 'الصيغة',
  'world.invalid': 'صيغة عالم غير مدعومة. استخدم GLB أو GLTF أو PLY أو SPLAT أو KSPLAT.',
  'world.hint': 'مجسمات GLB / GLTF ومشاهد Gaussian-splat مدعومة.',

  // Objects panel
  'objects.title': 'العناصر',
  'objects.subtitle': 'ضع عناصر ثلاثية الأبعاد مشتركة في العالم.',
  'objects.upload': 'رفع نموذج',
  'objects.uploading': 'جارٍ تحميل النموذج…',
  'objects.place': 'ضعه أمامي',
  'objects.placed': 'تم الوضع',
  'objects.remove': 'إزالة',
  'objects.clear': 'مسح الكل',
  'objects.selectPrompt': 'اختر نموذجًا لوضعه.',
  'objects.count': '{count} موضوعة',
  'objects.empty': 'لا توجد عناصر موضوعة بعد.',
  'objects.invalid': 'هذا الملف ليس نموذج GLTF / GLB صالحًا.',

  // Room panel
  'room.title': 'الغرفة',
  'room.subtitle': 'ادعُ آخرين أو بدّل الغرف.',
  'room.current': 'الغرفة الحالية',
  'room.inviteUrl': 'رابط الدعوة',
  'room.copy': 'نسخ الرابط',
  'room.copied': 'تم النسخ!',
  'room.idLabel': 'اسم الغرفة',
  'room.idPlaceholder': 'اكتب اسم غرفة',
  'room.enter': 'دخول',
  'room.create': 'إنشاء',
  'room.random': 'عشوائية',
  'room.switchHint': 'تبديل الغرف يفصلك عن الغرفة الحالية.',
  'room.visibility.label': 'الظهور',
  'room.visibility.public': 'عامة (يمكن لأي شخص اكتشافها)',
  'room.visibility.private': 'خاصة (فقط لمن يعرف المعرف)',

  // Discover panel
  'discover.title': 'الغرف العامة',
  'discover.empty': 'لم يتم العثور على أي غرف عامة بعد.',
  'discover.join': 'انضمام',
  'discover.peers': '{count} متصل',
  'discover.justNow': 'الآن',
  'discover.secondsAgo': 'منذ {count} ثانية',

  // Settings panel
  'settings.title': 'الإعدادات',
  'settings.displayName': 'الاسم المعروض',
  'settings.color': 'اللون المميز',
  'settings.language': 'اللغة',
  'settings.quality': 'جودة الرسوم',
  'settings.qualityLow': 'منخفضة',
  'settings.qualityMedium': 'متوسطة',
  'settings.qualityHigh': 'عالية',
  'settings.save': 'حفظ',
  'settings.saved': 'تم الحفظ',

  // Chat
  'chat.placeholder': 'قل شيئًا…',
  'chat.send': 'إرسال',
  'chat.open': 'فتح الدردشة',
  'chat.close': 'إغلاق الدردشة',

  // Common
  'common.close': 'إغلاق',
  'common.cancel': 'إلغاء',
  'common.ok': 'حسنًا',
  'common.loading': 'جارٍ التحميل…',
  'common.error': 'حدث خطأ ما.',
  'common.copy': 'نسخ',
  'common.copied': 'تم النسخ',
  'common.retry': 'إعادة المحاولة',
}

export default ar
