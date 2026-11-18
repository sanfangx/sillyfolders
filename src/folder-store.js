/**
 * Pure state and folder-tree operations shared by both Character Folders and Chat Folders.
 */

export const EXTENSION_SETTINGS_KEY = 'st_folders';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    language: 'auto',
    hideFolderedCharsInRoot: true,
    hideFolderedChatsInRoot: true,
    charFolders: [],
    charAssignments: {},
    recentFolders: [],
    recentAssignments: {},
    chatFoldersByScope: {},
    chatAssignmentsByScope: {},
});

export const FOLDER_COLORS = Object.freeze([
    { id: 'default', hex: '' },
    { id: 'blue', hex: '#4f86f7' },
    { id: 'teal', hex: '#2bbbad' },
    { id: 'green', hex: '#52b788' },
    { id: 'amber', hex: '#e9a83a' },
    { id: 'coral', hex: '#e06c75' },
    { id: 'purple', hex: '#9b72cf' },
    { id: 'pink', hex: '#d96b98' },
]);

/**
 * Generates a unique folder ID.
 * @param {() => string} [uuidFn]
 * @returns {string}
 */
export function generateFolderId(uuidFn) {
    if (typeof uuidFn === 'function') {
        return `fld_${uuidFn()}`;
    }
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return `fld_${globalThis.crypto.randomUUID()}`;
    }
    return `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Normalizes a chat file name by removing any trailing `.jsonl` extension.
 * @param {string} fileName
 * @returns {string}
 */
export function stripJsonlExt(fileName) {
    return String(fileName ?? '').trim().replace(/\.jsonl$/i, '');
}

/**
 * Builds the canonical character assignment key.
 * @param {string} avatar
 * @returns {string}
 */
export function makeCharKey(avatar) {
    return `char:${String(avatar ?? '')}`;
}

/**
 * Builds the canonical group assignment key.
 * @param {string} groupId
 * @returns {string}
 */
export function makeGroupKey(groupId) {
    return `group:${String(groupId ?? '')}`;
}

/**
 * Builds a composite assignment key for Recent Chats (`char:<avatar>::<chat>` or `group:<id>::<chat>`).
 * @param {string} scopeKey
 * @param {string} chatFileName
 * @returns {string}
 */
export function makeRecentChatKey(scopeKey, chatFileName) {
    const cleanScope = String(scopeKey ?? '').trim();
    const cleanChat = stripJsonlExt(chatFileName);
    if (!cleanScope || !cleanChat) return '';
    return `${cleanScope}::${cleanChat}`;
}

/**
 * Parses a composite Recent Chat assignment key into `{ scopeKey, chatKey }`.
 * @param {string} compositeKey
 * @returns {{ scopeKey: string, chatKey: string } | null}
 */
export function parseRecentChatKey(compositeKey) {
    const str = String(compositeKey ?? '');
    const sepIndex = str.indexOf('::');
    if (sepIndex <= 0) return null;
    const scopeKey = str.slice(0, sepIndex).trim();
    const chatKey = stripJsonlExt(str.slice(sepIndex + 2));
    if (!scopeKey || !chatKey) return null;
    return { scopeKey, chatKey };
}

/**
 * Determines the current chat scope key (`char:<avatar>` or `group:<groupId>`).
 * @param {{ groupId?: string|null, characterId?: number|string|null, characters?: Array<{avatar?: string}> }} context
 * @returns {string|null}
 */
export function getChatScopeKey(context) {
    if (!context) return null;
    if (context.groupId) {
        return makeGroupKey(context.groupId);
    }
    if (context.characterId !== undefined && context.characterId !== null) {
        const idx = Number(context.characterId);
        const char = context.characters?.[idx];
        if (char?.avatar) {
            return makeCharKey(char.avatar);
        }
    }
    return null;
}

/**
 * Sanitizes an array of folder objects in place/cloned form.
 * @param {unknown} rawFolders
 * @returns {Array<{id: string, name: string, parentId: string|null, color: string, sortOrder: number, createdAt: number}>}
 */
function sanitizeFolderList(rawFolders) {
    if (!Array.isArray(rawFolders)) return [];
    const seen = new Set();
    const cleaned = [];

    for (const item of rawFolders) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '';
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        cleaned.push({
            id,
            name: name.slice(0, 80),
            parentId: typeof item.parentId === 'string' && item.parentId.trim() ? item.parentId.trim() : null,
            color: typeof item.color === 'string' ? item.color : '',
            sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : cleaned.length,
            createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
        });
    }

    // Break dangling or cyclic parent references safely
    const byId = new Map(cleaned.map(f => [f.id, f]));
    for (const folder of cleaned) {
        if (folder.parentId && !byId.has(folder.parentId)) {
            folder.parentId = null;
        }
        if (folder.parentId === folder.id) {
            folder.parentId = null;
        }
    }

    // Detect and break any multi-node cycles
    for (const folder of cleaned) {
        const visited = new Set([folder.id]);
        let cursor = folder.parentId ? byId.get(folder.parentId) : null;
        while (cursor) {
            if (visited.has(cursor.id)) {
                folder.parentId = null;
                break;
            }
            visited.add(cursor.id);
            cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
        }
    }

    return cleaned;
}

/**
 * Sanitizes an assignment map (`itemKey -> folderId`), dropping unknown folderIds.
 * @param {unknown} rawAssignments
 * @param {Set<string>} validFolderIds
 * @param {{ stripJsonl?: boolean }} [options]
 * @returns {Record<string, string>}
 */
function sanitizeAssignments(rawAssignments, validFolderIds, { stripJsonl = false } = {}) {
    if (!rawAssignments || typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) {
        return {};
    }
    const result = {};
    for (const [rawKey, rawFolderId] of Object.entries(rawAssignments)) {
        if (typeof rawFolderId !== 'string' || !validFolderIds.has(rawFolderId)) {
            continue;
        }
        const key = stripJsonl ? stripJsonlExt(rawKey) : String(rawKey);
        if (key) {
            result[key] = rawFolderId;
        }
    }
    return result;
}

/**
 * Normalizes and returns a complete settings object from arbitrary saved data.
 * @param {unknown} rawSettings
 * @returns {typeof DEFAULT_SETTINGS & Record<string, any>}
 */
export function normalizeSettings(rawSettings) {
    const src = (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings))
        ? rawSettings
        : {};

    const charFolders = sanitizeFolderList(src.charFolders);
    const charFolderIds = new Set(charFolders.map(f => f.id));
    const charAssignments = sanitizeAssignments(src.charAssignments, charFolderIds);

    const recentFolders = sanitizeFolderList(src.recentFolders);
    const recentFolderIds = new Set(recentFolders.map(f => f.id));
    const recentAssignments = {};
    const rawRecentAssign = sanitizeAssignments(src.recentAssignments, recentFolderIds);
    for (const [rawKey, folderId] of Object.entries(rawRecentAssign)) {
        const parsed = parseRecentChatKey(rawKey);
        if (!parsed) continue;
        const normalizedKey = makeRecentChatKey(parsed.scopeKey, parsed.chatKey);
        if (normalizedKey) {
            recentAssignments[normalizedKey] = folderId;
        }
    }

    const chatFoldersByScope = {};
    const chatAssignmentsByScope = {};

    const rawChatFolders = (src.chatFoldersByScope && typeof src.chatFoldersByScope === 'object' && !Array.isArray(src.chatFoldersByScope))
        ? src.chatFoldersByScope
        : {};
    const rawChatAssignments = (src.chatAssignmentsByScope && typeof src.chatAssignmentsByScope === 'object' && !Array.isArray(src.chatAssignmentsByScope))
        ? src.chatAssignmentsByScope
        : {};

    for (const [scopeKey, list] of Object.entries(rawChatFolders)) {
        if (!scopeKey) continue;
        const cleanedFolders = sanitizeFolderList(list);
        const validIds = new Set(cleanedFolders.map(f => f.id));
        const cleanedAssignments = sanitizeAssignments(rawChatAssignments[scopeKey], validIds, { stripJsonl: true });
        if (cleanedFolders.length > 0 || Object.keys(cleanedAssignments).length > 0) {
            chatFoldersByScope[scopeKey] = cleanedFolders;
            chatAssignmentsByScope[scopeKey] = cleanedAssignments;
        }
    }

    const language = ['auto', 'zh', 'en'].includes(src.language) ? src.language : DEFAULT_SETTINGS.language;

    return {
        enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_SETTINGS.enabled,
        language,
        hideFolderedCharsInRoot: typeof src.hideFolderedCharsInRoot === 'boolean'
            ? src.hideFolderedCharsInRoot
            : DEFAULT_SETTINGS.hideFolderedCharsInRoot,
        hideFolderedChatsInRoot: typeof src.hideFolderedChatsInRoot === 'boolean'
            ? src.hideFolderedChatsInRoot
            : DEFAULT_SETTINGS.hideFolderedChatsInRoot,
        charFolders,
        charAssignments,
        recentFolders,
        recentAssignments,
        chatFoldersByScope,
        chatAssignmentsByScope,
    };
}

/**
 * Ensures scoped chat folders & assignments containers exist for `scopeKey` and returns them.
 * @param {ReturnType<typeof normalizeSettings>} settings
 * @param {string} scopeKey
 * @returns {{ folders: Array<any>, assignments: Record<string, string> }}
 */
export function ensureChatScope(settings, scopeKey) {
    if (!settings.chatFoldersByScope[scopeKey]) {
        settings.chatFoldersByScope[scopeKey] = [];
    }
    if (!settings.chatAssignmentsByScope[scopeKey]) {
        settings.chatAssignmentsByScope[scopeKey] = {};
    }
    return {
        folders: settings.chatFoldersByScope[scopeKey],
        assignments: settings.chatAssignmentsByScope[scopeKey],
    };
}

/**
 * Returns a Set containing `folderId` and all descendant folder IDs.
 * @param {Array<{id: string, parentId: string|null}>} folders
 * @param {string} folderId
 * @returns {Set<string>}
 */
export function getDescendantIds(folders, folderId) {
    const result = new Set();
    if (!folderId) return result;
    const queue = [folderId];
    while (queue.length > 0) {
        const current = queue.shift();
        if (result.has(current)) continue;
        result.add(current);
        for (const folder of folders) {
            if (folder.parentId === current && !result.has(folder.id)) {
                queue.push(folder.id);
            }
        }
    }
    return result;
}

/**
 * Checks whether moving `folderId` under `targetParentId` would create a cycle.
 * @param {Array<{id: string, parentId: string|null}>} folders
 * @param {string} folderId
 * @param {string|null} targetParentId
 * @returns {boolean}
 */
export function wouldCreateCycle(folders, folderId, targetParentId) {
    if (!targetParentId) return false;
    const descendants = getDescendantIds(folders, folderId);
    return descendants.has(targetParentId);
}

/**
 * Creates a folder in `folders` array.
 * @param {Array<any>} folders
 * @param {{ name: string, parentId?: string|null, color?: string, uuidFn?: () => string }} params
 * @returns {{ id: string, name: string, parentId: string|null, color: string, sortOrder: number, createdAt: number }}
 */
export function createFolder(folders, { name, parentId = null, color = '', uuidFn } = {}) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
        throw new Error('Folder name cannot be empty');
    }
    const validParent = parentId && folders.some(f => f.id === parentId) ? parentId : null;
    const maxSort = folders.reduce((acc, f) => Math.max(acc, Number(f.sortOrder) || 0), -1);
    const folder = {
        id: generateFolderId(uuidFn),
        name: trimmed.slice(0, 80),
        parentId: validParent,
        color: String(color || ''),
        sortOrder: maxSort + 1,
        createdAt: Date.now(),
    };
    folders.push(folder);
    return folder;
}

/**
 * Updates an existing folder's name, parentId, or color.
 * @param {Array<any>} folders
 * @param {string} folderId
 * @param {{ name?: string, parentId?: string|null, color?: string }} updates
 * @returns {object|null}
 */
export function updateFolder(folders, folderId, updates = {}) {
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return null;

    if (updates.name !== undefined) {
        const trimmed = String(updates.name).trim();
        if (!trimmed) {
            throw new Error('Folder name cannot be empty');
        }
        folder.name = trimmed.slice(0, 80);
    }

    if (updates.parentId !== undefined) {
        const nextParent = updates.parentId && folders.some(f => f.id === updates.parentId)
            ? updates.parentId
            : null;
        if (wouldCreateCycle(folders, folderId, nextParent)) {
            throw new Error('Cannot move a folder inside itself or its descendant');
        }
        folder.parentId = nextParent;
    }

    if (updates.color !== undefined) {
        folder.color = String(updates.color || '');
    }

    return folder;
}

/**
 * Deletes a folder without deleting any underlying characters or chats.
 * Direct child folders and direct items move up to the deleted folder's parentId (or root).
 * @param {Array<any>} folders
 * @param {Record<string, string>} assignments
 * @param {string} folderId
 * @returns {boolean}
 */
export function deleteFolder(folders, assignments, folderId) {
    const idx = folders.findIndex(f => f.id === folderId);
    if (idx === -1) return false;

    const deleted = folders[idx];
    const fallbackParent = deleted.parentId && deleted.parentId !== folderId ? deleted.parentId : null;
    folders.splice(idx, 1);

    for (const child of folders) {
        if (child.parentId === folderId) {
            child.parentId = fallbackParent;
        }
    }

    for (const [itemKey, assignedFolderId] of Object.entries(assignments)) {
        if (assignedFolderId === folderId) {
            if (fallbackParent) {
                assignments[itemKey] = fallbackParent;
            } else {
                delete assignments[itemKey];
            }
        }
    }

    return true;
}

/**
 * Assigns one or more item keys to `folderId` (or unassigns if `folderId` is null/empty).
 * @param {Array<any>} folders
 * @param {Record<string, string>} assignments
 * @param {string[]} itemKeys
 * @param {string|null} folderId
 * @returns {number} Number of items updated
 */
export function assignItemsToFolder(folders, assignments, itemKeys, folderId) {
    const targetId = folderId ? String(folderId) : null;
    if (targetId && !folders.some(f => f.id === targetId)) {
        return 0;
    }

    let count = 0;
    for (const rawKey of itemKeys) {
        const key = String(rawKey || '');
        if (!key) continue;
        if (targetId) {
            assignments[key] = targetId;
        } else {
            delete assignments[key];
        }
        count++;
    }
    return count;
}

/**
 * Builds the breadcrumb path from root to `folderId`.
 * @param {Array<{id: string, name: string, parentId: string|null}>} folders
 * @param {string|null} folderId
 * @returns {Array<{id: string, name: string}>}
 */
export function getBreadcrumbs(folders, folderId) {
    if (!folderId) return [];
    const byId = new Map(folders.map(f => [f.id, f]));
    const chain = [];
    const visited = new Set();
    let cursor = byId.get(folderId);

    while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        chain.unshift({ id: cursor.id, name: cursor.name });
        cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }

    return chain;
}

/**
 * Formats a folder's full path string (e.g. "RPG / Fantasy").
 * @param {Array<{id: string, name: string, parentId: string|null}>} folders
 * @param {string|null} folderId
 * @returns {string}
 */
export function getFolderPathLabel(folders, folderId) {
    return getBreadcrumbs(folders, folderId).map(b => b.name).join(' / ');
}

/**
 * Sorts folders cleanly by sortOrder then localeCompare(name).
 * @param {Array<any>} folders
 * @returns {Array<any>}
 */
export function sortFolders(folders) {
    return [...folders].sort((a, b) => {
        const diff = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
        if (diff !== 0) return diff;
        return String(a.name).localeCompare(String(b.name));
    });
}

/**
 * Returns flattened folder tree items with `depth` for dropdowns and pickers.
 * @param {Array<any>} folders
 * @param {Set<string>|null} [excludeIds]
 * @returns {Array<{ folder: any, depth: number }>}
 */
export function flattenFolderTree(folders, excludeIds = null) {
    const byParent = new Map();
    for (const folder of sortFolders(folders)) {
        if (excludeIds && excludeIds.has(folder.id)) continue;
        const pid = folder.parentId && folders.some(p => p.id === folder.parentId) && (!excludeIds || !excludeIds.has(folder.parentId))
            ? folder.parentId
            : null;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(folder);
    }

    const result = [];
    const visit = (parentId, depth) => {
        const children = byParent.get(parentId) || [];
        for (const child of children) {
            result.push({ folder: child, depth });
            visit(child.id, depth + 1);
        }
    };
    visit(null, 0);
    return result;
}

/**
 * Computes direct item counts, recursive item counts, subfolder counts, and preview item keys per folder.
 * @param {Array<any>} folders
 * @param {Record<string, string>} assignments
 * @param {Set<string>|null} [validItemKeys] If provided, only counts keys present in this set.
 * @returns {Map<string, { directItems: number, totalItems: number, directSubfolders: number, previewKeys: string[] }>}
 */
export function computeFolderStats(folders, assignments, validItemKeys = null) {
    const stats = new Map();
    for (const folder of folders) {
        stats.set(folder.id, {
            directItems: 0,
            totalItems: 0,
            directSubfolders: 0,
            previewKeys: [],
        });
    }

    for (const folder of folders) {
        if (folder.parentId && stats.has(folder.parentId)) {
            stats.get(folder.parentId).directSubfolders++;
        }
    }

    for (const [itemKey, folderId] of Object.entries(assignments)) {
        if (validItemKeys && !validItemKeys.has(itemKey)) continue;
        const entry = stats.get(folderId);
        if (!entry) continue;
        entry.directItems++;
        if (entry.previewKeys.length < 4) {
            entry.previewKeys.push(itemKey);
        }
    }

    // Aggregate recursive counts bottom-up via memoized recursion
    const byParent = new Map();
    for (const folder of folders) {
        const pid = folder.parentId || null;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(folder);
    }

    const computeTotal = (folderId, seen = new Set()) => {
        if (seen.has(folderId)) return 0;
        seen.add(folderId);
        const entry = stats.get(folderId);
        if (!entry) return 0;
        let total = entry.directItems;
        for (const child of byParent.get(folderId) || []) {
            total += computeTotal(child.id, seen);
            if (entry.previewKeys.length < 4) {
                const childEntry = stats.get(child.id);
                for (const key of childEntry?.previewKeys || []) {
                    if (entry.previewKeys.length >= 4) break;
                    if (!entry.previewKeys.includes(key)) {
                        entry.previewKeys.push(key);
                    }
                }
            }
        }
        entry.totalItems = total;
        return total;
    };

    for (const folder of folders) {
        computeTotal(folder.id);
    }

    return stats;
}

/**
 * Migrates a single key inside `assignments` (e.g. on chat rename or character rename).
 * @param {Record<string, string>} assignments
 * @param {string} oldKey
 * @param {string} newKey
 * @returns {boolean}
 */
export function migrateAssignmentKey(assignments, oldKey, newKey) {
    if (!assignments || !oldKey || !newKey || oldKey === newKey) return false;
    if (!(oldKey in assignments)) return false;
    assignments[newKey] = assignments[oldKey];
    delete assignments[oldKey];
    return true;
}

/**
 * Migrates all Recent Chat assignment keys belonging to `oldScopeKey` over to `newScopeKey`.
 * @param {Record<string, string>} recentAssignments
 * @param {string} oldScopeKey
 * @param {string} newScopeKey
 * @returns {boolean}
 */
export function migrateRecentAssignmentsByScope(recentAssignments, oldScopeKey, newScopeKey) {
    if (!recentAssignments || !oldScopeKey || !newScopeKey || oldScopeKey === newScopeKey) return false;
    const prefix = `${oldScopeKey}::`;
    let changed = false;
    for (const key of Object.keys(recentAssignments)) {
        if (!key.startsWith(prefix)) continue;
        const chatKey = key.slice(prefix.length);
        const targetKey = makeRecentChatKey(newScopeKey, chatKey);
        if (targetKey) {
            recentAssignments[targetKey] = recentAssignments[key];
            delete recentAssignments[key];
            changed = true;
        }
    }
    return changed;
}

/**
 * Removes all Recent Chat assignment keys belonging to `scopeKey`.
 * @param {Record<string, string>} recentAssignments
 * @param {string} scopeKey
 * @returns {boolean}
 */
export function deleteRecentAssignmentsByScope(recentAssignments, scopeKey) {
    if (!recentAssignments || !scopeKey) return false;
    const prefix = `${scopeKey}::`;
    let changed = false;
    for (const key of Object.keys(recentAssignments)) {
        if (key.startsWith(prefix)) {
            delete recentAssignments[key];
            changed = true;
        }
    }
    return changed;
}

/**
 * Removes assignments whose item key does not exist in `validItemKeys` or whose folderId doesn't exist.
 * @param {Array<any>} folders
 * @param {Record<string, string>} assignments
 * @param {Set<string>} validItemKeys
 * @returns {number} Number of pruned entries
 */
export function pruneAssignments(folders, assignments, validItemKeys) {
    const folderIds = new Set(folders.map(f => f.id));
    let removed = 0;
    for (const [key, folderId] of Object.entries(assignments)) {
        if (!folderIds.has(folderId) || !validItemKeys.has(key)) {
            delete assignments[key];
            removed++;
        }
    }
    return removed;
}

/**
 * Sorts character/group entities using SillyTavern's character_sort_order rules.
 * @param {Array<{ type: 'character'|'group', item: any }>} entities
 * @param {string} sortField
 * @param {string} sortOrder
 * @returns {Array<{ type: 'character'|'group', item: any }>}
 */
export function sortCharacterEntities(entities, sortField = 'name', sortOrder = 'asc') {
    const list = [...entities];
    if (sortOrder === 'random') {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    const dir = sortOrder === 'desc' ? -1 : 1;

    list.sort((a, b) => {
        const itemA = a.item || {};
        const itemB = b.item || {};

        if (sortField === 'fav') {
            const favA = Boolean(itemA.fav === true || itemA.fav === 'true');
            const favB = Boolean(itemB.fav === true || itemB.fav === 'true');
            if (favA !== favB) {
                return (favA ? 1 : 0) > (favB ? 1 : 0) ? dir : -dir;
            }
            return String(itemA.name || '').localeCompare(String(itemB.name || ''));
        }

        if (sortField === 'name') {
            return String(itemA.name || '').localeCompare(String(itemB.name || '')) * dir;
        }

        const numA = Number(itemA[sortField]) || 0;
        const numB = Number(itemB[sortField]) || 0;
        if (numA !== numB) {
            return (numA - numB) * dir;
        }

        return String(itemA.name || '').localeCompare(String(itemB.name || ''));
    });

    return list;
}

/**
 * Validates and normalizes an imported configuration payload.
 * @param {unknown} raw
 * @returns {ReturnType<typeof normalizeSettings>|null}
 */
export function parseImportedConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const hasKnownField =
        'charFolders' in raw ||
        'charAssignments' in raw ||
        'recentFolders' in raw ||
        'recentAssignments' in raw ||
        'chatFoldersByScope' in raw ||
        'chatAssignmentsByScope' in raw;
    if (!hasKnownField) {
        return null;
    }
    return normalizeSettings(raw);
}
