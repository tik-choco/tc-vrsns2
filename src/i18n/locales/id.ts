// Bahasa Indonesia (Indonesian). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const id: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'Metaverse peer-to-peer — tanpa server, hanya orang.',

  // Join screen
  'join.heading': 'Masuk ke dunia',
  'join.roomLabel': 'Ruang',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Huruf, angka, tanda hubung, dan garis bawah. Maksimal 64 karakter.',
  'join.nameLabel': 'Nama tampilan',
  'join.namePlaceholder': 'Nama kamu',
  'join.colorLabel': 'Warna aksen',
  'join.languageLabel': 'Bahasa',
  'join.join': 'Gabung',
  'join.connecting': 'Menghubungkan…',
  'join.random': 'Ruang acak',
  'join.recent': 'Terbaru',
  'join.roomInvalid': 'Nama ruang hanya boleh berisi huruf, angka, tanda hubung, dan garis bawah (maks. 64).',
  'join.nameRequired': 'Masukkan nama tampilan.',
  'join.makePublic': 'Gabung sebagai ruang publik',
  'join.errorRenderer': 'Perangkat ini tidak bisa menampilkan 3D — WebGL tidak tersedia atau diblokir.',
  'join.errorTimeout': 'Menyambung ulang terlalu lama. Coba gabung lagi.',

  // Resume
  'resume.message': 'Melanjutkan ruang terakhirmu "{roomId}"…',

  // HUD
  'hud.peers': '{count} online',
  'hud.you': 'Kamu',
  'hud.voiceOn': 'Suara aktif',
  'hud.voiceMuted': 'Suara dibisukan',
  'hud.voiceError': 'Kesalahan mikrofon',
  'hud.voiceRequesting': 'Meminta mikrofon…',
  'hud.hintMove': 'Gerak',
  'hud.hintChat': 'Obrolan',
  'hud.hintMic': 'Mikrofon',
  'hud.hintView': 'Tampilan',
  'hud.hintEdit': 'Edit',
  'hud.hintJump': 'Lompat',
  'hud.hintSprint': 'Lari',
  'hud.hintMenu': 'Menu',
  'hud.locked': 'Dunia terkunci',
  'hud.openEditing': 'Semua boleh mengedit',

  // Main menu
  'menu.title': 'Menu',
  'menu.avatar': 'Avatar',
  'menu.world': 'Dunia',
  'menu.objects': 'Objek',
  'panel.characters': 'Karakter',
  'menu.room': 'Ruang',
  'menu.settings': 'Pengaturan',
  'menu.leave': 'Keluar',
  'menu.close': 'Tutup',

  // Avatar panel
  'avatar.title': 'Avatar',
  'avatar.subtitle': 'Pilih atau unggah avatar VRM.',
  'avatar.upload': 'Unggah VRM',
  'avatar.uploading': 'Memuat…',
  'avatar.default': 'Bawaan',
  'avatar.equip': 'Pakai',
  'avatar.equipped': 'Dipakai',
  'avatar.remove': 'Hapus',
  'avatar.selectPrompt': 'Pilih avatar untuk pratinjau.',
  'avatar.name': 'Nama',
  'avatar.author': 'Pembuat',
  'avatar.license': 'Lisensi',
  'avatar.invalid': 'File itu bukan VRM yang valid.',
  'avatar.saved': 'Tersimpan ke avatar kamu.',
  // R6: label sumber untuk avatar yang bukan kamu unggah sendiri (karakter
  // tc-town atau unggahan orang lain), supaya tidak pernah terlihat seperti
  // milikmu sendiri.
  'avatar.foreignSource': 'Karakter {name}',
  'avatar.foreignUnknown': 'orang lain',

  // Characters panel (R5: menempatkan karakter tc-town sebagai NPC di dunia)
  'characters.title': 'Karakter',
  'characters.empty': 'Belum ada karakter.',
  'characters.hint': 'Karakter dibuat di tc-town. Setelah kamu membuatnya di sana, karakter itu akan muncul di sini.',
  'characters.place': 'Tempatkan di dunia',
  'characters.noVrm': 'Tidak ada avatar VRM yang tersedia untuk karakter ini.',
  'characters.fromTown': 'Dari tc-town',

  // NPC (karakter yang ditempatkan dan membalas di obrolan)
  'npc.badge': 'NPC',
  'npc.radius': 'Radius pendengaran',
  'npc.radiusValue': '{n} m',
  'npc.voice': 'Suara',
  'npc.voiceDefault': 'Bawaan (pengaturan AI)',
  'npc.voiceHelp': 'Mengosongkannya akan menggunakan suara bawaan dari pengaturan AI, bukan suara asli karakter di tc-town.',

  // AI panel
  'settings.ai.npcPreset': 'Balasan NPC',
  'settings.ai.npcPresetHelp': 'Menjawab sesuai karakter saat seseorang berbicara di dekat karakter yang kamu tempatkan di dunia.',

  // World panel
  'world.title': 'Dunia',
  'world.subtitle': 'Muat lingkungan 3D untuk semua orang di ruang ini.',
  'world.upload': 'Unggah dunia',
  'world.uploading': 'Memuat dunia…',
  'world.apply': 'Terapkan untuk semua',
  'world.applied': 'Diterapkan',
  'world.reset': 'Setel ulang',
  'world.default': 'Grid bawaan',
  'world.selectPrompt': 'Pilih dunia untuk pratinjau.',
  'world.name': 'Nama',
  'world.format': 'Format',
  'world.invalid': 'Format dunia tidak didukung. Gunakan GLB, GLTF, PLY, SPLAT, atau KSPLAT.',
  'world.hint': 'Mesh GLB / GLTF dan scene Gaussian-splat didukung.',
  'world.autosaveHint': 'Ruang ini tersimpan otomatis di perangkat ini dan kembali saat kamu datang lagi.',
  'world.policyLabel': 'Siapa yang boleh mengedit dunia ini',
  'world.policyOwner': 'Hanya yang menempatkan',
  'world.policyEveryone': 'Semua orang',
  'world.policyLocked': 'Terkunci',
  'world.policyOwnerHint': 'Siapa pun boleh menambah, tetapi hanya yang menempatkan boleh memindah atau menghapus.',
  'world.policyEveryoneHint': 'Siapa pun di ruang ini boleh memindah, mengubah ukuran, atau menghapus yang sudah ditempatkan.',
  'world.policyLockedHint': 'Tidak ada yang boleh mengubah lingkungan atau menyentuh yang sudah ditempatkan.',
  'world.lockedNotice': 'Dunia ini terkunci. Ubah pengaturan di atas untuk mengedit.',

  // Objects panel
  'objects.title': 'Objek',
  'objects.subtitle': 'Tempatkan objek, gambar, video, dan suara bersama di dunia.',
  'objects.upload': 'Unggah berkas',
  'objects.uploading': 'Memuat berkas…',
  'objects.place': 'Tempatkan di depanku',
  'objects.placed': 'Ditempatkan',
  'objects.remove': 'Hapus',
  'objects.clear': 'Hapus semua',
  'objects.selectPrompt': 'Pilih sesuatu untuk ditempatkan.',
  'objects.count': '{count} ditempatkan',
  'objects.empty': 'Belum ada objek yang ditempatkan.',
  'objects.hint': 'Mendukung model GLB / GLTF, gambar, video, dan audio. Video dan audio diputar secara posisional, jadi suaranya meredup seiring jarak.',
  'objects.invalid': 'Berkas itu tidak bisa dibaca sebagai model, gambar, video, atau audio.',
  'objects.tooLarge': 'Berkas itu terlalu besar. Batasnya {size} MB.',
  'objects.edit': 'Edit yang ditempatkan',
  'objects.editing': 'Mengedit objek yang ditempatkan',
  'objects.editHint': 'Klik sesuatu yang kamu tempatkan. Tahan tombol kanan untuk melihat sekeliling.',
  'objects.editDone': 'Selesai',
  'objects.deleteOne': 'Hapus',
  'objects.move': 'Pindah',
  'objects.rotate': 'Putar',
  'objects.scale': 'Ubah ukuran',
  'objects.placedBy': 'ditempatkan oleh {name}',
  'objects.orphans': '{count} ditinggalkan orang yang sudah pergi. Tetap ada sampai kamu keluar dari ruang, dan tidak ada yang bisa mengeditnya.',

  // Room panel
  'room.title': 'Ruang',
  'room.subtitle': 'Undang orang lain atau pindah ruang.',
  'room.current': 'Ruang saat ini',
  'room.inviteUrl': 'Tautan undangan',
  'room.copy': 'Salin tautan',
  'room.copied': 'Tersalin!',
  'room.idLabel': 'Nama ruang',
  'room.idPlaceholder': 'Ketik nama ruang',
  'room.enter': 'Masuk',
  'room.create': 'Buat',
  'room.random': 'Acak',
  'room.switchHint': 'Berpindah ruang akan memutus koneksimu dari ruang saat ini.',
  'room.visibility.label': 'Visibilitas',
  'room.visibility.public': 'Publik (dapat ditemukan siapa saja)',
  'room.visibility.private': 'Privat (hanya yang tahu ID)',

  // Discover panel
  'discover.title': 'Ruang publik',
  'discover.empty': 'Belum ada ruang publik yang ditemukan.',
  'discover.join': 'Gabung',
  'discover.peers': '{count} online',
  'discover.justNow': 'Baru saja',
  'discover.secondsAgo': '{count} detik lalu',

  // Settings panel
  'settings.title': 'Pengaturan',
  'settings.displayName': 'Nama tampilan',
  'settings.color': 'Warna aksen',
  'settings.language': 'Bahasa',
  'settings.quality': 'Kualitas grafis',
  'settings.qualityLow': 'Rendah',
  'settings.qualityMedium': 'Sedang',
  'settings.qualityHigh': 'Tinggi',
  'settings.save': 'Simpan',
  'settings.saved': 'Tersimpan',

  // Chat
  'chat.placeholder': 'Ketik sesuatu…',
  'chat.send': 'Kirim',
  'chat.open': 'Buka obrolan',
  'chat.close': 'Tutup obrolan',

  // Common
  'common.close': 'Tutup',
  'common.cancel': 'Batal',
  'common.ok': 'OK',
  'common.loading': 'Memuat…',
  'common.error': 'Terjadi kesalahan.',
  'common.copy': 'Salin',
  'common.copied': 'Tersalin',
  'common.retry': 'Coba lagi',
}

export default id
