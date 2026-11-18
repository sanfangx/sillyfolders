import {
    assignItemsToFolder,
    computeFolderStats,
    createFolder,
    deleteFolder,
    ensureChatScope,
    getBreadcrumbs,
    getDescendantIds,
    getFolderPathLabel,
    makeCharKey,
    makeGroupKey,
    migrateAssignmentKey,
    sortFolders,
    stripJsonlExt,
    updateFolder,
} from './folder-store.js';
import { tr } from './i18n.js';
import {
    getActiveChatScope,
    getSettings,
    getStContext,
    saveSettings,
} from './runtime.js';
import {
    buildFolderCard,
    confirmDeleteFolderPopup,
    createIcon,
    openFolderFormPopup,
    openFolderPickerPopup,
    renderBreadcrumbs,
    setActiveDragPayload,
} from './ui-dialogs.js';

/** @type {Map<string, string|null>} */
const activeChatFolderByScope = new Map();
/** @type {Map<string, Set<string>>} */
const knownChatKeysByScope = new Map();

let lastScopeKey = null;
let isChatBatchMode = false;
const selectedChatKeys = new Set();

let isApplyingChatDom = false;
let chatRenderScheduled = false;
let chatObserver = null;
let popupAttrObserver = null;

let chatToolbarEl = null;
let chatBreadcrumbEl = null;
let chatBatchBarEl = null;
let chatBackBtn = null;
let chatNewFolderBtn = null;
let chatBatchBtn = null;
let chatHideToggleBtn = null;

/**
 * Gets the active folder ID for `scopeKey` (validated against existing folders).
 * @param {string} scopeKey
 * @param {Array<any>} folders
 * @returns {string|null}
 */
function getActiveChatFolderId(scopeKey, folders) {
    const candidate = activeChatFolderByScope.get(scopeKey) || null;
    if (candidate && folders.some(f => f.id === candidate)) {
        return candidate;
    }
    activeChatFolderByScope.set(scopeKey, null);
    return null;
}

/**
 * Extracts normalized chat file name from a `.select_chat_block_wrapper` element.
 * @param {HTMLElement} wrapperEl
 * @returns {string}
 */
function getChatKeyFromWrapper(wrapperEl) {
    const block = wrapperEl.querySelector('.select_chat_block');
    const raw = block?.getAttribute('file_name') || '';
    return stripJsonlExt(raw);
}

/**
 * Checks if a wrapper corresponds to the currently active chat (`highlight="true"`).
 * @param {HTMLElement} wrapperEl
 */
function isWrapperCurrentChat(wrapperEl) {
    const block = wrapperEl.querySelector('.select_chat_block');
    return block?.getAttribute('highlight') === 'true';
}

/**
 * Checks whether a chat folder (or its descendants) contains the currently highlighted chat.
 * @param {string} folderId
 * @param {Array<any>} folders
 * @param {Record<string, string>} assignments
 * @param {string|null} activeChatKey
 */
function folderContainsActiveChat(folderId, folders, assignments, activeChatKey) {
    if (!activeChatKey) return false;
    const assignedFolderId = assignments[activeChatKey];
    if (!assignedFolderId) return false;
    const descendants = getDescendantIds(folders, folderId);
    return descendants.has(assignedFolderId);
}

/**
 * Safely runs DOM mutations inside `#select_chat_div` without triggering self-observation loops.
 * @param {() => void} fn
 */
function withSuppressedChatObserver(fn) {
    isApplyingChatDom = true;
    try {
        fn();
    } finally {
        isApplyingChatDom = false;
    }
}

/**
 * Decorates a `.select_chat_block_wrapper` with move button, optional folder badge, drag-drop, and batch highlight.
 * Important: never modifies `.select_chat_block_filename` text so native rename/export continue to read exact filenames.
 * @param {HTMLElement} wrapperEl
 * @param {object} scope
 * @param {boolean} showBadge
 */
