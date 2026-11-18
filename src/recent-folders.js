import {
    assignItemsToFolder,
    computeFolderStats,
    createFolder,
    deleteFolder,
    deleteRecentAssignmentsByScope,
    getBreadcrumbs,
    getChatScopeKey,
    makeCharKey,
    makeGroupKey,
    makeRecentChatKey,
    migrateAssignmentKey,
    migrateRecentAssignmentsByScope,
    sortFolders,
    stripJsonlExt,
    updateFolder,
} from './folder-store.js';
import { tr } from './i18n.js';
import {
    getSettings,
    getStContext,
    saveSettings,
} from './runtime.js';
import {
    buildFolderBadge,
    buildFolderCard,
    confirmDeleteFolderPopup,
    createFolderToolbarScaffold,
    createIcon,
    openFolderFormPopup,
    openFolderPickerPopup,
    resolveEntityPreviewUrls,
    revealFolderCard,
    setActiveDragPayload,
    setElementFolderHidden,
    updateFolderToolbarScaffold,
} from './ui-dialogs.js';

let activeRecentFolderId = null;
let isRecentBatchMode = false;
const selectedRecentKeys = new Set();

let isApplyingRecentDom = false;
let recentRenderScheduled = false;
let chatContainerObserver = null;
let recentListObserver = null;

/** @type {ReturnType<typeof createFolderToolbarScaffold> | null} */
let toolbarRefs = null;
/** @type {WeakSet<HTMLElement>} */
const knownRecentLists = new WeakSet();
/** @type {{ compositeKey: string, chatKey: string, at: number } | null} */
let pendingRecentDelete = null;

/**
 * Runs DOM mutations inside `.welcomeRecent` without re-triggering self-observers.
 * @param {() => void} fn
 */
function withSuppressedRecentObserver(fn) {
    isApplyingRecentDom = true;
    try {
        fn();
    } finally {
        recentListObserver?.takeRecords?.();
        chatContainerObserver?.takeRecords?.();
        isApplyingRecentDom = false;
    }
}

/**
 * Extracts composite assignment key (`char:<avatar>::<chat>` or `group:<id>::<chat>`) from a `.recentChat` element.
 * @param {HTMLElement} cardEl
 * @returns {string}
 */
function getRecentKeyFromCard(cardEl) {
    const file = cardEl.getAttribute('data-file') || '';
    const groupId = cardEl.getAttribute('data-group') || '';
    const avatar = cardEl.getAttribute('data-avatar') || '';
    if (!file) return '';

    const scopeKey = groupId ? makeGroupKey(groupId) : (avatar ? makeCharKey(avatar) : '');
    return scopeKey ? makeRecentChatKey(scopeKey, file) : '';
}

/**
 * Extracts a human-friendly display title from a `.recentChat` element for dialogs.
 * @param {HTMLElement} cardEl
 * @returns {string}
 */
function getRecentTitleFromCard(cardEl) {
    const charName = cardEl.querySelector('.characterName')?.textContent?.trim() || '';
    const file = stripJsonlExt(cardEl.getAttribute('data-file') || '');
    return charName && file ? `${charName} - ${file}` : (file || charName);
}

/**
 * Resolves the current welcome panel containers inside `#chat`.
 */
function getWelcomeContainers() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return null;
    const welcomePanel = chatEl.querySelector('.welcomePanel');
    if (!(welcomePanel instanceof HTMLElement)) return null;
    const welcomeRecent = welcomePanel.querySelector('.welcomeRecent');
    const recentChatList = welcomeRecent?.querySelector('.recentChatList');
    if (!(welcomeRecent instanceof HTMLElement) || !(recentChatList instanceof HTMLElement)) {
        return null;
    }
    return { chatEl, welcomePanel, welcomeRecent, recentChatList };
}

/**
 * Updates toolbar controls for the Recent Chats folder view.
 */
