import {
    assignItemsToFolder,
    computeFolderStats,
    createFolder,
    deleteFolder,
    getBreadcrumbs,
    getFolderPathLabel,
    makeCharKey,
    makeGroupKey,
    migrateAssignmentKey,
    sortCharacterEntities,
    sortFolders,
    updateFolder,
} from './folder-store.js';
import { tr } from './i18n.js';
import {
    getSettings,
    getStContext,
    getValidCharAndGroupKeys,
    notifyAllControllers,
    saveSettings,
} from './runtime.js';
import {
    attachDropTarget,
    buildFolderCard,
    confirmDeleteFolderPopup,
    createIcon,
    openFolderFormPopup,
    openFolderPickerPopup,
    renderBreadcrumbs,
    setActiveDragPayload,
} from './ui-dialogs.js';

const DEFAULT_PAGE_SIZE = 50;

let activeCharFolderId = null;
let charCustomPage = 1;
let isCharBatchMode = false;
const selectedCharKeys = new Set();

/** @type {Map<string, HTMLElement>} */
let lastNativePageNodes = new Map();
let lastRenderedWasCustomPage = false;

let toolbarEl = null;
let breadcrumbEl = null;
let batchBarEl = null;
let pagerEl = null;
let hideToggleBtn = null;
let batchBtn = null;
let newFolderBtn = null;
let backBtn = null;
let nativeBulkMoveBtn = null;

/**
 * Checks whether SillyTavern's character search or tag/bogus filters are currently active.
 */
function hasActiveNativeFilters() {
    const searchVal = String(document.getElementById('character_search_bar')?.value || '').trim();
    if (searchVal.length > 0) return true;
    if (document.querySelector('#rm_characters_block .rm_tag_filter .tag.selected, #rm_characters_block .rm_tag_filter .tag.excluded')) {
        return true;
    }
    if (document.querySelector('#rm_characters_block .rm_tag_bogus_drilldown .tag')) {
        return true;
    }
    return false;
}

/**
 * Reads the active character sort field and order from `#character_sort_order`.
 */
function getActiveSortRule() {
    const select = document.getElementById('character_sort_order');
    if (!(select instanceof HTMLSelectElement)) {
        return { field: 'name', order: 'asc' };
    }
    const opt = select.selectedOptions?.[0];
    const field = opt?.dataset?.field || 'name';
    const order = opt?.dataset?.order || 'asc';
    return { field, order };
}

/**
 * Extracts assignment key and display name from a `.character_select` or `.group_select` DOM element.
 * @param {HTMLElement} el
 */
function getEntityInfoFromElement(el) {
    const context = getStContext();
    if (!context) return null;

    if (el.classList.contains('character_select')) {
        const chid = Number(el.getAttribute('data-chid'));
        const char = context.characters?.[chid];
        if (!char?.avatar) return null;
        return {
            key: makeCharKey(char.avatar),
            name: char.name || char.avatar,
            type: 'character',
        };
    }

    if (el.classList.contains('group_select')) {
        const grid = el.getAttribute('data-grid') || globalThis.jQuery?.(el).data('id');
        const group = context.groups?.find(g => g.id === grid);
        if (!group?.id) return null;
        return {
            key: makeGroupKey(group.id),
            name: group.name || group.id,
            type: 'group',
        };
    }

    return null;
}

/**
 * Resolves thumbnail URLs for previewing items inside a character folder.
 * @param {string[]} previewKeys
 * @returns {string[]}
 */
function resolveCharPreviewUrls(previewKeys) {
    const context = getStContext();
    if (!context) return [];
    const urls = [];

    for (const key of previewKeys) {
        if (urls.length >= 4) break;
        if (key.startsWith('char:')) {
            const avatar = key.slice(5);
            const char = context.characters?.find(c => c.avatar === avatar);
            if (char && char.avatar !== 'none') {
                const url = context.getThumbnailUrl?.('avatar', char.avatar);
                if (url) urls.push(url);
            }
        } else if (key.startsWith('group:')) {
            const groupId = key.slice(6);
            const group = context.groups?.find(g => g.id === groupId);
            if (group?.members?.length) {
                const firstMember = context.characters?.find(c => c.avatar === group.members[0]);
                if (firstMember && firstMember.avatar !== 'none') {
                    const url = context.getThumbnailUrl?.('avatar', firstMember.avatar);
                    if (url) urls.push(url);
                }
            }
        }
    }

    return urls;
}

/**
 * Populates inline tags on a cloned character or group card using SillyTavern's `tags` and `tagMap`.
 * @param {HTMLElement} tagsContainer
 * @param {string} entityKeyOrAvatar
 */
function populateInlineTags(tagsContainer, entityKeyOrAvatar) {
    const context = getStContext();
    if (!tagsContainer || !context) return;
    tagsContainer.replaceChildren();

    const tagIds = context.tagMap?.[entityKeyOrAvatar];
    if (!Array.isArray(tagIds) || tagIds.length === 0) return;

    const tagTemplate = document.querySelector('#tag_template .tag');
    const allTags = context.tags || [];

    for (const tagId of tagIds) {
        const tagObj = allTags.find(t => t.id === tagId);
        if (!tagObj || tagObj.is_hidden_on_character_card) continue;

        let tagEl;
        if (tagTemplate) {
            tagEl = tagTemplate.cloneNode(true);
            tagEl.id = tagObj.id;
            const nameSpan = tagEl.querySelector('.tag_name');
            if (nameSpan) nameSpan.textContent = tagObj.name;
            const removeIcon = tagEl.querySelector('.tag_remove');
            if (removeIcon) removeIcon.remove();
        } else {
            tagEl = document.createElement('span');
            tagEl.className = 'tag';
            tagEl.id = tagObj.id;
            const nameSpan = document.createElement('span');
            nameSpan.className = 'tag_name';
            nameSpan.textContent = tagObj.name;
            tagEl.appendChild(nameSpan);
        }

        if (tagObj.color) tagEl.style.backgroundColor = tagObj.color;
        if (tagObj.color2) tagEl.style.color = tagObj.color2;
        tagsContainer.appendChild(tagEl);
    }
}

