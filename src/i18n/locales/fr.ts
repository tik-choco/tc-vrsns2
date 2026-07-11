// Français (French). Keys mirror ./en.ts; any omitted key falls back to English.

import type { Dict } from './en'

export const fr: Dict = {
  // App / shell
  'app.title': 'TC Space',
  'app.tagline': 'Un métavers pair à pair : pas de serveurs, juste des gens.',

  // Join screen
  'join.heading': 'Entrer dans le monde',
  'join.roomLabel': 'Salon',
  'join.roomPlaceholder': 'lobby',
  'join.roomHint': 'Lettres, chiffres, tiret et tiret bas. Jusqu\'à 64 caractères.',
  'join.nameLabel': 'Nom affiché',
  'join.namePlaceholder': 'Votre nom',
  'join.colorLabel': 'Couleur d\'accent',
  'join.languageLabel': 'Langue',
  'join.join': 'Rejoindre',
  'join.connecting': 'Connexion…',
  'join.random': 'Salon aléatoire',
  'join.recent': 'Récents',
  'join.roomInvalid': 'Le nom du salon n\'accepte que lettres, chiffres, tiret et tiret bas (max. 64).',
  'join.nameRequired': 'Saisissez un nom affiché.',

  // HUD
  'hud.peers': '{count} en ligne',
  'hud.you': 'Vous',
  'hud.voiceOn': 'Micro activé',
  'hud.voiceMuted': 'Micro coupé',
  'hud.voiceError': 'Erreur de micro',
  'hud.voiceRequesting': 'Demande du micro…',
  'hud.hintMove': 'Se déplacer',
  'hud.hintChat': 'Chat',
  'hud.hintMic': 'Micro',
  'hud.hintView': 'Vue',
  'hud.hintJump': 'Sauter',
  'hud.hintSprint': 'Courir',
  'hud.hintMenu': 'Menu',

  // Main menu
  'menu.title': 'Menu',
  'menu.avatar': 'Avatar',
  'menu.world': 'Monde',
  'menu.objects': 'Objets',
  'menu.room': 'Salon',
  'menu.settings': 'Paramètres',
  'menu.leave': 'Quitter',
  'menu.close': 'Fermer',

  // Avatar panel
  'avatar.title': 'Avatar',
  'avatar.subtitle': 'Choisissez ou importez un avatar VRM.',
  'avatar.upload': 'Importer un VRM',
  'avatar.uploading': 'Chargement…',
  'avatar.default': 'Par défaut',
  'avatar.equip': 'Équiper',
  'avatar.equipped': 'Équipé',
  'avatar.remove': 'Retirer',
  'avatar.selectPrompt': 'Sélectionnez un avatar pour l\'aperçu.',
  'avatar.name': 'Nom',
  'avatar.author': 'Auteur',
  'avatar.license': 'Licence',
  'avatar.invalid': 'Ce fichier n\'est pas un VRM valide.',
  'avatar.saved': 'Enregistré dans vos avatars.',

  // World panel
  'world.title': 'Monde',
  'world.subtitle': 'Chargez un environnement 3D pour tout le salon.',
  'world.upload': 'Importer un monde',
  'world.uploading': 'Chargement du monde…',
  'world.apply': 'Appliquer à tous',
  'world.applied': 'Appliqué',
  'world.reset': 'Réinitialiser',
  'world.default': 'Grille par défaut',
  'world.selectPrompt': 'Sélectionnez un monde pour l\'aperçu.',
  'world.name': 'Nom',
  'world.format': 'Format',
  'world.invalid': 'Format de monde non pris en charge. Utilisez GLB, GLTF, PLY, SPLAT ou KSPLAT.',
  'world.hint': 'Les maillages GLB / GLTF et les scènes Gaussian-splat sont pris en charge.',

  // Objects panel
  'objects.title': 'Objets',
  'objects.subtitle': 'Placez des objets 3D partagés dans le monde.',
  'objects.upload': 'Importer un modèle',
  'objects.uploading': 'Chargement du modèle…',
  'objects.place': 'Placer devant moi',
  'objects.placed': 'Placé',
  'objects.remove': 'Retirer',
  'objects.clear': 'Tout effacer',
  'objects.selectPrompt': 'Sélectionnez un modèle à placer.',
  'objects.count': '{count} placés',
  'objects.empty': 'Aucun objet placé pour l\'instant.',
  'objects.invalid': 'Ce fichier n\'est pas un modèle GLTF / GLB valide.',

  // Room panel
  'room.title': 'Salon',
  'room.subtitle': 'Invitez d\'autres personnes ou changez de salon.',
  'room.current': 'Salon actuel',
  'room.inviteUrl': 'Lien d\'invitation',
  'room.copy': 'Copier le lien',
  'room.copied': 'Copié !',
  'room.idLabel': 'Nom du salon',
  'room.idPlaceholder': 'Saisissez un nom de salon',
  'room.enter': 'Entrer',
  'room.create': 'Créer',
  'room.random': 'Aléatoire',
  'room.switchHint': 'Changer de salon vous déconnecte du salon actuel.',

  // Settings panel
  'settings.title': 'Paramètres',
  'settings.displayName': 'Nom affiché',
  'settings.color': 'Couleur d\'accent',
  'settings.language': 'Langue',
  'settings.quality': 'Qualité graphique',
  'settings.qualityLow': 'Basse',
  'settings.qualityMedium': 'Moyenne',
  'settings.qualityHigh': 'Haute',
  'settings.save': 'Enregistrer',
  'settings.saved': 'Enregistré',

  // Chat
  'chat.placeholder': 'Dites quelque chose…',
  'chat.send': 'Envoyer',
  'chat.open': 'Ouvrir le chat',
  'chat.close': 'Fermer le chat',

  // Common
  'common.close': 'Fermer',
  'common.cancel': 'Annuler',
  'common.ok': 'OK',
  'common.loading': 'Chargement…',
  'common.error': 'Une erreur est survenue.',
  'common.copy': 'Copier',
  'common.copied': 'Copié',
  'common.retry': 'Réessayer',
}

export default fr
