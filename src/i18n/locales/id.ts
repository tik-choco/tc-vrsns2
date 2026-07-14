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
  'hud.hintJump': 'Lompat',
  'hud.hintSprint': 'Lari',
  'hud.hintMenu': 'Menu',

  // Main menu
  'menu.title': 'Menu',
  'menu.avatar': 'Avatar',
  'menu.world': 'Dunia',
  'menu.objects': 'Objek',
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

  // Objects panel
  'objects.title': 'Objek',
  'objects.subtitle': 'Tempatkan objek 3D bersama di dunia.',
  'objects.upload': 'Unggah model',
  'objects.uploading': 'Memuat model…',
  'objects.place': 'Tempatkan di depanku',
  'objects.placed': 'Ditempatkan',
  'objects.remove': 'Hapus',
  'objects.clear': 'Hapus semua',
  'objects.selectPrompt': 'Pilih model untuk ditempatkan.',
  'objects.count': '{count} ditempatkan',
  'objects.empty': 'Belum ada objek yang ditempatkan.',
  'objects.invalid': 'File itu bukan model GLTF / GLB yang valid.',

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