function decorateChatWrapper(wrapperEl, scope, showBadge) {
    const chatKey = getChatKeyFromWrapper(wrapperEl);
    if (!chatKey) return;

    const { scopeKey, folders, assignments } = scope;
    const assignedFolderId = assignments[chatKey] || null;
    const folder = assignedFolderId ? folders.find(f => f.id === assignedFolderId) : null;

    wrapperEl.classList.add('stf-chat-decorated');
    wrapperEl.dataset.stfChatKey = chatKey;
    wrapperEl.classList.toggle('stf-batch-selected', isChatBatchMode && selectedChatKeys.has(chatKey));

    // Folder badge (inserted as sibling next to renameChatButton, NOT inside .select_chat_block_filename)
    wrapperEl.querySelector('.stf-folder-badge')?.remove();
    if (showBadge && folder) {
        const badge = document.createElement('span');
        badge.className = 'stf-folder-badge stf-chat-folder-badge';
        badge.title = tr('folderBadgeTitle', { path: getFolderPathLabel(folders, folder.id) });
        if (folder.color) {
            badge.style.setProperty('--stf-badge-color', folder.color);
            badge.classList.add('has-color');
        }
        badge.appendChild(createIcon('fa-folder'));
        const text = document.createElement('span');
        text.textContent = folder.name;
        badge.appendChild(text);

        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            navigateToChatFolder(scopeKey, folder.id);
        });

        const renameBtn = wrapperEl.querySelector('.renameChatButton');
        if (renameBtn?.parentElement) {
            renameBtn.parentElement.appendChild(badge);
        }
    }

    // Move-to-folder icon button inside `.select_chat_actions`
    const actionsEl = wrapperEl.querySelector('.select_chat_actions');
    if (actionsEl && !actionsEl.querySelector('.stf-chat-move-btn')) {
        const moveBtn = document.createElement('div');
        moveBtn.className = 'stf-chat-move-btn opacity50p hoverglow fa-solid fa-folder';
        moveBtn.title = tr('moveToFolder');
        moveBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            await openChatMovePicker(scopeKey, [chatKey], chatKey);
        });
        const deleteCross = actionsEl.querySelector('.PastChat_cross');
        if (deleteCross) {
            actionsEl.insertBefore(moveBtn, deleteCross);
        } else {
            actionsEl.appendChild(moveBtn);
        }
    }

    // Drag & drop on `.select_chat_block`
    const blockEl = wrapperEl.querySelector('.select_chat_block');
    if (blockEl instanceof HTMLElement) {
        blockEl.setAttribute('draggable', 'true');
        if (blockEl.dataset.stfDragBound !== '1') {
            blockEl.dataset.stfDragBound = '1';

            blockEl.addEventListener('dragstart', (e) => {
                const key = getChatKeyFromWrapper(wrapperEl);
                if (!key) return;
                const keys = isChatBatchMode && selectedChatKeys.has(key) && selectedChatKeys.size > 0
                    ? [...selectedChatKeys]
                    : [key];

                setActiveDragPayload({
                    domain: 'chat',
                    kind: 'items',
                    keys,
                });
                wrapperEl.classList.add('stf-dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', keys.join(','));
                }
            });

            blockEl.addEventListener('dragend', () => {
                wrapperEl.classList.remove('stf-dragging');
                setActiveDragPayload(null);
            });
        }
    }
}

/**
 * Updates chat toolbar UI (breadcrumbs, buttons, batch bar).
 * @param {string|null} scopeKey
 * @param {Array<any>} folders
 */