function updateRecentToolbar() {
    if (!toolbarRefs) return;
    const settings = getSettings();

    if (activeRecentFolderId && !settings.recentFolders.some(f => f.id === activeRecentFolderId)) {
        activeRecentFolderId = null;
    }

    updateFolderToolbarScaffold(toolbarRefs, {
        enabled: settings.enabled,
        domain: 'recent',
        rootLabel: tr('rootRecentChats'),
        folders: settings.recentFolders,
        activeFolderId: activeRecentFolderId,
        isBatchMode: isRecentBatchMode,
        selectedCount: selectedRecentKeys.size,
        hideInRoot: settings.hideFolderedChatsInRoot,
        hideActiveHintKey: 'hideChatsActiveHint',
        hideInactiveHintKey: 'hideChatsInactiveHint',
        onNavigate: navigateToRecentFolder,
        onDropItems: handleDropItemsToRecentFolder,
        onDropFolder: handleDropFolderToRecentParent,
    });
}

/**
 * Navigates into a Recent Chats folder (or root when `folderId === null`).
 * @param {string|null} folderId
 */
function navigateToRecentFolder(folderId) {
    const settings = getSettings();
    if (folderId && !settings.recentFolders.some(f => f.id === folderId)) {
        activeRecentFolderId = null;
    } else {
        activeRecentFolderId = folderId;
    }
    selectedRecentKeys.clear();
    renderRecentChatFolderView();
}

/**
 * Opens folder picker popup to move one or more Recent Chats into a folder.
 * @param {string[]} compositeKeys
 * @param {string} [singleName]
 */
async function openRecentMovePicker(compositeKeys, singleName = '') {
    if (!compositeKeys.length) {
        globalThis.toastr?.info?.(tr('pleaseSelectItems'));
        return;
    }

    const settings = getSettings();
    const currentFolderId = compositeKeys.length === 1
        ? (settings.recentAssignments[compositeKeys[0]] || null)
        : null;

    const containers = getWelcomeContainers();
    const validKeys = containers
        ? new Set(
            [...containers.recentChatList.querySelectorAll(':scope > .recentChat')]
                .filter(el => el instanceof HTMLElement)
                .map(el => getRecentKeyFromCard(el))
                .filter(Boolean),
        )
        : null;

    const title = compositeKeys.length === 1
        ? tr('pickerTitleSingle', { name: singleName || compositeKeys[0] })
        : tr('pickerTitleBatch', { count: compositeKeys.length });

    const picked = await openFolderPickerPopup({
        title,
        folders: settings.recentFolders,
        assignments: settings.recentAssignments,
        currentFolderId,
        validItemKeys: validKeys,
        defaultParentId: activeRecentFolderId,
        onCreateFolder: (name, parentId) => {
            const latest = getSettings();
            const folder = createFolder(latest.recentFolders, { name, parentId });
            saveSettings();
            globalThis.toastr?.success?.(tr('folderCreated', { name: folder.name }));
            return folder;
        },
    });

    if (!picked) return;

    const latest = getSettings();
    assignItemsToFolder(latest.recentFolders, latest.recentAssignments, compositeKeys, picked.targetFolderId);
    saveSettings();

    if (picked.targetFolderId) {
        const target = latest.recentFolders.find(f => f.id === picked.targetFolderId);
        globalThis.toastr?.success?.(tr('movedToFolder', { name: target?.name || '' }));
    } else {
        globalThis.toastr?.success?.(tr('movedToRoot'));
    }

    if (isRecentBatchMode) {
        isRecentBatchMode = false;
        selectedRecentKeys.clear();
    }
    renderRecentChatFolderView();
}

/**
 * Moves the currently open chat into a Recent Chats folder (invoked from wand menu).
 */
export async function moveCurrentChatToRecentFolder() {
    const context = getStContext();
    const scopeKey = getChatScopeKey(context);
    const rawChatId = context?.getCurrentChatId?.() || context?.chatId;
    const chatKey = stripJsonlExt(rawChatId);

    if (!scopeKey || !chatKey) {
        globalThis.toastr?.info?.(tr('noActiveChatForFolder'));
        return;
    }

    const compositeKey = makeRecentChatKey(scopeKey, chatKey);
    await openRecentMovePicker([compositeKey], chatKey);
}

/**
 * Handles creating a new folder in Recent Chats.
 */
