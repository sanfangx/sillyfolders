import {
    EXTENSION_SETTINGS_KEY,
    normalizeSettings,
    pruneAssignments,
    makeCharKey,
    makeGroupKey,
    getChatScopeKey,
    ensureChatScope,
} from './folder-store.js';
import { setLanguagePreference } from './i18n.js';

let cachedSettings = null;
const refreshCallbacks = new Set();

/**
 * Returns the live SillyTavern context object.
 * Always called fresh because properties like `characterId` and `groupId` reflect current state at call time.
 */
export function getStContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}

/**
 * Loads and normalizes extension settings from `extensionSettings.st_folders`.
 * @param {boolean} [forceReload=false]
 */
export function getSettings(forceReload = false) {
    const context = getStContext();
    if (!context) {
        if (!cachedSettings) {
            cachedSettings = normalizeSettings({});
        }
        return cachedSettings;
    }

    if (!context.extensionSettings) {
        context.extensionSettings = {};
    }

    if (forceReload || !cachedSettings || context.extensionSettings[EXTENSION_SETTINGS_KEY] !== cachedSettings) {
        const normalized = normalizeSettings(context.extensionSettings[EXTENSION_SETTINGS_KEY]);
        context.extensionSettings[EXTENSION_SETTINGS_KEY] = normalized;
        cachedSettings = normalized;
        setLanguagePreference(normalized.language);
    }

    return cachedSettings;
}

/**
 * Persists settings via SillyTavern's debounced settings saver.
 */
export function saveSettings() {
    const context = getStContext();
    if (!context) return;
    if (!context.extensionSettings) {
        context.extensionSettings = {};
    }
    context.extensionSettings[EXTENSION_SETTINGS_KEY] = getSettings();
    context.saveSettingsDebounced?.();
}

/**
 * Registers a callback invoked when global extension state/settings change.
 * @param {() => void} callback
 */
export function onSettingsUpdated(callback) {
    refreshCallbacks.add(callback);
}

/**
 * Notifies all registered UI controllers to re-render.
 */
export function notifyAllControllers() {
    for (const cb of refreshCallbacks) {
        try {
            cb();
        } catch (error) {
            console.error('[st-folders] Refresh callback failed:', error);
        }
    }
}

/**
 * Builds a Set of valid character and group keys currently loaded in SillyTavern.
 */
export function getValidCharAndGroupKeys() {
    const context = getStContext();
    const keys = new Set();
    if (!context) return keys;

    for (const char of context.characters || []) {
        if (char?.avatar) {
            keys.add(makeCharKey(char.avatar));
        }
    }
    for (const group of context.groups || []) {
        if (group?.id) {
            keys.add(makeGroupKey(group.id));
        }
    }
    return keys;
}

/**
 * Cleans up orphaned assignments that point to deleted characters/groups or non-existent folders.
 * @returns {number} Number of cleaned assignments
 */
export function cleanupOrphanedCharAssignments() {
    const settings = getSettings();
    const validKeys = getValidCharAndGroupKeys();
    const removed = pruneAssignments(settings.charFolders, settings.charAssignments, validKeys);

    // Also remove chat scopes whose character or group no longer exists
    let scopeRemoved = 0;
    for (const scopeKey of Object.keys(settings.chatFoldersByScope)) {
        if (!validKeys.has(scopeKey)) {
            const count = Object.keys(settings.chatAssignmentsByScope[scopeKey] || {}).length;
            scopeRemoved += count;
            delete settings.chatFoldersByScope[scopeKey];
            delete settings.chatAssignmentsByScope[scopeKey];
        }
    }

    if (removed + scopeRemoved > 0) {
        saveSettings();
    }
    return removed + scopeRemoved;
}

/**
 * Returns the active chat scope key and ensures its storage buckets exist.
 */
export function getActiveChatScope() {
    const context = getStContext();
    const scopeKey = getChatScopeKey(context);
    if (!scopeKey) return null;
    const settings = getSettings();
    const scope = ensureChatScope(settings, scopeKey);
    return { scopeKey, ...scope };
}