function updateChatToolbar(scopeKey, folders = []) {
    if (!chatToolbarEl) return;
    const settings = getSettings();

    if (!settings.enabled || !scopeKey) {
        chatToolbarEl.style.display = 'none';
        return;
    }
    chatToolbarEl.style.display = '';

    const activeFolderId = getActiveChatFolderId(scopeKey, folders);

    if (chatBreadcrumbEl) {
        renderBreadcrumbs(chatBreadcrumbEl, {
            domain: 'chat',
            rootLabel: tr('rootChats'),
            folders,
            activeFolderId,
            onNavigate: (targetId) => navigateToChatFolder(scopeKey, targetId),
            onDropItems: (keys, targetId) => handleDropItemsToChatFolder(scopeKey, keys, targetId),
            onDropFolder: (folderId, targetParentId) => handleDropFolderToChatParent(scopeKey, folderId, targetParentId),
        });
    }

    if (chatBackBtn) {
        chatBackBtn.style.display = activeFolderId ? '' : 'none';
        chatBackBtn.title = tr('backUp');
    }

    if (chatNewFolderBtn) {
        chatNewFolderBtn.title = tr('newFolder');
        const label = chatNewFolderBtn.querySelector('span');
        if (label) label.textContent = tr('newFolderShort');
    }

    if (chatBatchBtn) {
        chatBatchBtn.classList.toggle('active', isChatBatchMode);
        chatBatchBtn.title = tr('batchSelect');
        const label = chatBatchBtn.querySelector('span');
        if (label) label.textContent = isChatBatchMode ? tr('batchDone') : tr('batchSelect');
    }

    if (chatHideToggleBtn) {
        chatHideToggleBtn.title = tr('toggleHideFolderedChats');
        chatHideToggleBtn.classList.toggle('active', !settings.hideFolderedChatsInRoot);
        const icon = chatHideToggleBtn.querySelector('i');
        if (icon) {
            icon.className = settings.hideFolderedChatsInRoot ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        }
    }

    if (chatBatchBarEl) {
        chatBatchBarEl.style.display = isChatBatchMode ? 'flex' : 'none';
        const countEl = chatBatchBarEl.querySelector('.stf-batch-count');
        if (countEl) countEl.textContent = tr('batchSelectedCount', { count: selectedChatKeys.size });
        const selAllBtn = chatBatchBarEl.querySelector('.stf-batch-select-all');
        if (selAllBtn) selAllBtn.textContent = tr('selectAllVisible');
        const moveBtn = chatBatchBarEl.querySelector('.stf-batch-move');
        if (moveBtn) moveBtn.textContent = tr('batchMoveTo');
        const moveOutBtn = chatBatchBarEl.querySelector('.stf-batch-move-out');
        if (moveOutBtn) moveOutBtn.textContent = tr('batchMoveOut');
        const cancelBtn = chatBatchBarEl.querySelector('.stf-batch-cancel');
        if (cancelBtn) cancelBtn.textContent = tr('cancel');
    }
}

/**
 * Navigates to a chat folder within the given scope.
 * @param {string} scopeKey
 * @param {string|null} folderId
 */
function navigateToChatFolder(scopeKey, folderId) {
    const settings = getSettings();
    const { folders } = ensureChatScope(settings, scopeKey);
    if (folderId && !folders.some(f => f.id === folderId)) {
        activeChatFolderByScope.set(scopeKey, null);
    } else {
        activeChatFolderByScope.set(scopeKey, folderId);
    }
    selectedChatKeys.clear();
    renderChatFolderView();
}

/**
 * Opens folder picker popup for one or more chat keys inside `scopeKey`.
 * @param {string} scopeKey
 * @param {string[]} chatKeys
 * @param {string} [singleName]
 */
async function openChatMovePicker(scopeKey, chatKeys, singleName = '') {
    if (!chatKeys.length) {
        globalThis.toastr?.info?.(tr('pleaseSelectItems'));
        return;
    }

    const settings = getSettings();
    const { folders, assignments } = ensureChatScope(settings, scopeKey);
    const activeFolderId = getActiveChatFolderId(scopeKey, folders);
    const currentFolderId = chatKeys.length === 1 ? (assignments[chatKeys[0]] || null) : null;
    const validKeys = knownChatKeysByScope.get(scopeKey) || null;

    const title = chatKeys.length === 1
        ? tr('pickerTitleSingle', { name: singleName || chatKeys[0] })
        : tr('pickerTitleBatch', { count: chatKeys.length });

    const picked = await openFolderPickerPopup({
        title,
        folders,
        assignments,
        currentFolderId,
        validItemKeys: validKeys,
        defaultParentId: activeFolderId,
        onCreateFolder: (name, parentId) => {
            const folder = createFolder(folders, { name, parentId });
            saveSettings();
            globalThis.toastr?.success?.(tr('folderCreated', { name: folder.name }));
            return folder;
        },
    });

    if (!picked) return;

    assignItemsToFolder(folders, assignments, chatKeys, picked.targetFolderId);
    saveSettings();

    if (picked.targetFolderId) {
        const target = folders.find(f => f.id === picked.targetFolderId);
        globalThis.toastr?.success?.(tr('movedToFolder', { name: target?.name || '' }));
    } else {
        globalThis.toastr?.success?.(tr('movedToRoot'));
    }

    if (isChatBatchMode) {
        isChatBatchMode = false;
        selectedChatKeys.clear();
    }
    renderChatFolderView();
}

