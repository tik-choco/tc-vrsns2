export type VersionStamp = {
  updatedAt: string
  nodeId: string
}

export type FolderColor = 'teal' | 'blue' | 'amber' | 'rose' | 'slate'

export type FolderRecord = {
  id: string
  name: string
  parentId: string | null
  sortOrder?: number
  color: FolderColor
  encrypted: boolean
  shareEnabled: boolean
  sharedRoomId: string
  lastCid?: string
  lastSavedAt?: string
  lastSharedAt?: string
  deletedAt?: string
  createdAt: string
  updatedAt: string
  fieldVersions?: Record<string, VersionStamp>
}

export type FileRecord = {
  id: string
  folderId: string
  sortOrder?: number
  name: string
  mimeType: string
  size: number
  dataUrl?: string
  checksum: string
  version: number
  starred: boolean
  lastCid?: string
  lastShareCid?: string
  deletedAt?: string
  createdAt: string
  updatedAt: string
  fieldVersions?: Record<string, VersionStamp>
}

export type ActivityEntry = {
  id: string
  folderId?: string
  fileId?: string
  actorNodeId: string
  action: string
  detail: string
  at: string
}

export type StorageSnapshot = {
  folders: FolderRecord[]
  files: FileRecord[]
  activity: ActivityEntry[]
  clock: number
  originNode: string
}

export type FolderBundle = {
  version: 1
  exportedAt: string
  originNode: string
  folder: FolderRecord
  folders?: FolderRecord[]
  files: FileRecord[]
}

export type FileBundle = {
  version: 1
  exportedAt: string
  originNode: string
  folder: FolderRecord
  file: FileRecord
}

export function makeId(prefix: string): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}-${cryptoApi.randomUUID()}`
  const bytes = new Uint8Array(8)
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return `${prefix}-${Date.now().toString(36)}-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function createInitialSnapshot(nodeId: string): StorageSnapshot {
  const now = new Date().toISOString()
  return {
    folders: [],
    files: [],
    activity: [
      {
        id: makeId('activity'),
        actorNodeId: nodeId,
        action: 'init',
        detail: 'TC Storage workspace created',
        at: now,
      },
    ],
    clock: 1,
    originNode: nodeId,
  }
}

export function makeFolder(options: {
  id?: string
  name: string
  parentId: string | null
  color: FolderColor
  roomId: string
  now: string
  nodeId: string
}): FolderRecord {
  const folder: FolderRecord = {
    id: options.id ?? makeId('folder'),
    name: options.name,
    parentId: options.parentId,
    sortOrder: Date.parse(options.now),
    color: options.color,
    encrypted: true,
    shareEnabled: false,
    sharedRoomId: options.roomId,
    createdAt: options.now,
    updatedAt: options.now,
  }
  return stampAll(folder, options.now, options.nodeId)
}

export function makeFileFromDataUrl(options: {
  id?: string
  folderId: string
  name: string
  mimeType: string
  size: number
  dataUrl: string
  checksum: string
  now: string
  nodeId: string
}): FileRecord {
  const file: FileRecord = {
    id: options.id ?? makeId('file'),
    folderId: options.folderId,
    sortOrder: Date.parse(options.now),
    name: options.name,
    mimeType: options.mimeType,
    size: options.size,
    dataUrl: options.dataUrl,
    checksum: options.checksum,
    version: 1,
    starred: false,
    createdAt: options.now,
    updatedAt: options.now,
  }
  return stampAll(file, options.now, options.nodeId)
}

export function touchSnapshot(snapshot: StorageSnapshot, originNode: string): StorageSnapshot {
  return { ...snapshot, clock: snapshot.clock + 1, originNode }
}

export function activeFolders(snapshot: StorageSnapshot): FolderRecord[] {
  return snapshot.folders.filter((folder) => !folder.deletedAt).sort(compareFoldersForDisplay)
}

export function activeFiles(snapshot: StorageSnapshot): FileRecord[] {
  return snapshot.files.filter((file) => !file.deletedAt).sort(compareFilesForDisplay)
}

export function filesInFolder(snapshot: StorageSnapshot, folderId: string): FileRecord[] {
  return activeFiles(snapshot)
    .filter((file) => file.folderId === folderId)
    .sort(compareFilesForDisplay)
}

export function childFolders(snapshot: StorageSnapshot, parentId: string | null): FolderRecord[] {
  return activeFolders(snapshot)
    .filter((folder) => folder.parentId === parentId)
    .sort(compareFoldersForDisplay)
}

export function compareFoldersForDisplay(a: FolderRecord, b: FolderRecord): number {
  return compareSortOrder(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

export function compareFilesForDisplay(a: FileRecord, b: FileRecord): number {
  return compareSortOrder(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

export function folderPath(snapshot: StorageSnapshot, folderId: string): FolderRecord[] {
  const folders = activeFolders(snapshot)
  const path: FolderRecord[] = []
  const visited = new Set<string>()
  let current = folders.find((folder) => folder.id === folderId)
  while (current) {
    if (visited.has(current.id)) break
    visited.add(current.id)
    path.unshift(current)
    current = current.parentId ? folders.find((folder) => folder.id === current?.parentId) : undefined
  }
  return path
}

export function addActivity(
  snapshot: StorageSnapshot,
  entry: Omit<ActivityEntry, 'id' | 'at'>,
  at = new Date().toISOString(),
): StorageSnapshot {
  const activity = [{ ...entry, id: makeId('activity'), at }, ...snapshot.activity].slice(0, 40)
  return { ...snapshot, activity }
}

export function stripFileContent(file: FileRecord): FileRecord {
  const { dataUrl: _dataUrl, fieldVersions, ...rest } = file
  if (!fieldVersions?.dataUrl) return rest
  const { dataUrl: _dataUrlVersion, ...versions } = fieldVersions
  return { ...rest, fieldVersions: versions }
}

export function stripSnapshotFileContent(snapshot: StorageSnapshot): StorageSnapshot {
  return { ...snapshot, files: snapshot.files.map(stripFileContent) }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
}

function stampAll<T extends { fieldVersions?: Record<string, VersionStamp>; updatedAt: string }>(
  record: T,
  updatedAt: string,
  nodeId: string,
): T {
  const fieldVersions: Record<string, VersionStamp> = {}
  for (const key of Object.keys(record)) {
    if (key !== 'fieldVersions') fieldVersions[key] = { updatedAt, nodeId }
  }
  return { ...record, fieldVersions }
}

function compareSortOrder(a: { sortOrder?: number; createdAt: string }, b: { sortOrder?: number; createdAt: string }): number {
  const left = Number.isFinite(a.sortOrder) ? a.sortOrder as number : 0
  const right = Number.isFinite(b.sortOrder) ? b.sortOrder as number : 0
  return left - right
}