async function handleCreateRecentFolder() {
    const initial = getSettings();
    const form = await openFolderFormPopup({
        mode: 'create',
        folders: initial.recentFolders,
        defaultParentId: activeRecentFolderId,
    });
    if (!form) return;

    const settings = getSettings();
    const created = createFolder(settings.recentFolders, form);
    saveSettings();
    globalThis.toastr?.success?.(tr('folderCreated', { name: created.name }));

    activeRecentFolderId = created.parentId || null;
    renderRecentChatFolderView();
    const containers = getWelcomeContainers();
    if (containers) {
        revealFolderCard(containers.recentChatList, created.id);
    }
}

/**
 * Handles editing a Recent Chats folder.
 * @param {object} folder
 */
async function handleEditRecentFolder(folder) {
    const settings = getSettings();
    const form = await openFolderFormPopup({
        mode: 'edit',
        folder,
        folders: settings.recentFolders,
    });
    if (!form) return;

    const latest = getSettings();
    updateFolder(latest.recentFolders, folder.id, form);
    saveSettings();
    globalThis.toastr?.success?.(tr('folderUpdated', { name: form.name }));
    renderRecentChatFolderView();
}

/**
 * Handles deleting a Recent Chats folder (keeping all chats safe).
 * @param {object} folder
 */
async function handleDeleteRecentFolder(folder) {
    const confirmed = await confirmDeleteFolderPopup(folder.name);
    if (!confirmed) return;

    const settings = getSettings();
    const fallbackParent = folder.parentId || null;
    deleteFolder(settings.recentFolders, settings.recentAssignments, folder.id);
    if (activeRecentFolderId === folder.id) {
        activeRecentFolderId = fallbackParent;
    }
    saveSettings();
    globalThis.toastr?.success?.(tr('folderDeleted', { name: folder.name }));
    renderRecentChatFolderView();
}

/**
 * Handles dropping Recent Chats onto a folder or root.
 * @param {string[]} compositeKeys
 * @param {string|null} targetFolderId
 */
function handleDropItemsToRecentFolder(compositeKeys, targetFolderId) {
    const settings = getSettings();
    assignItemsToFolder(settings.recentFolders, settings.recentAssignments, compositeKeys, targetFolderId);
    saveSettings();

    if (targetFolderId) {
        const target = settings.recentFolders.find(f => f.id === targetFolderId);
        globalThis.toastr?.success?.(tr('movedToFolder', { name: target?.name || '' }));
    } else {
        globalThis.toastr?.success?.(tr('movedToRoot'));
    }

    if (isRecentBatchMode) {
        isRecentBatchMode = false;
        selectedRecentKeys.clear();
    }
    renderRecentChatFolderView();
}

/**
 * Handles re-parenting a Recent Chats folder via drag-and-drop.
 * @param {string} folderId
 * @param {string|null} targetParentId
 */
function handleDropFolderToRecentParent(folderId, targetParentId) {
    const settings = getSettings();
    try {
        updateFolder(settings.recentFolders, folderId, { parentId: targetParentId });
        saveSettings();
        renderRecentChatFolderView();
    } catch (error) {
        console.warn('[st-folders] Recent folder move rejected:', error);
    }
}

/**
 * Decorates a `.recentChat` row with move button, optional folder badge, drag-and-drop, and batch highlight.
 * @param {HTMLElement} cardEl
 * @param {object} settings
 * @param {boolean} showBadge
 */