/**
 * Public helper for moving the currently open chat into a folder directly (e.g. from wand menu).
 */
export async function moveCurrentChatToFolder() {
    const context = getStContext();
    const scope = getActiveChatScope();
    const rawChatId = context?.getCurrentChatId?.() || context?.chatId;
    const chatKey = stripJsonlExt(rawChatId);

    if (!scope || !chatKey) {
        globalThis.toastr?.info?.(tr('noActiveChatForFolder'));
        return;
    }

    await openChatMovePicker(scope.scopeKey, [chatKey], chatKey);
}

/**
 * Handles creating a new chat folder in the active scope.
 */
async function handleCreateChatFolder() {
    const scope = getActiveChatScope();
    if (!scope) return;
    const { scopeKey, folders } = scope;
    const activeFolderId = getActiveChatFolderId(scopeKey, folders);

    const form = await openFolderFormPopup({
        mode: 'create',
        folders,
        defaultParentId: activeFolderId,
    });
    if (!form) return;

    const created = createFolder(folders, form);
    saveSettings();
    globalThis.toastr?.success?.(tr('folderCreated', { name: created.name }));
    renderChatFolderView();
}

/**
 * Handles editing a chat folder.
 * @param {string} scopeKey
 * @param {object} folder
 */
async function handleEditChatFolder(scopeKey, folder) {
    const settings = getSettings();
    const { folders } = ensureChatScope(settings, scopeKey);

    const form = await openFolderFormPopup({
        mode: 'edit',
        folder,
        folders,
    });
    if (!form) return;

    updateFolder(folders, folder.id, form);
    saveSettings();
    globalThis.toastr?.success?.(tr('folderUpdated', { name: form.name }));
    renderChatFolderView();
}

/**
 * Handles deleting a chat folder (chats inside are kept and moved to parent/root).
 * @param {string} scopeKey
 * @param {object} folder
 */
async function handleDeleteChatFolder(scopeKey, folder) {
    const confirmed = await confirmDeleteFolderPopup(folder.name);
    if (!confirmed) return;

    const settings = getSettings();
    const { folders, assignments } = ensureChatScope(settings, scopeKey);
    const fallbackParent = folder.parentId || null;
    deleteFolder(folders, assignments, folder.id);
    if (activeChatFolderByScope.get(scopeKey) === folder.id) {
        activeChatFolderByScope.set(scopeKey, fallbackParent);
    }
    saveSettings();
    globalThis.toastr?.success?.(tr('folderDeleted', { name: folder.name }));
    renderChatFolderView();
}

/**
 * Moves dropped chats to a folder or root.
 */
function handleDropItemsToChatFolder(scopeKey, chatKeys, targetFolderId) {
    const settings = getSettings();
    const { folders, assignments } = ensureChatScope(settings, scopeKey);
    assignItemsToFolder(folders, assignments, chatKeys, targetFolderId);
    saveSettings();

    if (targetFolderId) {
        const target = folders.find(f => f.id === targetFolderId);
        globalThis.toastr?.success?.(tr('movedToFolder', { name: target?.name || '' }));
    } else {
        globalThis.toastr?.success?.(tr('movedToRoot'));
    }

    if (isChatBatchMode) {
        isChatBatchMode = false;
        selectedChatKeys.clear();
    }
    renderChatFolderView();
}

/**
 * Re-parents a dropped chat folder.
 */
function handleDropFolderToChatParent(scopeKey, folderId, targetParentId) {
    const settings = getSettings();
    const { folders } = ensureChatScope(settings, scopeKey);
    try {
        updateFolder(folders, folderId, { parentId: targetParentId });
        saveSettings();
        renderChatFolderView();
    } catch (error) {
        console.warn('[st-folders] Chat folder move rejected:', error);
    }
}

