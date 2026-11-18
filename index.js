import { initCharFolders, renderCharacterFolderView } from './src/char-folders.js';
import { initChatFolders, renderChatFolderView } from './src/chat-folders.js';
import { initRecentFolders, renderRecentChatFolderView } from './src/recent-folders.js';
import {
    getSettings,
    getStContext,
    notifyAllControllers,
    onSettingsUpdated,
} from './src/runtime.js';
import { initSettingsPanel, refreshSettingsPanel } from './src/settings-panel.js';

let initialized = false;

function refreshAllViews() {
    refreshSettingsPanel();
    renderCharacterFolderView();
    renderRecentChatFolderView();
    if (document.getElementById('shadow_select_chat_popup')?.style.display !== 'none') {
        renderChatFolderView();
    }
}

function initializeExtension() {
    if (initialized) {
        return;
    }

    const context = getStContext();
    if (!context) {
        console.warn('[st-folders] SillyTavern context is not available yet.');
        return;
    }

    initialized = true;
    getSettings(true);

    onSettingsUpdated(refreshAllViews);

    initCharFolders();
    initChatFolders();
    initRecentFolders();
    initSettingsPanel();

    const { eventSource, eventTypes } = context;
    if (eventSource && eventTypes) {
        const reloadSettingsAndUi = () => {
            getSettings(true);
            notifyAllControllers();
        };

        eventSource.on(eventTypes.EXTENSION_SETTINGS_LOADED, reloadSettingsAndUi);
        eventSource.on(eventTypes.SETTINGS_LOADED_AFTER, reloadSettingsAndUi);
        eventSource.on(eventTypes.APP_READY, reloadSettingsAndUi);
    }
}

if (typeof globalThis.jQuery === 'function') {
    globalThis.jQuery(() => {
        initializeExtension();
    });
} else if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeExtension, { once: true });
    } else {
        initializeExtension();
    }
}

export { initializeExtension };