/**
 * Builds a DOM card for a character, matching SillyTavern's `getCharacterBlock`.
 * @param {object} item
 * @param {number} id
 * @returns {HTMLElement|null}
 */
function buildCharacterCardElement(item, id) {
    const context = getStContext();
    const tpl = document.querySelector('#character_template .character_select');
    if (!tpl || !context) return null;

    const node = /** @type {HTMLElement} */ (tpl.cloneNode(true));
    node.setAttribute('data-chid', String(id));
    node.id = `CharID${id}`;

    const thumbUrl = item.avatar && item.avatar !== 'none'
        ? (context.getThumbnailUrl?.('avatar', item.avatar) || 'img/ai4.png')
        : 'img/ai4.png';

    const img = node.querySelector('img');
    if (img) {
        img.src = thumbUrl;
        img.alt = item.name || '';
    }

    const avatarDiv = node.querySelector('.avatar');
    if (avatarDiv) {
        avatarDiv.setAttribute('title', `[Character] ${item.name}\nFile: ${item.avatar}`);
        if (!context.groupId && context.characterId !== undefined && Number(context.characterId) === id) {
            avatarDiv.classList.add('is_active');
        }
    }

    const nameEl = node.querySelector('.ch_name');
    if (nameEl) {
        nameEl.textContent = item.name || '';
        nameEl.setAttribute('title', `[Character] ${item.name}`);
    }

    const avatarUrlEl = node.querySelector('.ch_avatar_url');
    if (avatarUrlEl) {
        if (context.powerUserSettings?.show_card_avatar_urls) {
            avatarUrlEl.textContent = item.avatar || '';
        } else {
            avatarUrlEl.textContent = '';
        }
    }

    const favIcon = node.querySelector('.ch_fav_icon');
    if (favIcon instanceof HTMLElement) favIcon.style.display = 'none';
    const isFav = Boolean(item.fav === true || item.fav === 'true');
    node.classList.toggle('is_fav', isFav);
    const favInput = node.querySelector('.ch_fav');
    if (favInput instanceof HTMLInputElement) favInput.value = String(item.fav ?? '');

    const assistantAvatar = context.accountStorage?.getItem?.('assistant') || 'default_Assistant.png';
    if (item.avatar !== assistantAvatar) {
        node.querySelector('.ch_assistant')?.remove();
    }

    const descEl = node.querySelector('.ch_description');
    if (descEl instanceof HTMLElement) {
        const desc = item.data?.creator_notes || '';
        if (desc) {
            descEl.textContent = desc;
            descEl.style.display = '';
        } else {
            descEl.style.display = 'none';
        }
    }

    const verEl = node.querySelector('.character_version');
    if (verEl instanceof HTMLElement) {
        const auxFieldName = context.powerUserSettings?.aux_field || 'character_version';
        const auxValue = (item.data && item.data[auxFieldName]) || '';
        if (auxValue) {
            verEl.textContent = auxValue;
            verEl.style.display = '';
        } else {
            verEl.style.display = 'none';
        }
    }

    const tagsEl = node.querySelector('.tags');
    if (tagsEl instanceof HTMLElement) {
        populateInlineTags(tagsEl, item.avatar);
    }

    return node;
}

/**
 * Builds a DOM card for a group chat, matching SillyTavern's `getGroupBlock`.
 * @param {object} group
 * @returns {HTMLElement|null}
 */
function buildGroupCardElement(group) {
    const context = getStContext();
    const tpl = document.querySelector('#group_list_template .group_select');
    if (!tpl || !context) return null;

    const node = /** @type {HTMLElement} */ (tpl.cloneNode(true));
    globalThis.jQuery?.(node).data('id', group.id);
    node.setAttribute('data-grid', group.id);

    const nameEl = node.querySelector('.ch_name');
    if (nameEl) {
        nameEl.textContent = group.name || '';
        nameEl.setAttribute('title', `[Group] ${group.name}`);
    }

    const favIcon = node.querySelector('.group_fav_icon');
    if (favIcon instanceof HTMLElement) favIcon.style.display = 'none';
    if (group.fav) node.classList.add('is_fav');
    const favInput = node.querySelector('.ch_fav');
    if (favInput instanceof HTMLInputElement) favInput.value = String(Boolean(group.fav));

    const members = Array.isArray(group.members) ? group.members : [];
    const memberNames = [];
    const memberAvatars = [];
    for (const member of members) {
        const found = context.characters?.find(c => c.avatar === member || c.name === member);
        if (found) {
            memberNames.push(found.name);
            if (found.avatar && found.avatar !== 'none' && memberAvatars.length < 4) {
                const url = context.getThumbnailUrl?.('avatar', found.avatar);
                if (url) memberAvatars.push(url);
            }
        }
    }

    const counterEl = node.querySelector('.group_select_counter');
    if (counterEl) {
        counterEl.textContent = `${memberNames.length} ${memberNames.length !== 1 ? 'characters' : 'character'}`;
    }

    const listEl = node.querySelector('.group_select_block_list');
    if (listEl) {
        listEl.textContent = memberNames.join(', ');
    }

    const tagsEl = node.querySelector('.tags');
    if (tagsEl instanceof HTMLElement) {
        populateInlineTags(tagsEl, group.id);
    }

    // Build group avatar
    const existingAvatar = node.querySelector('.avatar');
    if (existingAvatar) {
        if (group.avatar_url && (group.avatar_url.startsWith('data:') || group.avatar_url.startsWith('user') || group.avatar_url.startsWith('/user'))) {
            const img = existingAvatar.querySelector('img');
            if (img) img.src = group.avatar_url;
            existingAvatar.setAttribute('title', `[Group] ${group.name}`);
        } else if (memberAvatars.length >= 1) {
            const collageTpl = document.querySelector(`#group_avatars_template .collage_${Math.min(4, memberAvatars.length)}`);
            if (collageTpl) {
                const collage = /** @type {HTMLElement} */ (collageTpl.cloneNode(true));
                for (let i = 0; i < memberAvatars.length; i++) {
                    const img = collage.querySelector(`.img_${i + 1}`);
                    if (img instanceof HTMLImageElement) img.src = memberAvatars[i];
                }
                collage.setAttribute('title', `[Group] ${group.name}`);
                if (!context.characterId && context.groupId === group.id) {
                    collage.classList.add('is_active');
                }
                existingAvatar.replaceWith(collage);
            }
        } else {
            const missing = document.createElement('div');
            missing.className = 'missing-avatar fa-solid fa-user-slash';
            existingAvatar.replaceWith(missing);
        }
    }

    return node;
}