function decorateRecentChatCard(cardEl, settings, showBadge) {
    const compositeKey = getRecentKeyFromCard(cardEl);
    if (!compositeKey) return;

    const assignedFolderId = settings.recentAssignments[compositeKey] || null;
    const folder = assignedFolderId ? settings.recentFolders.find(f => f.id === assignedFolderId) : null;

    cardEl.classList.add('stf-recent-decorated');
    cardEl.dataset.stfRecentKey = compositeKey;
    cardEl.classList.toggle('stf-batch-selected', isRecentBatchMode && selectedRecentKeys.has(compositeKey));

    // Folder badge inside `.chatNameContainer`
    cardEl.querySelector('.stf-folder-badge')?.remove();
    if (showBadge && folder) {
        const badge = buildFolderBadge({
            folder,
            folders: settings.recentFolders,
            extraClass: 'stf-recent-folder-badge',
            onOpen: navigateToRecentFolder,
        });
        const nameContainer = cardEl.querySelector('.chatNameContainer');
        const dateEl = nameContainer?.querySelector('.chatDate');
        if (nameContainer && dateEl) {
            nameContainer.insertBefore(badge, dateEl);
        } else if (nameContainer) {
            nameContainer.appendChild(badge);
        }
    }

    // Move-to-folder button inside `.chatActions`
    const actionsEl = cardEl.querySelector('.chatActions');
    if (actionsEl && !actionsEl.querySelector('.stf-recent-move-btn')) {
        const moveBtn = document.createElement('button');
        moveBtn.type = 'button';
        moveBtn.className = 'menu_button menu_button_icon stf-recent-move-btn';
        moveBtn.title = tr('moveToFolder');
        moveBtn.appendChild(createIcon('fa-folder-open'));
        moveBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const currentKey = getRecentKeyFromCard(cardEl);
            if (currentKey) {
                await openRecentMovePicker([currentKey], getRecentTitleFromCard(cardEl));
            }
        });
        actionsEl.insertBefore(moveBtn, actionsEl.firstChild);
    }

    // Drag & drop source (idempotent)
    cardEl.setAttribute('draggable', 'true');
    if (cardEl.dataset.stfDragBound !== '1') {
        cardEl.dataset.stfDragBound = '1';

        cardEl.addEventListener('dragstart', (e) => {
            const currentKey = getRecentKeyFromCard(cardEl);
            if (!currentKey) return;
            const keys = isRecentBatchMode && selectedRecentKeys.has(currentKey) && selectedRecentKeys.size > 0
                ? [...selectedRecentKeys]
                : [currentKey];

            setActiveDragPayload({
                domain: 'recent',
                kind: 'items',
                keys,
            });
            cardEl.classList.add('stf-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', keys.join(','));
            }
        });

        cardEl.addEventListener('dragend', () => {
            cardEl.classList.remove('stf-dragging');
            setActiveDragPayload(null);
        });
    }
}

/**
 * Removes folder decorations from `.recentChatList` when extension is disabled.
 * @param {HTMLElement} recentChatList
 */
function clearRecentDecorations(recentChatList) {
    withSuppressedRecentObserver(() => {
        recentChatList.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());
        recentChatList.querySelectorAll(':scope > .recentChat').forEach((card) => {
            if (!(card instanceof HTMLElement)) return;
            setElementFolderHidden(card, false);
            card.classList.remove(
                'stf-force-show-recent',
                'stf-collapsed-extra',
                'stf-batch-selected',
                'stf-recent-decorated',
            );
            card.querySelector('.stf-folder-badge')?.remove();
            card.querySelector('.stf-recent-move-btn')?.remove();
            card.removeAttribute('draggable');
        });
        const showMoreBtn = recentChatList.querySelector(':scope > button.showMoreChats');
        if (showMoreBtn instanceof HTMLElement) setElementFolderHidden(showMoreBtn, false);
        const noRecentEl = recentChatList.querySelector(':scope > .noRecentChat');
        if (noRecentEl instanceof HTMLElement) setElementFolderHidden(noRecentEl, false);
    });
}

/**
 * Mounts `#stf_recent_chat_toolbar` inside `.welcomeRecent` and binds DOM listeners & observers.
 */