/**
 * Clears chat folder DOM decorations when plugin is disabled.
 * @param {HTMLElement} selectChatDiv
 */
function clearChatDecorations(selectChatDiv) {
    withSuppressedChatObserver(() => {
        selectChatDiv.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());
        selectChatDiv.querySelectorAll('.select_chat_block_wrapper').forEach((wrapper) => {
            if (!(wrapper instanceof HTMLElement)) return;
            if (wrapper.dataset.stfHiddenByFolder === '1') {
                wrapper.style.display = '';
                delete wrapper.dataset.stfHiddenByFolder;
            }
            wrapper.classList.remove('stf-batch-selected', 'stf-chat-decorated');
            wrapper.querySelector('.stf-folder-badge')?.remove();
            wrapper.querySelector('.stf-chat-move-btn')?.remove();
            wrapper.querySelector('.select_chat_block')?.removeAttribute('draggable');
        });
    });
}

/**
 * Applies folder UI inside `#select_chat_div`.
 */
export function renderChatFolderView() {
    const selectChatDiv = document.getElementById('select_chat_div');
    if (!selectChatDiv) return;

    const scope = getActiveChatScope();
    const settings = getSettings();

    if (!settings.enabled || !scope) {
        clearChatDecorations(selectChatDiv);
        updateChatToolbar(scope?.scopeKey || null, scope?.folders || []);
        return;
    }

    const { scopeKey, folders, assignments } = scope;
    if (lastScopeKey !== scopeKey) {
        lastScopeKey = scopeKey;
        isChatBatchMode = false;
        selectedChatKeys.clear();
    }

    const searchInput = document.getElementById('select_chat_search');
    const searchQuery = String(searchInput instanceof HTMLInputElement ? searchInput.value : '').trim().toLowerCase();
    const wrappers = [...selectChatDiv.querySelectorAll(':scope > .select_chat_block_wrapper')].filter(
        el => el instanceof HTMLElement,
    );

    if (!searchQuery) {
        const currentKeys = new Set();
        for (const w of wrappers) {
            const k = getChatKeyFromWrapper(w);
            if (k) currentKeys.add(k);
        }
        knownChatKeysByScope.set(scopeKey, currentKeys);
    }

    const validKeys = knownChatKeysByScope.get(scopeKey) || null;
    const statsMap = computeFolderStats(folders, assignments, validKeys);
    const activeFolderId = getActiveChatFolderId(scopeKey, folders);
    const validFolderIds = new Set(folders.map(f => f.id));

    let activeChatKey = null;
    for (const w of wrappers) {
        if (isWrapperCurrentChat(w)) {
            activeChatKey = getChatKeyFromWrapper(w);
            break;
        }
    }
    if (!activeChatKey) {
        const ctx = getStContext();
        activeChatKey = stripJsonlExt(ctx?.getCurrentChatId?.() || ctx?.chatId || '');
    }

    withSuppressedChatObserver(() => {
        selectChatDiv.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());

        const activeDescendants = activeFolderId ? getDescendantIds(folders, activeFolderId) : null;
        const foldersToShow = searchQuery
            ? sortFolders(folders).filter((f) => {
                if (!f.name.toLowerCase().includes(searchQuery)) return false;
                if (!activeFolderId) return true;
                return activeDescendants.has(f.id) && f.id !== activeFolderId;
            })
            : sortFolders(folders.filter(f => (f.parentId || null) === activeFolderId));

        const frag = document.createDocumentFragment();
        for (const folder of foldersToShow) {
            const stats = statsMap.get(folder.id) || { directItems: 0, totalItems: 0, directSubfolders: 0 };
            frag.appendChild(buildFolderCard({
                domain: 'chat',
                folder,
                folders,
                stats,
                hasActiveIndicator: folderContainsActiveChat(folder.id, folders, assignments, activeChatKey),
                onOpen: (id) => navigateToChatFolder(scopeKey, id),
                onEdit: (fld) => handleEditChatFolder(scopeKey, fld),
                onDelete: (fld) => handleDeleteChatFolder(scopeKey, fld),
                onDropItems: (keys, targetId) => handleDropItemsToChatFolder(scopeKey, keys, targetId),
                onDropFolder: (fldId, targetParentId) => handleDropFolderToChatParent(scopeKey, fldId, targetParentId),
            }));
        }
        selectChatDiv.prepend(frag);

        const showBadge = Boolean(searchQuery) || (!activeFolderId && !settings.hideFolderedChatsInRoot);
        let visibleWrappersCount = 0;

        for (const wrapper of wrappers) {
            const chatKey = getChatKeyFromWrapper(wrapper);
            const assigned = assignments[chatKey];
            const effectiveFolder = assigned && validFolderIds.has(assigned) ? assigned : null;

            let shouldShow = true;
            if (searchQuery) {
                shouldShow = !activeDescendants || Boolean(effectiveFolder && activeDescendants.has(effectiveFolder));
            } else if (activeFolderId) {
                shouldShow = effectiveFolder === activeFolderId;
            } else if (settings.hideFolderedChatsInRoot && effectiveFolder) {
                shouldShow = false;
            }

            if (shouldShow) {
                if (wrapper.dataset.stfHiddenByFolder === '1') {
                    wrapper.style.display = '';
                    delete wrapper.dataset.stfHiddenByFolder;
                }
                decorateChatWrapper(wrapper, scope, showBadge);
                visibleWrappersCount++;
            } else {
                wrapper.style.display = 'none';
                wrapper.dataset.stfHiddenByFolder = '1';
            }
        }

        if (activeFolderId && foldersToShow.length === 0 && visibleWrappersCount === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'stf-empty-folder-hint';
            emptyEl.textContent = tr('emptyChatFolder');
            selectChatDiv.appendChild(emptyEl);
        }
    });

    updateChatToolbar(scopeKey, folders);
}

