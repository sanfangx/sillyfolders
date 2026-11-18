import { parseImportedConfig } from './folder-store.js';
import { setLanguagePreference, tr } from './i18n.js';
import { moveCurrentChatToFolder } from './chat-folders.js';
import {
    cleanupOrphanedCharAssignments,
    getSettings,
    getStContext,
    notifyAllControllers,
    saveSettings,
} from './runtime.js';
import { createIcon } from './ui-dialogs.js';

let drawerEl = null;
let wandMenuItemEl = null;

/**
 * Updates live statistics text and localized labels inside the settings drawer.
 */
export function refreshSettingsPanel() {
    if (!drawerEl) return;
    const settings = getSettings();

    const titleEl = drawerEl.querySelector('.stf-settings-title');
    if (titleEl) titleEl.textContent = tr('extensionTitle');

    const enabledCheck = drawerEl.querySelector('#stf_opt_enabled');
    const enabledLabel = drawerEl.querySelector('label[for="stf_opt_enabled"] span');
    if (enabledCheck instanceof HTMLInputElement) enabledCheck.checked = settings.enabled;
    if (enabledLabel) enabledLabel.textContent = tr('enabledLabel');

    const hideCharsCheck = drawerEl.querySelector('#stf_opt_hide_chars');
    const hideCharsLabel = drawerEl.querySelector('label[for="stf_opt_hide_chars"] span');
    if (hideCharsCheck instanceof HTMLInputElement) hideCharsCheck.checked = settings.hideFolderedCharsInRoot;
    if (hideCharsLabel) hideCharsLabel.textContent = tr('hideFolderedCharsLabel');

    const hideChatsCheck = drawerEl.querySelector('#stf_opt_hide_chats');
    const hideChatsLabel = drawerEl.querySelector('label[for="stf_opt_hide_chats"] span');
    if (hideChatsCheck instanceof HTMLInputElement) hideChatsCheck.checked = settings.hideFolderedChatsInRoot;
    if (hideChatsLabel) hideChatsLabel.textContent = tr('hideFolderedChatsLabel');

    const langLabel = drawerEl.querySelector('.stf-lang-label');
    if (langLabel) langLabel.textContent = tr('languageLabel');

    const langSelect = drawerEl.querySelector('#stf_opt_language');
    if (langSelect instanceof HTMLSelectElement) {
        langSelect.value = settings.language;
        const optAuto = langSelect.querySelector('option[value="auto"]');
        const optZh = langSelect.querySelector('option[value="zh"]');
        const optEn = langSelect.querySelector('option[value="en"]');
        if (optAuto) optAuto.textContent = tr('languageAuto');
        if (optZh) optZh.textContent = tr('languageZh');
        if (optEn) optEn.textContent = tr('languageEn');
    }

    const statsEl = drawerEl.querySelector('.stf-settings-stats');
    if (statsEl) {
        const charFoldersCount = settings.charFolders.length;
        const charItemsCount = Object.keys(settings.charAssignments).length;
        const chatFoldersCount = Object.values(settings.chatFoldersByScope)
            .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
        const chatItemsCount = Object.values(settings.chatAssignmentsByScope)
            .reduce((sum, map) => sum + (map && typeof map === 'object' ? Object.keys(map).length : 0), 0);

        statsEl.textContent = tr('statsTemplate', {
            charFolders: charFoldersCount,
            charItems: charItemsCount,
            chatFolders: chatFoldersCount,
            chatItems: chatItemsCount,
        });
    }

    const exportBtn = drawerEl.querySelector('#stf_export_btn span');
    if (exportBtn) exportBtn.textContent = tr('exportConfig');

    const importBtn = drawerEl.querySelector('#stf_import_btn span');
    if (importBtn) importBtn.textContent = tr('importConfig');

    const cleanupBtn = drawerEl.querySelector('#stf_cleanup_btn span');
    if (cleanupBtn) cleanupBtn.textContent = tr('cleanupOrphans');

    if (wandMenuItemEl) {
        const wandLabel = wandMenuItemEl.querySelector('span');
        if (wandLabel) wandLabel.textContent = tr('moveCurrentChatToFolder');
        wandMenuItemEl.style.display = settings.enabled ? '' : 'none';
    }
}

/**
 * Triggers a JSON download in browser.
 * @param {string} filename
 * @param {string} content
 */
function downloadJsonFile(filename, content) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Mounts the extension settings drawer in `#extensions_settings` and quick action in `#extensionsMenu`.
 */