function ensureRecentToolbarMounted() {
    const containers = getWelcomeContainers();
    if (!containers) return null;

    const { welcomeRecent, recentChatList } = containers;

    if (!document.getElementById('stf_recent_chat_toolbar')) {
        toolbarRefs = createFolderToolbarScaffold({
            id: 'stf_recent_chat_toolbar',
            extraClass: 'stf-recent-toolbar',
            onBack: () => {
                const settings = getSettings();
                const crumbs = getBreadcrumbs(settings.recentFolders, activeRecentFolderId);
                const parentId = crumbs.length >= 2 ? crumbs[crumbs.length - 2].id : null;
                navigateToRecentFolder(parentId);
            },
            onCreateFolder: handleCreateRecentFolder,
            onToggleBatch: () => {
                isRecentBatchMode = !isRecentBatchMode;
                if (!isRecentBatchMode) selectedRecentKeys.clear();
                renderRecentChatFolderView();
            },
            onToggleHide: () => {
                const settings = getSettings();
                settings.hideFolderedChatsInRoot = !settings.hideFolderedChatsInRoot;
                saveSettings();
                globalThis.toastr?.info?.(tr(settings.hideFolderedChatsInRoot ? 'hideChatsActiveHint' : 'hideChatsInactiveHint'));
                renderRecentChatFolderView();
            },
            onBatchSelectAll: () => {
                const current = getWelcomeContainers();
                if (!current) return;
                const cards = current.recentChatList.querySelectorAll(':scope > .recentChat');
                const keys = [];
                for (const card of cards) {
                    if (!(card instanceof HTMLElement)) continue;
                    const isHidden = card.classList.contains('stf-hidden-by-folder')
                        || card.classList.contains('stf-collapsed-extra')
                        || (card.classList.contains('hidden') && !card.classList.contains('stf-force-show-recent'))
                        || card.style.display === 'none';
                    if (isHidden) continue;
                    const k = getRecentKeyFromCard(card);
                    if (k) keys.push(k);
                }
                const allSelected = keys.length > 0 && keys.every(k => selectedRecentKeys.has(k));
                if (allSelected) {
                    keys.forEach(k => selectedRecentKeys.delete(k));
                } else {
                    keys.forEach(k => selectedRecentKeys.add(k));
                }
                renderRecentChatFolderView();
            },
            onBatchMove: async () => {
                await openRecentMovePicker([...selectedRecentKeys]);
            },
            onBatchMoveOut: () => {
                if (!selectedRecentKeys.size) {
                    globalThis.toastr?.info?.(tr('pleaseSelectItems'));
                    return;
                }
                handleDropItemsToRecentFolder([...selectedRecentKeys], null);
            },
            onBatchCancel: () => {
                isRecentBatchMode = false;
                selectedRecentKeys.clear();
                renderRecentChatFolderView();
            },
        });

        welcomeRecent.insertBefore(toolbarRefs.toolbarEl, recentChatList);
    }

    if (!knownRecentLists.has(recentChatList)) {
        knownRecentLists.add(recentChatList);

        // Capture-phase listener: batch selection & delete-target tracking
        recentChatList.addEventListener('click', (e) => {
            if (!(e.target instanceof Element)) return;

            const delBtn = e.target.closest('.deleteChat');
            if (delBtn) {
                const row = delBtn.closest('.recentChat');
                if (row instanceof HTMLElement) {
                    const compositeKey = getRecentKeyFromCard(row);
                    const file = stripJsonlExt(row.getAttribute('data-file') || '');
                    if (compositeKey && file) {
                        pendingRecentDelete = { compositeKey, chatKey: file, at: Date.now() };
                    }
                }
            }

            if (!isRecentBatchMode) return;
            if (e.target.closest('.stf-folder-card, .stf-recent-move-btn, .stf-icon-btn, .pinChat, .renameChat, .deleteChat, .showMoreChats')) {
                return;
            }
            const card = e.target.closest('.recentChat');
            if (!(card instanceof HTMLElement)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const k = getRecentKeyFromCard(card);
            if (!k) return;
            if (selectedRecentKeys.has(k)) {
                selectedRecentKeys.delete(k);
            } else {
                selectedRecentKeys.add(k);
            }
            card.classList.toggle('stf-batch-selected', selectedRecentKeys.has(k));
            updateRecentToolbar();
        }, true);

        // Bubble-phase listener for `button.showMoreChats` expand/collapse toggle
        recentChatList.addEventListener('click', (e) => {
            if (!(e.target instanceof Element)) return;
            if (e.target.closest('button.showMoreChats')) {
                renderRecentChatFolderView();
            }
        });

        recentListObserver?.disconnect?.();
        if (typeof MutationObserver === 'function') {
            recentListObserver = new MutationObserver(() => {
                if (isApplyingRecentDom) return;
                scheduleRecentRender();
            });
            recentListObserver.observe(recentChatList, { childList: true });
        }
    }

    return containers;
}

/**
 * Applies folder UI inside `.welcomePanel .welcomeRecent .recentChatList`.
 */
export function renderRecentChatFolderView() {
    const containers = ensureRecentToolbarMounted();
    if (!containers) return;

    const { recentChatList } = containers;
    const settings = getSettings();

    if (!settings.enabled) {
        clearRecentDecorations(recentChatList);
        updateRecentToolbar();
        return;
    }

    if (activeRecentFolderId && !settings.recentFolders.some(f => f.id === activeRecentFolderId)) {
        activeRecentFolderId = null;
    }

    const recentCards = [...recentChatList.querySelectorAll(':scope > .recentChat')].filter(
        el => el instanceof HTMLElement,
    );

    // Record SillyTavern's original collapsed/unhidden count once per panel render
    let origVisibleCount = 0;
    for (const card of recentCards) {
        if (card.dataset.stfOrigHidden === undefined) {
            card.dataset.stfOrigHidden = card.classList.contains('hidden') ? '1' : '0';
        }
        if (card.dataset.stfOrigHidden === '0') {
            origVisibleCount++;
        }
    }
    const collapsedLimit = origVisibleCount > 0 ? origVisibleCount : 3;

    const showMoreBtn = recentChatList.querySelector(':scope > button.showMoreChats');
    const noRecentEl = recentChatList.querySelector(':scope > .noRecentChat');
    const isExpanded = Boolean(showMoreBtn?.classList.contains('rotated'));

    const statsMap = computeFolderStats(settings.recentFolders, settings.recentAssignments);
    const validFolderIds = new Set(settings.recentFolders.map(f => f.id));

    withSuppressedRecentObserver(() => {
        recentChatList.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());

        const foldersToShow = sortFolders(
            settings.recentFolders.filter(f => (f.parentId || null) === activeRecentFolderId),
        );

        const frag = document.createDocumentFragment();
        for (const folder of foldersToShow) {
            const stats = statsMap.get(folder.id) || { directItems: 0, totalItems: 0, directSubfolders: 0, previewKeys: [] };
            frag.appendChild(buildFolderCard({
                domain: 'recent',
                folder,
                folders: settings.recentFolders,
                stats,
                previewUrls: resolveEntityPreviewUrls(stats.previewKeys),
                onOpen: navigateToRecentFolder,
                onEdit: handleEditRecentFolder,
                onDelete: handleDeleteRecentFolder,
                onDropItems: handleDropItemsToRecentFolder,
                onDropFolder: handleDropFolderToRecentParent,
            }));
        }
        if (foldersToShow.length > 0) {
            recentChatList.prepend(frag);
        }

        let visibleCardsCount = 0;
        let collapsedRemainingCount = 0;
        const showBadge = !activeRecentFolderId && !settings.hideFolderedChatsInRoot;

        for (const card of recentCards) {
            const compositeKey = getRecentKeyFromCard(card);
            const assigned = compositeKey ? settings.recentAssignments[compositeKey] : null;
            const effectiveFolder = assigned && validFolderIds.has(assigned) ? assigned : null;

            if (activeRecentFolderId) {
                if (effectiveFolder === activeRecentFolderId) {
                    setElementFolderHidden(card, false);
                    card.classList.add('stf-force-show-recent');
                    card.classList.remove('stf-collapsed-extra');
                    decorateRecentChatCard(card, settings, false);
                    visibleCardsCount++;
                } else {
                    card.classList.remove('stf-force-show-recent', 'stf-collapsed-extra');
                    setElementFolderHidden(card, true);
                }
            } else if (settings.hideFolderedChatsInRoot && effectiveFolder) {
                card.classList.remove('stf-force-show-recent', 'stf-collapsed-extra');
                setElementFolderHidden(card, true);
            } else {
                setElementFolderHidden(card, false);
                if (isExpanded || visibleCardsCount < collapsedLimit) {
                    card.classList.add('stf-force-show-recent');
                    card.classList.remove('stf-collapsed-extra');
                    visibleCardsCount++;
                } else {
                    card.classList.remove('stf-force-show-recent');
                    card.classList.add('stf-collapsed-extra');
                    collapsedRemainingCount++;
                }
                decorateRecentChatCard(card, settings, showBadge);
            }
        }

        if (showMoreBtn instanceof HTMLElement) {
            const shouldHideShowMore = Boolean(activeRecentFolderId) || (!isExpanded && collapsedRemainingCount === 0);
            setElementFolderHidden(showMoreBtn, shouldHideShowMore);
        }

        if (noRecentEl instanceof HTMLElement) {
            setElementFolderHidden(noRecentEl, Boolean(activeRecentFolderId));
        }

        if (activeRecentFolderId && foldersToShow.length === 0 && visibleCardsCount === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'stf-empty-folder-hint';
            emptyEl.textContent = tr('emptyRecentFolder');
            recentChatList.appendChild(emptyEl);
        }
    });

    updateRecentToolbar();
}