/**
 * Decorates a character/group card with move button, optional folder badge, drag-and-drop, and batch state.
 * @param {HTMLElement} cardEl
 * @param {{ showBadge?: boolean }} [options]
 */
function decorateEntityCard(cardEl, { showBadge = false } = {}) {
    const info = getEntityInfoFromElement(cardEl);
    if (!info) return;

    const settings = getSettings();
    const assignedFolderId = settings.charAssignments[info.key] || null;
    const folder = assignedFolderId ? settings.charFolders.find(f => f.id === assignedFolderId) : null;

    cardEl.classList.add('stf-entity-decorated');
    cardEl.dataset.stfKey = info.key;
    cardEl.classList.toggle('stf-batch-selected', isCharBatchMode && selectedCharKeys.has(info.key));

    // Add or update folder badge
    cardEl.querySelector('.stf-folder-badge')?.remove();
    if (showBadge && folder) {
        const badge = document.createElement('span');
        badge.className = 'stf-folder-badge';
        badge.title = tr('folderBadgeTitle', { path: getFolderPathLabel(settings.charFolders, folder.id) });
        if (folder.color) {
            badge.style.setProperty('--stf-badge-color', folder.color);
            badge.classList.add('has-color');
        }
        badge.appendChild(createIcon('fa-folder'));
        const badgeText = document.createElement('span');
        badgeText.textContent = folder.name;
        badge.appendChild(badgeText);

        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            navigateToCharFolder(folder.id);
        });

        const container = cardEl.querySelector('.character_select_container, .group_select_container');
        const tagsEl = container?.querySelector('.tags');
        if (container && tagsEl) {
            container.insertBefore(badge, tagsEl);
        } else if (container) {
            container.appendChild(badge);
        }
    }

    // Add move-to-folder action button (idempotent)
    if (!cardEl.querySelector('.stf-char-move-btn')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stf-char-move-btn';
        btn.title = tr('moveToFolder');
        btn.appendChild(createIcon('fa-folder-open'));
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            await openMovePickerForKeys([info.key], info.name);
        });
        cardEl.appendChild(btn);
    }

    // Drag & drop source (idempotent)
    cardEl.setAttribute('draggable', 'true');
    if (cardEl.dataset.stfDragBound !== '1') {
        cardEl.dataset.stfDragBound = '1';

        cardEl.addEventListener('dragstart', (e) => {
            if (document.getElementById('rm_print_characters_block')?.classList.contains('group_overlay_mode_select')) {
                e.preventDefault();
                return;
            }
            const currentInfo = getEntityInfoFromElement(cardEl);
            if (!currentInfo) return;

            const keys = isCharBatchMode && selectedCharKeys.has(currentInfo.key) && selectedCharKeys.size > 0
                ? [...selectedCharKeys]
                : [currentInfo.key];

            setActiveDragPayload({
                domain: 'char',
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
 * Removes folder decorations when extension is disabled.
 * @param {HTMLElement} listBlock
 */
function clearDecorations(listBlock) {
    listBlock.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());
    listBlock.querySelectorAll('.character_select, .group_select').forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        if (el.dataset.stfHiddenByFolder === '1') {
            el.style.display = '';
            delete el.dataset.stfHiddenByFolder;
        }
        el.classList.remove('stf-batch-selected', 'stf-entity-decorated');
        el.querySelector('.stf-folder-badge')?.remove();
        el.querySelector('.stf-char-move-btn')?.remove();
        el.removeAttribute('draggable');
    });
    const paginationJs = document.querySelector('#rm_print_characters_pagination .paginationjs');
    if (paginationJs instanceof HTMLElement) {
        paginationJs.style.display = '';
    }
}

/**
 * Opens folder picker popup for one or more character/group keys.
 * @param {string[]} keys
 * @param {string} [singleName]
 */
async function openMovePickerForKeys(keys, singleName = '') {
    if (!keys.length) {
        globalThis.toastr?.info?.(tr('pleaseSelectItems'));
        return;
    }

    const settings = getSettings();
    const validKeys = getValidCharAndGroupKeys();
    const currentFolderId = keys.length === 1 ? (settings.charAssignments[keys[0]] || null) : null;

    const title = keys.length === 1
        ? tr('pickerTitleSingle', { name: singleName || keys[0] })
        : tr('pickerTitleBatch', { count: keys.length });

    const picked = await openFolderPickerPopup({
        title,
        folders: settings.charFolders,
        assignments: settings.charAssignments,
        currentFolderId,
        validItemKeys: validKeys,
        defaultParentId: activeCharFolderId,
        onCreateFolder: (name, parentId) => {
            const folder = createFolder(settings.charFolders, { name, parentId });
            saveSettings();
            globalThis.toastr?.success?.(tr('folderCreated', { name: folder.name }));
            return folder;
        },
    });

    if (!picked) return;

    assignItemsToFolder(settings.charFolders, settings.charAssignments, keys, picked.targetFolderId);
    saveSettings();

    if (picked.targetFolderId) {
        const target = settings.charFolders.find(f => f.id === picked.targetFolderId);
        globalThis.toastr?.success?.(tr('movedToFolder', { name: target?.name || '' }));
    } else {
        globalThis.toastr?.success?.(tr('movedToRoot'));
    }

    if (isCharBatchMode) {
        isCharBatchMode = false;
        selectedCharKeys.clear();
    }
    renderCharacterFolderView();
}

/**
 * Handles creating a new character folder at current level.
 */
async function handleCreateCharFolder() {
    const settings = getSettings();
    const form = await openFolderFormPopup({
        mode: 'create',
        folders: settings.charFolders,
        defaultParentId: activeCharFolderId,
    });
    if (!form) return;

    const created = createFolder(settings.charFolders, form);
    saveSettings();
    globalThis.toastr?.success?.(tr('folderCreated', { name: created.name }));
    renderCharacterFolderView();
}

/**
 * Handles editing/renaming an existing character folder.
 * @param {object} folder
 */
async function handleEditCharFolder(folder) {
    const settings = getSettings();
    const form = await openFolderFormPopup({
        mode: 'edit',
        folder,
        folders: settings.charFolders,
    });
    if (!form) return;

    updateFolder(settings.charFolders, folder.id, form);
    saveSettings();
    globalThis.toastr?.success?.(tr('folderUpdated', { name: form.name }));
    renderCharacterFolderView();
}

/**
 * Handles deleting a character folder (keeping all characters/groups safe).
 * @param {object} folder
 */
async function handleDeleteCharFolder(folder) {
    const confirmed = await confirmDeleteFolderPopup(folder.name);
    if (!confirmed) return;

    const settings = getSettings();
    const fallbackParent = folder.parentId || null;
    deleteFolder(settings.charFolders, settings.charAssignments, folder.id);
    if (activeCharFolderId === folder.id) {
        activeCharFolderId = fallbackParent;
    }
    saveSettings();
    globalThis.toastr?.success?.(tr('folderDeleted', { name: folder.name }));
    renderCharacterFolderView();
}

/**
 * Handles dropping items onto a character folder or root.
 * @param {string[]} keys
 * @param {string|null} targetFolderId
 */
function handleDropItemsToCharFolder(keys, targetFolderId) {
    const settings = getSettings();
    assignItemsToFolder(settings.charFolders, settings.charAssignments, keys, targetFolderId);
    saveSettings();

    if (targetFolderId) {
        const target = settings.charFolders.find(f => f.id === targetFolderId);
        globalThis.toastr?.success?.(tr('movedToFolder', { name: target?.name || '' }));
    } else {
        globalThis.toastr?.success?.(tr('movedToRoot'));
    }

    if (isCharBatchMode) {
        isCharBatchMode = false;
        selectedCharKeys.clear();
    }
    renderCharacterFolderView();
}

/**
 * Handles dropping a folder onto another folder or root to re-parent it.
 * @param {string} folderId
 * @param {string|null} targetParentId
 */
function handleDropFolderToCharParent(folderId, targetParentId) {
    const settings = getSettings();
    try {
        updateFolder(settings.charFolders, folderId, { parentId: targetParentId });
        saveSettings();
        renderCharacterFolderView();
    } catch (error) {
        console.warn('[st-folders] Folder move rejected:', error);
    }
}

/**
 * Navigates into a character folder (or root when `folderId === null`).
 * @param {string|null} folderId
 */
export function navigateToCharFolder(folderId) {
    const settings = getSettings();
    if (folderId && !settings.charFolders.some(f => f.id === folderId)) {
        activeCharFolderId = null;
    } else {
        activeCharFolderId = folderId;
    }
    charCustomPage = 1;
    selectedCharKeys.clear();
    renderCharacterFolderView();
}

/**
 * Updates the toolbar UI state (breadcrumbs, batch bar, pager, buttons).
 * @param {{ totalItems?: number, pageSize?: number, showCustomPager?: boolean }} [pagerState]
 */
function updateCharToolbar({ totalItems = 0, pageSize = DEFAULT_PAGE_SIZE, showCustomPager = false } = {}) {
    if (!toolbarEl) return;
    const settings = getSettings();

    if (!settings.enabled) {
        toolbarEl.style.display = 'none';
        if (nativeBulkMoveBtn) nativeBulkMoveBtn.style.display = 'none';
        return;
    }
    toolbarEl.style.display = '';

    // Ensure activeCharFolderId still exists
    if (activeCharFolderId && !settings.charFolders.some(f => f.id === activeCharFolderId)) {
        activeCharFolderId = null;
    }

    if (breadcrumbEl) {
        renderBreadcrumbs(breadcrumbEl, {
            domain: 'char',
            rootLabel: tr('rootChars'),
            folders: settings.charFolders,
            activeFolderId: activeCharFolderId,
            onNavigate: navigateToCharFolder,
            onDropItems: handleDropItemsToCharFolder,
            onDropFolder: handleDropFolderToCharParent,
        });
    }

    if (backBtn) {
        backBtn.style.display = activeCharFolderId ? '' : 'none';
        backBtn.title = tr('backUp');
    }

    if (newFolderBtn) {
        newFolderBtn.title = tr('newFolder');
        const label = newFolderBtn.querySelector('span');
        if (label) label.textContent = tr('newFolderShort');
    }

    if (batchBtn) {
        batchBtn.classList.toggle('active', isCharBatchMode);
        batchBtn.title = tr('batchSelect');
        const label = batchBtn.querySelector('span');
        if (label) label.textContent = isCharBatchMode ? tr('batchDone') : tr('batchSelect');
    }

    if (hideToggleBtn) {
        hideToggleBtn.title = tr('toggleHideFolderedChars');
        hideToggleBtn.classList.toggle('active', !settings.hideFolderedCharsInRoot);
        const icon = hideToggleBtn.querySelector('i');
        if (icon) {
            icon.className = settings.hideFolderedCharsInRoot ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        }
    }

    if (nativeBulkMoveBtn) {
        nativeBulkMoveBtn.title = tr('nativeBulkMoveToFolder');
    }

    if (batchBarEl) {
        batchBarEl.style.display = isCharBatchMode ? 'flex' : 'none';
        const countEl = batchBarEl.querySelector('.stf-batch-count');
        if (countEl) countEl.textContent = tr('batchSelectedCount', { count: selectedCharKeys.size });
        const selAllBtn = batchBarEl.querySelector('.stf-batch-select-all');
        if (selAllBtn) selAllBtn.textContent = tr('selectAllVisible');
        const moveBtn = batchBarEl.querySelector('.stf-batch-move');
        if (moveBtn) moveBtn.textContent = tr('batchMoveTo');
        const moveOutBtn = batchBarEl.querySelector('.stf-batch-move-out');
        if (moveOutBtn) moveOutBtn.textContent = tr('batchMoveOut');
        const cancelBtn = batchBarEl.querySelector('.stf-batch-cancel');
        if (cancelBtn) cancelBtn.textContent = tr('cancel');
    }

    if (pagerEl) {
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        if (showCustomPager && totalPages > 1) {
            pagerEl.style.display = 'flex';
            const prev = pagerEl.querySelector('.stf-pager-prev');
            const next = pagerEl.querySelector('.stf-pager-next');
            const info = pagerEl.querySelector('.stf-pager-info');
            if (prev instanceof HTMLButtonElement) {
                prev.disabled = charCustomPage <= 1;
                prev.textContent = tr('prevPage');
            }
            if (next instanceof HTMLButtonElement) {
                next.disabled = charCustomPage >= totalPages;
                next.textContent = tr('nextPage');
            }
            if (info) {
                info.textContent = tr('pageInfo', { page: charCustomPage, totalPages, total: totalItems });
            }
        } else {
            pagerEl.style.display = 'none';
        }
    }
}

/**
 * Snapshot SillyTavern's currently rendered character/group cards so switching back or reusing nodes preserves tags.
 * @param {HTMLElement} listBlock
 */
function captureNativePageNodes(listBlock) {
    const nodes = listBlock.querySelectorAll(':scope > .character_select, :scope > .group_select');
    for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        const info = getEntityInfoFromElement(el);
        if (info) {
            lastNativePageNodes.set(info.key, el);
        }
    }
}

/**
 * Builds a DocumentFragment containing folder cards for the given character folder list.
 * @param {Array<any>} folderList
 * @param {Array<any>} allFolders
 * @param {Map<string, any>} statsMap
 * @returns {DocumentFragment}
 */
function buildCharFolderCardsFragment(folderList, allFolders, statsMap) {
    const frag = document.createDocumentFragment();
    for (const folder of folderList) {
        const stats = statsMap.get(folder.id) || { directItems: 0, totalItems: 0, directSubfolders: 0, previewKeys: [] };
        frag.appendChild(buildFolderCard({
            domain: 'char',
            folder,
            folders: allFolders,
            stats,
            previewUrls: resolveCharPreviewUrls(stats.previewKeys),
            onOpen: navigateToCharFolder,
            onEdit: handleEditCharFolder,
            onDelete: handleDeleteCharFolder,
            onDropItems: handleDropItemsToCharFolder,
            onDropFolder: handleDropFolderToCharParent,
        }));
    }
    return frag;
}

/**
 * Applies folder rendering inside `#rm_print_characters_block`.
 * @param {{ fromNativePageLoad?: boolean }} [options]
 */
export function renderCharacterFolderView({ fromNativePageLoad = false } = {}) {
    const listBlock = document.getElementById('rm_print_characters_block');
    const context = getStContext();
    if (!listBlock || !context) return;

    const settings = getSettings();
    if (!settings.enabled) {
        clearDecorations(listBlock);
        updateCharToolbar();
        return;
    }

    if (fromNativePageLoad) {
        lastNativePageNodes = new Map();
        captureNativePageNodes(listBlock);
        lastRenderedWasCustomPage = false;
    }

    const validKeys = getValidCharAndGroupKeys();
    const statsMap = computeFolderStats(settings.charFolders, settings.charAssignments, validKeys);
    const paginationJs = document.querySelector('#rm_print_characters_pagination .paginationjs');
    const nativeFiltered = hasActiveNativeFilters();

    // Case 1: Native search / tag filter is active -> keep SillyTavern's filtered results, add matching folders + badges
    if (nativeFiltered) {
        if (lastRenderedWasCustomPage) {
            lastRenderedWasCustomPage = false;
        }
        if (paginationJs instanceof HTMLElement) {
            paginationJs.style.display = '';
        }

        listBlock.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());

        const searchTerm = String(document.getElementById('character_search_bar')?.value || '').trim().toLowerCase();
        const visibleCards = [...listBlock.querySelectorAll(':scope > .character_select, :scope > .group_select')];
        for (const card of visibleCards) {
            if (!(card instanceof HTMLElement)) continue;
            if (card.dataset.stfHiddenByFolder === '1') {
                card.style.display = '';
                delete card.dataset.stfHiddenByFolder;
            }
            decorateEntityCard(card, { showBadge: true });
        }

        // Prepend folders matching search query (when searching by text)
        if (searchTerm) {
            const matchingFolders = sortFolders(settings.charFolders)
                .filter(f => f.name.toLowerCase().includes(searchTerm));
            listBlock.prepend(buildCharFolderCardsFragment(matchingFolders, settings.charFolders, statsMap));
        }

        updateCharToolbar({ showCustomPager: false });
        return;
    }

    const totalEntitiesCount = (context.characters?.length || 0) + (context.groups?.length || 0);
    const pageSize = Number(context.accountStorage?.getItem?.('Characters_PerPage')) || DEFAULT_PAGE_SIZE;
    const isMultiPage = totalEntitiesCount > pageSize || Boolean(document.querySelector('#rm_print_characters_pagination .paginationjs-pages li'));

    // Case 2: At Root AND we can safely filter SillyTavern's native single-page DOM without pagination gaps
    if (!activeCharFolderId && (!settings.hideFolderedCharsInRoot || !isMultiPage)) {
        if (paginationJs instanceof HTMLElement) {
            paginationJs.style.display = '';
        }

        if (lastRenderedWasCustomPage) {
            listBlock.replaceChildren(...lastNativePageNodes.values());
            lastRenderedWasCustomPage = false;
        } else {
            listBlock.querySelectorAll('.stf-folder-card, .stf-empty-folder-hint').forEach(el => el.remove());
            if (listBlock.querySelectorAll(':scope > .character_select, :scope > .group_select').length === 0 && lastNativePageNodes.size > 0) {
                for (const node of lastNativePageNodes.values()) {
                    listBlock.appendChild(node);
                }
            }
        }

        const rootFolders = sortFolders(settings.charFolders.filter(f => !f.parentId));
        listBlock.prepend(buildCharFolderCardsFragment(rootFolders, settings.charFolders, statsMap));

        const cards = [...listBlock.querySelectorAll(':scope > .character_select, :scope > .group_select')];
        for (const card of cards) {
            if (!(card instanceof HTMLElement)) continue;
            const info = getEntityInfoFromElement(card);
            const assignedId = info ? settings.charAssignments[info.key] : null;
            const hasValidFolder = Boolean(assignedId && settings.charFolders.some(f => f.id === assignedId));

            if (settings.hideFolderedCharsInRoot && hasValidFolder) {
                card.style.display = 'none';
                card.dataset.stfHiddenByFolder = '1';
            } else {
                if (card.dataset.stfHiddenByFolder === '1') {
                    card.style.display = '';
                    delete card.dataset.stfHiddenByFolder;
                }
                decorateEntityCard(card, { showBadge: !settings.hideFolderedCharsInRoot });
            }
        }

        updateCharToolbar({ showCustomPager: false });
        return;
    }

    // Case 3: Inside a folder OR multi-page uncategorized root view
    lastRenderedWasCustomPage = true;
    if (paginationJs instanceof HTMLElement) {
        paginationJs.style.display = 'none';
    }

    const childFolders = sortFolders(
        settings.charFolders.filter(f => (f.parentId || null) === activeCharFolderId),
    );

    const validFolderIds = new Set(settings.charFolders.map(f => f.id));
    const allEntities = [
        ...(context.characters || [])
            .map((char, index) => (char?.avatar ? { type: 'character', item: char, id: index, key: makeCharKey(char.avatar) } : null))
            .filter(Boolean),
        ...(context.groups || [])
            .map(group => (group?.id ? { type: 'group', item: group, id: group.id, key: makeGroupKey(group.id) } : null))
            .filter(Boolean),
    ];

    const matchingEntities = allEntities.filter((entity) => {
        const assigned = settings.charAssignments[entity.key];
        const effectiveFolder = assigned && validFolderIds.has(assigned) ? assigned : null;
        if (activeCharFolderId) {
            return effectiveFolder === activeCharFolderId;
        }
        return !settings.hideFolderedCharsInRoot || !effectiveFolder;
    });

    const { field, order } = getActiveSortRule();
    const sortedEntities = sortCharacterEntities(matchingEntities, field, order);

    const totalPages = Math.max(1, Math.ceil(sortedEntities.length / pageSize));
    if (charCustomPage > totalPages) charCustomPage = totalPages;
    if (charCustomPage < 1) charCustomPage = 1;

    const startIdx = (charCustomPage - 1) * pageSize;
    const pagedEntities = sortedEntities.slice(startIdx, startIdx + pageSize);

    const fragment = document.createDocumentFragment();

    // Render subfolders at top of page 1
    if (charCustomPage === 1) {
        fragment.appendChild(buildCharFolderCardsFragment(childFolders, settings.charFolders, statsMap));
    }

    for (const entity of pagedEntities) {
        let cardEl = lastNativePageNodes.get(entity.key);
        if (!cardEl) {
            cardEl = entity.type === 'character'
                ? buildCharacterCardElement(entity.item, entity.id)
                : buildGroupCardElement(entity.item);
        } else {
            if (cardEl.dataset.stfHiddenByFolder === '1') {
                cardEl.style.display = '';
                delete cardEl.dataset.stfHiddenByFolder;
            }
            if (entity.type === 'character') {
                cardEl.setAttribute('data-chid', String(entity.id));
                cardEl.id = `CharID${entity.id}`;
            }
        }

        if (cardEl) {
            decorateEntityCard(cardEl, { showBadge: !activeCharFolderId && !settings.hideFolderedCharsInRoot });
            fragment.appendChild(cardEl);
        }
    }

    if (childFolders.length === 0 && sortedEntities.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'stf-empty-folder-hint';
        emptyEl.textContent = tr('emptyCharFolder');
        fragment.appendChild(emptyEl);
    }

    listBlock.replaceChildren(fragment);

    updateCharToolbar({
        totalItems: sortedEntities.length,
        pageSize,
        showCustomPager: true,
    });
}