export function initSettingsPanel() {
    const settingsContainer = document.getElementById('extensions_settings');
    if (settingsContainer && !document.getElementById('stf_settings_drawer')) {
        drawerEl = document.createElement('div');
        drawerEl.id = 'stf_settings_drawer';
        drawerEl.className = 'extension_container';

        const inlineDrawer = document.createElement('div');
        inlineDrawer.className = 'inline-drawer';

        const header = document.createElement('div');
        header.className = 'inline-drawer-toggle inline-drawer-header';
        const title = document.createElement('b');
        title.className = 'stf-settings-title';
        const chevron = document.createElement('div');
        chevron.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
        header.append(title, chevron);

        const content = document.createElement('div');
        content.className = 'inline-drawer-content stf-settings-body';

        const makeCheckbox = (id, onChange) => {
            const label = document.createElement('label');
            label.className = 'checkbox_label';
            label.setAttribute('for', id);
            const input = document.createElement('input');
            input.id = id;
            input.type = 'checkbox';
            input.addEventListener('change', () => onChange(input.checked));
            const span = document.createElement('span');
            label.append(input, span);
            return label;
        };

        content.appendChild(makeCheckbox('stf_opt_enabled', (checked) => {
            const settings = getSettings();
            settings.enabled = checked;
            saveSettings();
            notifyAllControllers();
        }));

        content.appendChild(makeCheckbox('stf_opt_hide_chars', (checked) => {
            const settings = getSettings();
            settings.hideFolderedCharsInRoot = checked;
            saveSettings();
            notifyAllControllers();
        }));

        content.appendChild(makeCheckbox('stf_opt_hide_chats', (checked) => {
            const settings = getSettings();
            settings.hideFolderedChatsInRoot = checked;
            saveSettings();
            notifyAllControllers();
        }));

        // Language selector
        const langRow = document.createElement('div');
        langRow.className = 'stf-settings-row';
        const langLabel = document.createElement('label');
        langLabel.className = 'stf-lang-label';
        langLabel.setAttribute('for', 'stf_opt_language');
        const langSelect = document.createElement('select');
        langSelect.id = 'stf_opt_language';
        langSelect.className = 'text_pole';
        for (const val of ['auto', 'zh', 'en']) {
            const opt = document.createElement('option');
            opt.value = val;
            langSelect.appendChild(opt);
        }
        langSelect.addEventListener('change', () => {
            const settings = getSettings();
            settings.language = langSelect.value;
            setLanguagePreference(settings.language);
            saveSettings();
            notifyAllControllers();
        });
        langRow.append(langLabel, langSelect);
        content.appendChild(langRow);

        // Stats line
        const statsEl = document.createElement('small');
        statsEl.className = 'stf-settings-stats';
        content.appendChild(statsEl);

        // Action buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'stf-settings-actions';

        const exportBtn = document.createElement('button');
        exportBtn.id = 'stf_export_btn';
        exportBtn.type = 'button';
        exportBtn.className = 'menu_button menu_button_icon';
        exportBtn.appendChild(createIcon('fa-file-export'));
        exportBtn.appendChild(document.createElement('span'));
        exportBtn.addEventListener('click', () => {
            const settings = getSettings();
            const json = JSON.stringify(settings, null, 2);
            const date = new Date().toISOString().slice(0, 10);
            downloadJsonFile(`sillytavern-folders-${date}.json`, json);
            globalThis.toastr?.success?.(tr('exportSuccess'));
        });

        const importInput = document.createElement('input');
        importInput.type = 'file';
        importInput.accept = '.json,application/json';
        importInput.hidden = true;
        importInput.addEventListener('change', async () => {
            const file = importInput.files?.[0];
            importInput.value = '';
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const normalized = parseImportedConfig(parsed);
                if (!normalized) {
                    globalThis.toastr?.error?.(tr('importInvalid'));
                    return;
                }
                const context = getStContext();
                if (context?.extensionSettings) {
                    context.extensionSettings.st_folders = normalized;
                }
                getSettings(true);
                saveSettings();
                notifyAllControllers();
                globalThis.toastr?.success?.(tr('importSuccess'));
            } catch (error) {
                console.error('[st-folders] Failed to import config:', error);
                globalThis.toastr?.error?.(tr('importInvalid'));
            }
        });

        const importBtn = document.createElement('button');
        importBtn.id = 'stf_import_btn';
        importBtn.type = 'button';
        importBtn.className = 'menu_button menu_button_icon';
        importBtn.appendChild(createIcon('fa-file-import'));
        importBtn.appendChild(document.createElement('span'));
        importBtn.addEventListener('click', () => importInput.click());

        const cleanupBtn = document.createElement('button');
        cleanupBtn.id = 'stf_cleanup_btn';
        cleanupBtn.type = 'button';
        cleanupBtn.className = 'menu_button menu_button_icon';
        cleanupBtn.appendChild(createIcon('fa-broom'));
        cleanupBtn.appendChild(document.createElement('span'));
        cleanupBtn.addEventListener('click', () => {
            const count = cleanupOrphanedCharAssignments();
            notifyAllControllers();
            globalThis.toastr?.info?.(tr('cleanupDone', { count }));
        });

        btnRow.append(exportBtn, importBtn, cleanupBtn, importInput);
        content.appendChild(btnRow);

        inlineDrawer.append(header, content);
        drawerEl.appendChild(inlineDrawer);
        settingsContainer.appendChild(drawerEl);
    }

    // Add quick entry in `#extensionsMenu` (magic wand menu) to file the active chat
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (extensionsMenu && !document.getElementById('stf_wand_move_chat')) {
        wandMenuItemEl = document.createElement('div');
        wandMenuItemEl.id = 'stf_wand_move_chat';
        wandMenuItemEl.className = 'list-group-item flex-container flexGap5';
        wandMenuItemEl.appendChild(createIcon('fa-folder-open', 'extensionsMenuExtensionButton'));
        const span = document.createElement('span');
        span.textContent = tr('moveCurrentChatToFolder');
        wandMenuItemEl.appendChild(span);
        wandMenuItemEl.addEventListener('click', async () => {
            await moveCurrentChatToFolder();
        });
        extensionsMenu.appendChild(wandMenuItemEl);
    }

    refreshSettingsPanel();
}