/**
 * Schedules a coalesced render when SillyTavern injects or updates `.welcomePanel` inside `#chat`.
 */
function scheduleRecentRender() {
    if (recentRenderScheduled) return;
    recentRenderScheduled = true;
    queueMicrotask(() => {
        recentRenderScheduled = false;
        renderRecentChatFolderView();
    });
}

/**
 * Cleans up a matching Recent Chat assignment when SillyTavern emits `CHAT_DELETED` / `GROUP_CHAT_DELETED`.
 * @param {string} chatName
 */
function handleChatDeletedEvent(chatName) {
    const key = stripJsonlExt(chatName);
    if (!key) return;

    const settings = getSettings();
    let changed = false;

    const scopeKey = getChatScopeKey(getStContext());
    if (scopeKey) {
        const compositeKey = makeRecentChatKey(scopeKey, key);
        if (compositeKey && (compositeKey in settings.recentAssignments)) {
            delete settings.recentAssignments[compositeKey];
            changed = true;
        }
    } else if (
        pendingRecentDelete
        && pendingRecentDelete.chatKey === key
        && (Date.now() - pendingRecentDelete.at) < 30_000
        && (pendingRecentDelete.compositeKey in settings.recentAssignments)
    ) {
        delete settings.recentAssignments[pendingRecentDelete.compositeKey];
        pendingRecentDelete = null;
        changed = true;
    }

    if (changed) saveSettings();
}

