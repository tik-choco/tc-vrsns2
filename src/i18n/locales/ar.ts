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
  'join.errorRenderer': 'هذا الجهاز لا يمكنه عرض المحتوى ثلاثي الأبعاد — WebGL غير متاح أو محظور.',
  'join.errorTimeout': 'استغرقت إعادة الاتصال وقتًا طويلاً جدًا. حاول الانضمام مرة أخرى.',

  // Resume
  'resume.message': 'جارٍ استئناف غرفتك الأخيرة "{roomId}"…',

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
  'hud.hintEdit': 'تحرير',
  'hud.hintJump': 'القفز',
  'hud.hintSprint': 'الركض',
  'hud.hintCrouch': 'الانحناء',
  'hud.hintMenu': 'القائمة',
  'hud.locked': 'العالم مقفل',
  'hud.openEditing': 'يمكن للجميع التعديل',

  // Main menu
  'menu.title': 'القائمة',
  'menu.avatar': 'الأفاتار',
  'menu.world': 'العالم',
  'menu.objects': 'العناصر',
  'panel.characters': 'الشخصيات',
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
  // R6: تسمية توضح مصدر أفاتار لم ترفعه أنت بنفسك (شخصية من tc-town أو رفعها
  // شخص آخر) حتى لا يبدو وكأنه ملكك.
  'avatar.foreignSource': 'شخصية {name}',
  'avatar.foreignUnknown': 'شخص آخر',

  // Characters panel (R5: وضع شخصية من tc-town في العالم كشخصية غير قابلة للعب)
  'characters.title': 'الشخصيات',
  'characters.empty': 'لا توجد شخصيات بعد.',
  'characters.hint': 'تُنشأ الشخصيات في tc-town. بمجرد إنشاء واحدة هناك، ستظهر هنا.',
  'characters.place': 'وضع في العالم',
  'characters.noVrm': 'لا يتوفر أفاتار VRM لهذه الشخصية.',
  'characters.fromTown': 'من tc-town',

  // NPC (شخصية موضوعة تردّ في الدردشة)
  'npc.badge': 'NPC',
  'npc.radius': 'نطاق السمع',
  'npc.radiusValue': '{n} م',
  'npc.voice': 'الصوت',
  'npc.voiceDefault': 'افتراضي (إعدادات AI)',
  'npc.voiceHelp': 'يؤدي المسح إلى استخدام الصوت الافتراضي من إعدادات AI، وليس الصوت الأصلي للشخصية في tc-town.',

  // AI panel
  'settings.ai.npcPreset': 'ردود الشخصيات (NPC)',
  'settings.ai.npcPresetHelp': 'يردّ بشخصية الشخصية عندما يتحدث أحدهم بالقرب من شخصية وضعتها في العالم.',

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
  'world.autosaveHint': 'تُحفَظ هذه الغرفة تلقائيًا على هذا الجهاز وتعود عند رجوعك.',
  'world.policyLabel': 'من يمكنه تعديل هذا العالم',
  'world.policyOwner': 'من وضعه فقط',
  'world.policyEveryone': 'الجميع',
  'world.policyLocked': 'مقفل',
  'world.policyOwnerHint': 'يمكن للجميع الإضافة، لكن التحريك أو الحذف لمن وضع الشيء فقط.',
  'world.policyEveryoneHint': 'يمكن لأي شخص في الغرفة تحريك ما وُضع أو تغيير حجمه أو حذفه.',
  'world.policyLockedHint': 'لا يمكن لأحد تغيير البيئة ولا لمس ما وُضع.',
  'world.lockedNotice': 'هذا العالم مقفل. غيّر الإعداد أعلاه للتعديل.',

  // Objects panel
  'objects.title': 'العناصر',
  'objects.subtitle': 'ضع عناصر وصورًا وفيديو وصوتًا مشتركة في العالم.',
  'objects.upload': 'رفع ملف',
  'objects.uploading': 'جارٍ تحميل الملف…',
  'objects.place': 'ضعه أمامي',
  'objects.placed': 'تم الوضع',
  'objects.remove': 'إزالة',
  'objects.clear': 'مسح الكل',
  'objects.selectPrompt': 'اختر عنصرًا لوضعه.',
  'objects.count': '{count} موضوعة',
  'objects.empty': 'لا توجد عناصر موضوعة بعد.',
  'objects.hint': 'يدعم نماذج GLB / GLTF والصور والفيديو والصوت. يُشغَّل الفيديو والصوت مكانيًا، فيخفت الصوت مع المسافة.',
  'objects.invalid': 'تعذّرت قراءة هذا الملف كنموذج أو صورة أو فيديو أو صوت.',
  'objects.tooLarge': 'هذا الملف كبير جدًا. الحد هو {size} ميغابايت.',
  'objects.edit': 'تعديل الموضوعة',
  'objects.editing': 'تعديل الكائنات الموضوعة',
  'objects.editHint': 'انقر على شيء وضعته أنت. اضغط الزر الأيمن مع الاستمرار للنظر حولك.',
  'objects.editDone': 'تم',
  'objects.deleteOne': 'حذف',
  'objects.move': 'تحريك',
  'objects.rotate': 'تدوير',
  'objects.scale': 'تحجيم',
  'objects.size': 'الحجم',
  'objects.placedBy': 'وضعه {name}',
  'objects.orphans': '{count} تركها أشخاص غادروا. تبقى حتى تخرج من الغرفة ولا يمكن لأحد تعديلها.',

  // مستوى الصوت / نطاق السماع — لعناصر الصوت والفيديو فقط، يُضبطان من شريط
  // التحرير (EditToolbar.tsx)
  'objects.volume': 'مستوى الصوت',
  'objects.volumeValue': '{n}%',
  'objects.range': 'نطاق السماع',
  'objects.rangeValue': '{n} م',

  // نافذة استيراد السحب والإفلات — عند إسقاط ملف في أي مكان من التطبيق
  'dropImport.title': 'هل تريد إضافة هذا إلى عالمك؟',
  'dropImport.descAvatar': 'سيتم ارتداؤه كأفاتار لك.',
  'dropImport.descModel': 'سيتم وضعه في العالم كنموذج ثلاثي الأبعاد.',
  'dropImport.descImage': 'سيتم وضعه في العالم كصورة.',
  'dropImport.descVideo': 'سيتم وضعه في العالم كشاشة فيديو.',
  'dropImport.descAudio': 'سيتم وضعه في العالم كصوت.',
  'dropImport.descWorld': 'سيصبح البيئة التي يراها الجميع في الغرفة.',
  'dropImport.addToWorld': 'إضافة إلى العالم',
  'dropImport.setAsWorldEnvironment': 'أو تعيينه كبيئة العالم بدلاً من ذلك',
  'dropImport.saveOnly': 'الحفظ في المخزون فقط',
  'dropImport.unsupportedTitle': 'تعذّرت إضافة هذا الملف',
  'dropImport.unsupportedBody': '"{fileName}" ليس ملف أفاتار أو عالم أو عنصر يمكن لهذا التطبيق استخدامه.',

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