/**
 * Builds and mounts `#stf_char_toolbar` and `#stf_native_bulk_move_btn` into `#rm_characters_block`.
 */
function ensureCharToolbarMounted() {
    const charactersBlock = document.getElementById('rm_characters_block');
    const listBlock = document.getElementById('rm_print_characters_block');
    const paginationBar = document.getElementById('rm_print_characters_pagination');
    if (!charactersBlock || !listBlock) return;

    if (!document.getElementById('stf_char_toolbar')) {
        toolbarEl = document.createElement('div');
        toolbarEl.id = 'stf_char_toolbar';
        toolbarEl.className = 'stf-toolbar';

        const topRow = document.createElement('div');
        topRow.className = 'stf-toolbar-row';

        backBtn = document.createElement('button');
        backBtn.type = 'button';
        backBtn.className = 'menu_button stf-back-btn';
        backBtn.appendChild(createIcon('fa-arrow-left'));
        backBtn.addEventListener('click', () => {
            const settings = getSettings();
            const crumbs = getBreadcrumbs(settings.charFolders, activeCharFolderId);
            const parentId = crumbs.length >= 2 ? crumbs[crumbs.length - 2].id : null;
            navigateToCharFolder(parentId);
        });

        breadcrumbEl = document.createElement('div');
        breadcrumbEl.className = 'stf-breadcrumbs';

        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'stf-toolbar-actions';

        newFolderBtn = document.createElement('button');
        newFolderBtn.type = 'button';
        newFolderBtn.className = 'menu_button menu_button_icon stf-toolbar-btn';
        newFolderBtn.appendChild(createIcon('fa-folder-plus'));
        const newLabel = document.createElement('span');
        newLabel.textContent = tr('newFolderShort');
        newFolderBtn.appendChild(newLabel);
        newFolderBtn.addEventListener('click', handleCreateCharFolder);

        batchBtn = document.createElement('button');
        batchBtn.type = 'button';
        batchBtn.className = 'menu_button menu_button_icon stf-toolbar-btn';
        batchBtn.appendChild(createIcon('fa-list-check'));
        const batchLabel = document.createElement('span');
        batchLabel.textContent = tr('batchSelect');
        batchBtn.appendChild(batchLabel);
        batchBtn.addEventListener('click', () => {
            isCharBatchMode = !isCharBatchMode;
            if (!isCharBatchMode) selectedCharKeys.clear();
            renderCharacterFolderView();
        });

        hideToggleBtn = document.createElement('button');
        hideToggleBtn.type = 'button';
        hideToggleBtn.className = 'menu_button stf-toolbar-btn stf-icon-only-btn';
        hideToggleBtn.appendChild(createIcon('fa-eye-slash'));
        hideToggleBtn.addEventListener('click', () => {
            const settings = getSettings();
            settings.hideFolderedCharsInRoot = !settings.hideFolderedCharsInRoot;
            saveSettings();
            charCustomPage = 1;
            notifyAllControllers();
        });

        actionsWrap.append(newFolderBtn, batchBtn, hideToggleBtn);
        topRow.append(backBtn, breadcrumbEl, actionsWrap);

        // Batch action bar
        batchBarEl = document.createElement('div');
        batchBarEl.className = 'stf-batch-bar';
        batchBarEl.style.display = 'none';

        const countSpan = document.createElement('span');
        countSpan.className = 'stf-batch-count';

        const selectAllBtn = document.createElement('button');
        selectAllBtn.type = 'button';
        selectAllBtn.className = 'menu_button stf-batch-select-all';
        selectAllBtn.addEventListener('click', () => {
            const visibleCards = listBlock.querySelectorAll(':scope > .character_select, :scope > .group_select');
            const keys = [];
            for (const card of visibleCards) {
                if (!(card instanceof HTMLElement) || card.style.display === 'none') continue;
                const info = getEntityInfoFromElement(card);
                if (info) keys.push(info.key);
            }
            const allSelected = keys.length > 0 && keys.every(k => selectedCharKeys.has(k));
            if (allSelected) {
                keys.forEach(k => selectedCharKeys.delete(k));
            } else {
                keys.forEach(k => selectedCharKeys.add(k));
            }
            renderCharacterFolderView();
        });

        const batchMoveBtn = document.createElement('button');
        batchMoveBtn.type = 'button';
        batchMoveBtn.className = 'menu_button stf-batch-move stf-primary-btn';
        batchMoveBtn.addEventListener('click', async () => {
            await openMovePickerForKeys([...selectedCharKeys]);
        });

        const batchMoveOutBtn = document.createElement('button');
        batchMoveOutBtn.type = 'button';
        batchMoveOutBtn.className = 'menu_button stf-batch-move-out';
        batchMoveOutBtn.addEventListener('click', () => {
            if (!selectedCharKeys.size) {
                globalThis.toastr?.info?.(tr('pleaseSelectItems'));
                return;
            }
            handleDropItemsToCharFolder([...selectedCharKeys], null);
        });

        const batchCancelBtn = document.createElement('button');
        batchCancelBtn.type = 'button';
        batchCancelBtn.className = 'menu_button stf-batch-cancel';
        batchCancelBtn.addEventListener('click', () => {
            isCharBatchMode = false;
            selectedCharKeys.clear();
            renderCharacterFolderView();
        });

        batchBarEl.append(countSpan, selectAllBtn, batchMoveBtn, batchMoveOutBtn, batchCancelBtn);

        // Custom pager bar (for inside folders or multi-page root)
        pagerEl = document.createElement('div');
        pagerEl.className = 'stf-pager';
        pagerEl.style.display = 'none';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'menu_button stf-pager-prev';
        prevBtn.addEventListener('click', () => {
            if (charCustomPage > 1) {
                charCustomPage--;
                renderCharacterFolderView();
            }
        });

        const pageInfo = document.createElement('span');
        pageInfo.className = 'stf-pager-info';

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'menu_button stf-pager-next';
        nextBtn.addEventListener('click', () => {
            charCustomPage++;
            renderCharacterFolderView();
        });

        pagerEl.append(prevBtn, pageInfo, nextBtn);

        toolbarEl.append(topRow, batchBarEl, pagerEl);
        charactersBlock.insertBefore(toolbarEl, listBlock);
    }

    // Native BulkEdit integration button
    if (paginationBar && !document.getElementById('stf_native_bulk_move_btn')) {
        nativeBulkMoveBtn = document.createElement('i');
        nativeBulkMoveBtn.id = 'stf_native_bulk_move_btn';
        nativeBulkMoveBtn.className = 'fa-solid fa-folder-plus menu_button bulkEditOptionElement';
        nativeBulkMoveBtn.style.display = 'none';
        nativeBulkMoveBtn.title = tr('nativeBulkMoveToFolder');
        nativeBulkMoveBtn.addEventListener('click', async () => {
            const selected = [...listBlock.querySelectorAll('.character_select.character_selected')];
            const keys = [];
            for (const el of selected) {
                const info = getEntityInfoFromElement(el);
                if (info) keys.push(info.key);
            }
            await openMovePickerForKeys(keys);
        });
        paginationBar.appendChild(nativeBulkMoveBtn);
    }

    // Capture-phase click handler for our batch mode
    if (listBlock.dataset.stfBatchClickBound !== '1') {
        listBlock.dataset.stfBatchClickBound = '1';
        listBlock.addEventListener('click', (e) => {
            if (!isCharBatchMode) return;
            if (!(e.target instanceof Element)) return;
            // Allow clicks on folder cards or move buttons or edit/delete buttons
            if (e.target.closest('.stf-folder-card, .stf-char-move-btn, .stf-icon-btn')) return;

            const card = e.target.closest('.character_select, .group_select');
            if (!(card instanceof HTMLElement)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const info = getEntityInfoFromElement(card);
            if (!info) return;
            if (selectedCharKeys.has(info.key)) {
                selectedCharKeys.delete(info.key);
            } else {
                selectedCharKeys.add(info.key);
            }
            card.classList.toggle('stf-batch-selected', selectedCharKeys.has(info.key));
            updateCharToolbar();
        }, true);
    }
}

/**
 * Initializes Character & Group Folder UI and event listeners.
 */
export function initCharFolders() {
    ensureCharToolbarMounted();

    const context = getStContext();
    if (!context?.eventSource || !context?.eventTypes) return;
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.CHARACTER_PAGE_LOADED, () => {
        ensureCharToolbarMounted();
        renderCharacterFolderView({ fromNativePageLoad: true });
    });

    eventSource.on(eventTypes.CHARACTER_DELETED, (payload) => {
        const avatar = payload?.character?.avatar;
        if (!avatar) return;
        const settings = getSettings();
        const key = makeCharKey(avatar);
        let changed = false;
        if (key in settings.charAssignments) {
            delete settings.charAssignments[key];
            changed = true;
        }
        if (key in settings.chatFoldersByScope) {
            delete settings.chatFoldersByScope[key];
            changed = true;
        }
        if (key in settings.chatAssignmentsByScope) {
            delete settings.chatAssignmentsByScope[key];
            changed = true;
        }
        if (changed) saveSettings();
    });

    eventSource.on(eventTypes.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
        const settings = getSettings();
        const oldKey = makeCharKey(oldAvatar);
        const newKey = makeCharKey(newAvatar);
        let changed = migrateAssignmentKey(settings.charAssignments, oldKey, newKey);

        if (oldKey in settings.chatFoldersByScope) {
            settings.chatFoldersByScope[newKey] = settings.chatFoldersByScope[oldKey];
            delete settings.chatFoldersByScope[oldKey];
            changed = true;
        }
        if (oldKey in settings.chatAssignmentsByScope) {
            settings.chatAssignmentsByScope[newKey] = settings.chatAssignmentsByScope[oldKey];
            delete settings.chatAssignmentsByScope[oldKey];
            changed = true;
        }
        if (changed) saveSettings();
    });

    eventSource.on(eventTypes.CHARACTER_DUPLICATED, (payload) => {
        if (!payload?.oldAvatar || !payload?.newAvatar) return;
        const settings = getSettings();
        const oldKey = makeCharKey(payload.oldAvatar);
        const newKey = makeCharKey(payload.newAvatar);
        const folderId = settings.charAssignments[oldKey];
        if (folderId && settings.charFolders.some(f => f.id === folderId)) {
            settings.charAssignments[newKey] = folderId;
            saveSettings();
        }
    });

    // If characters are already rendered in DOM when extension initializes, apply immediately
    if (document.querySelector('#rm_print_characters_block > .character_select, #rm_print_characters_block > .group_select')) {
        renderCharacterFolderView({ fromNativePageLoad: true });
    } else {
        updateCharToolbar();
    }
}