/**
 * Initializes Recent Chats Folder UI and SillyTavern lifecycle listeners.
 */
export function initRecentFolders() {
    const chatEl = document.getElementById('chat');
    if (chatEl && !chatContainerObserver && typeof MutationObserver === 'function') {
        chatContainerObserver = new MutationObserver(() => {
            if (isApplyingRecentDom) return;
            if (chatEl.querySelector('.welcomePanel .recentChatList')) {
                scheduleRecentRender();
            }
        });
        chatContainerObserver.observe(chatEl, { childList: true });
    }

    renderRecentChatFolderView();

    const context = getStContext();
    if (!context?.eventSource || !context?.eventTypes) return;
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        scheduleRecentRender();
    });

    eventSource.on(eventTypes.CHAT_RENAMED, (payload) => {
        if (!payload?.oldFileName || !payload?.newFileName) return;
        const scopeKey = payload.groupId
            ? makeGroupKey(payload.groupId)
            : (payload.avatarId ? makeCharKey(payload.avatarId) : getChatScopeKey(getStContext()));
        if (!scopeKey) return;

        const settings = getSettings();
        const oldKey = makeRecentChatKey(scopeKey, payload.oldFileName);
        const newKey = makeRecentChatKey(scopeKey, payload.newFileName);
        if (migrateAssignmentKey(settings.recentAssignments, oldKey, newKey)) {
            saveSettings();
            scheduleRecentRender();
        }
    });

    eventSource.on(eventTypes.CHAT_DELETED, handleChatDeletedEvent);
    eventSource.on(eventTypes.GROUP_CHAT_DELETED, handleChatDeletedEvent);

    eventSource.on(eventTypes.CHARACTER_DELETED, (payload) => {
        const avatar = payload?.character?.avatar;
        if (!avatar) return;
        const settings = getSettings();
        if (deleteRecentAssignmentsByScope(settings.recentAssignments, makeCharKey(avatar))) {
            saveSettings();
        }
    });

    eventSource.on(eventTypes.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
        const settings = getSettings();
        if (migrateRecentAssignmentsByScope(settings.recentAssignments, makeCharKey(oldAvatar), makeCharKey(newAvatar))) {
            saveSettings();
            scheduleRecentRender();
        }
    });
}