/**
 * Schedules a single coalesced render after SillyTavern finishes batch-appending chat blocks.
 */
function scheduleChatRender() {
    if (chatRenderScheduled) return;
    chatRenderScheduled = true;
    queueMicrotask(() => {
        chatRenderScheduled = false;
        renderChatFolderView();
    });
}

/**
 * Mounts `#stf_chat_toolbar` inside `#select_chat_popup` and binds observers/handlers.
 */
function ensureChatToolbarMounted() {
    const popupEl = document.getElementById('select_chat_popup');
    const selectChatDiv = document.getElementById('select_chat_div');
    if (!popupEl || !selectChatDiv) return;

    if (!document.getElementById('stf_chat_toolbar')) {
        chatToolbarEl = document.createElement('div');
        chatToolbarEl.id = 'stf_chat_toolbar';
        chatToolbarEl.className = 'stf-toolbar stf-chat-toolbar';

        const topRow = document.createElement('div');
        topRow.className = 'stf-toolbar-row';

        chatBackBtn = document.createElement('button');
        chatBackBtn.type = 'button';
        chatBackBtn.className = 'menu_button stf-back-btn';
        chatBackBtn.appendChild(createIcon('fa-arrow-left'));
        chatBackBtn.addEventListener('click', () => {
            const scope = getActiveChatScope();
            if (!scope) return;
            const activeId = getActiveChatFolderId(scope.scopeKey, scope.folders);
            const crumbs = getBreadcrumbs(scope.folders, activeId);
            const parentId = crumbs.length >= 2 ? crumbs[crumbs.length - 2].id : null;
            navigateToChatFolder(scope.scopeKey, parentId);
        });

        chatBreadcrumbEl = document.createElement('div');
        chatBreadcrumbEl.className = 'stf-breadcrumbs';

        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'stf-toolbar-actions';

        chatNewFolderBtn = document.createElement('button');
        chatNewFolderBtn.type = 'button';
        chatNewFolderBtn.className = 'menu_button menu_button_icon stf-toolbar-btn';
        chatNewFolderBtn.appendChild(createIcon('fa-folder-plus'));
        const newLabel = document.createElement('span');
        newLabel.textContent = tr('newFolderShort');
        chatNewFolderBtn.appendChild(newLabel);
        chatNewFolderBtn.addEventListener('click', handleCreateChatFolder);

        chatBatchBtn = document.createElement('button');
        chatBatchBtn.type = 'button';
        chatBatchBtn.className = 'menu_button menu_button_icon stf-toolbar-btn';
        chatBatchBtn.appendChild(createIcon('fa-list-check'));
        const batchLabel = document.createElement('span');
        batchLabel.textContent = tr('batchSelect');
        chatBatchBtn.appendChild(batchLabel);
        chatBatchBtn.addEventListener('click', () => {
            isChatBatchMode = !isChatBatchMode;
            if (!isChatBatchMode) selectedChatKeys.clear();
            renderChatFolderView();
        });

        chatHideToggleBtn = document.createElement('button');
        chatHideToggleBtn.type = 'button';
        chatHideToggleBtn.className = 'menu_button stf-toolbar-btn stf-icon-only-btn';
        chatHideToggleBtn.appendChild(createIcon('fa-eye-slash'));
        chatHideToggleBtn.addEventListener('click', () => {
            const settings = getSettings();
            settings.hideFolderedChatsInRoot = !settings.hideFolderedChatsInRoot;
            saveSettings();
            renderChatFolderView();
        });

        actionsWrap.append(chatNewFolderBtn, chatBatchBtn, chatHideToggleBtn);
        topRow.append(chatBackBtn, chatBreadcrumbEl, actionsWrap);

        // Batch action bar
        chatBatchBarEl = document.createElement('div');
        chatBatchBarEl.className = 'stf-batch-bar';
        chatBatchBarEl.style.display = 'none';

        const countSpan = document.createElement('span');
        countSpan.className = 'stf-batch-count';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'menu_button stf-batch-select-all';
        selectAllBtn.addEventListener('click', () => {
            const wrappers = selectChatDiv.querySelectorAll(':scope > .select_chat_block_wrapper');
            const visibleKeys = [];
            for (const w of wrappers) {
                if (!(w instanceof HTMLElement) || w.style.display === 'none') continue;
                const k = getChatKeyFromWrapper(w);
                if (k) visibleKeys.push(k);
            }
            const allSelected = visibleKeys.length > 0 && visibleKeys.every(k => selectedChatKeys.has(k));
            if (allSelected) {
                visibleKeys.forEach(k => selectedChatKeys.delete(k));
            } else {
                visibleKeys.forEach(k => selectedChatKeys.add(k));
            }
            renderChatFolderView();
        });

        const batchMoveBtn = document.createElement('button');
        batchMoveBtn.type = 'button';
        batchMoveBtn.className = 'menu_button stf-batch-move stf-primary-btn';
        batchMoveBtn.addEventListener('click', async () => {
            const scope = getActiveChatScope();
            if (!scope) return;
            await openChatMovePicker(scope.scopeKey, [...selectedChatKeys]);
        });

        const batchMoveOutBtn = document.createElement('button');
        batchMoveOutBtn.type = 'button';
        batchMoveOutBtn.className = 'menu_button stf-batch-move-out';
        batchMoveOutBtn.addEventListener('click', () => {
            if (!selectedChatKeys.size) {
                globalThis.toastr?.info?.(tr('pleaseSelectItems'));
                return;
            }
            const scope = getActiveChatScope();
            if (!scope) return;
            handleDropItemsToChatFolder(scope.scopeKey, [...selectedChatKeys], null);
        });

        const batchCancelBtn = document.createElement('button');
        batchCancelBtn.type = 'button';
        batchCancelBtn.className = 'menu_button stf-batch-cancel';
        batchCancelBtn.addEventListener('click', () => {
            isChatBatchMode = false;
            selectedChatKeys.clear();
            renderChatFolderView();
        });

        chatBatchBarEl.append(countSpan, selectAllBtn, batchMoveBtn, batchMoveOutBtn, batchCancelBtn);
        chatToolbarEl.append(topRow, chatBatchBarEl);

        selectChatDiv.parentNode.insertBefore(chatToolbarEl, selectChatDiv);
    }

    // Capture-phase click handler on `#select_chat_div` for chat batch selection
    if (selectChatDiv.dataset.stfBatchClickBound !== '1') {
        selectChatDiv.dataset.stfBatchClickBound = '1';
        selectChatDiv.addEventListener('click', (e) => {
            if (!isChatBatchMode) return;
            if (!(e.target instanceof Element)) return;
            if (e.target.closest('.stf-folder-card, .stf-chat-move-btn, .stf-icon-btn, .renameChatButton, .exportRawChatButton, .exportChatButton, .PastChat_cross')) {
                return;
            }
            const wrapper = e.target.closest('.select_chat_block_wrapper');
            if (!(wrapper instanceof HTMLElement)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const chatKey = getChatKeyFromWrapper(wrapper);
            if (!chatKey) return;
            if (selectedChatKeys.has(chatKey)) {
                selectedChatKeys.delete(chatKey);
            } else {
                selectedChatKeys.add(chatKey);
            }
            wrapper.classList.toggle('stf-batch-selected', selectedChatKeys.has(chatKey));
            const scope = getActiveChatScope();
            if (scope) updateChatToolbar(scope.scopeKey, scope.folders);
        }, true);
    }

    // Observe `#select_chat_div` mutations caused by `displayPastChats` / `displayChats`
    if (!chatObserver && typeof MutationObserver === 'function') {
        chatObserver = new MutationObserver(() => {
            if (isApplyingChatDom) return;
            scheduleChatRender();
        });
        chatObserver.observe(selectChatDiv, { childList: true });
    }

    // Observe `#shadow_select_chat_popup` opening so toolbar always refreshes even on 0 chats
    const shadowPopup = document.getElementById('shadow_select_chat_popup');
    if (shadowPopup && !popupAttrObserver && typeof MutationObserver === 'function') {
        popupAttrObserver = new MutationObserver(() => {
            if (shadowPopup.style.display !== 'none') {
                scheduleChatRender();
            }
        });
        popupAttrObserver.observe(shadowPopup, { attributes: true, attributeFilter: ['style'] });
    }
}

/**
 * Initializes Chat Folder UI and SillyTavern chat lifecycle hooks.
 */
export function initChatFolders() {
    ensureChatToolbarMounted();

    const context = getStContext();
    if (!context?.eventSource || !context?.eventTypes) return;
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        const scope = getActiveChatScope();
        if (scope && lastScopeKey !== scope.scopeKey) {
            isChatBatchMode = false;
            selectedChatKeys.clear();
        }
        if (document.getElementById('shadow_select_chat_popup')?.style.display !== 'none') {
            renderChatFolderView();
        }
    });

    eventSource.on(eventTypes.CHAT_RENAMED, (payload) => {
        if (!payload?.oldFileName || !payload?.newFileName) return;
        const ctx = getStContext();
        const scopeKey = payload.groupId
            ? makeGroupKey(payload.groupId)
            : (payload.avatarId ? makeCharKey(payload.avatarId) : getActiveChatScope()?.scopeKey);

        if (!scopeKey) return;
        const settings = getSettings();
        const scope = ensureChatScope(settings, scopeKey);
        const oldKey = stripJsonlExt(payload.oldFileName);
        const newKey = stripJsonlExt(payload.newFileName);

        if (migrateAssignmentKey(scope.assignments, oldKey, newKey)) {
            saveSettings();
            if (ctx && document.getElementById('shadow_select_chat_popup')?.style.display !== 'none') {
                scheduleChatRender();
            }
        }
    });

    eventSource.on(eventTypes.CHAT_DELETED, (chatName) => {
        const key = stripJsonlExt(chatName);
        if (!key) return;
        const scope = getActiveChatScope();
        if (!scope) return;
        if (key in scope.assignments) {
            delete scope.assignments[key];
            saveSettings();
        }
    });

    eventSource.on(eventTypes.GROUP_CHAT_DELETED, (chatName) => {
        const ctx = getStContext();
        if (!ctx?.groupId) return;
        const key = stripJsonlExt(chatName);
        if (!key) return;
        const settings = getSettings();
        const scope = ensureChatScope(settings, makeGroupKey(ctx.groupId));
        if (key in scope.assignments) {
            delete scope.assignments[key];
            saveSettings();
        }
    });
}
