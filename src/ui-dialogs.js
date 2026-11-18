import {
    FOLDER_COLORS,
    computeFolderStats,
    flattenFolderTree,
    getBreadcrumbs,
    getDescendantIds,
    getFolderPathLabel,
    parseRecentChatKey,
    wouldCreateCycle,
} from './folder-store.js';
import { tr } from './i18n.js';
import { getStContext } from './runtime.js';

let activeDragPayload = null;

/**
 * Sets current in-memory drag payload for cross-element validation during dragover.
 * @param {{ domain: 'char'|'chat', kind: 'items'|'folder', keys?: string[], folderId?: string } | null} payload
 */
export function setActiveDragPayload(payload) {
    activeDragPayload = payload;
}

/**
 * Gets current in-memory drag payload.
 */
export function getActiveDragPayload() {
    return activeDragPayload;
}

/**
 * Creates a small Font Awesome icon element.
 * @param {...string} classes
 * @returns {HTMLElement}
 */
export function createIcon(...classes) {
    const i = document.createElement('i');
    i.classList.add('fa-solid', ...classes);
    return i;
}

/**
 * Opens a modal popup to create or edit/rename a folder.
 * @param {object} params
 * @param {'create'|'edit'} params.mode
 * @param {object|null} [params.folder]
 * @param {Array<any>} params.folders
 * @param {string|null} [params.defaultParentId]
 * @returns {Promise<{ name: string, parentId: string|null, color: string } | null>}
 */
export async function openFolderFormPopup({ mode, folder = null, folders = [], defaultParentId = null }) {
    const context = getStContext();
    if (!context?.Popup) return null;

    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
    const isEdit = mode === 'edit' && Boolean(folder);

    const container = document.createElement('div');
    container.className = 'stf-dialog';

    const title = document.createElement('h3');
    title.className = 'stf-dialog-title';
    title.textContent = isEdit ? tr('editFolderTitle') : tr('createFolderTitle');
    container.appendChild(title);

    // Folder name field
    const nameGroup = document.createElement('div');
    nameGroup.className = 'stf-field';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'stf-label';
    nameLabel.textContent = tr('folderNameLabel');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'text_pole width100p';
    nameInput.maxLength = 80;
    nameInput.placeholder = tr('folderNamePlaceholder');
    nameInput.value = isEdit ? folder.name : '';
    nameInput.setAttribute('autofocus', '');
    nameGroup.append(nameLabel, nameInput);
    container.appendChild(nameGroup);

    // Parent folder field
    const parentGroup = document.createElement('div');
    parentGroup.className = 'stf-field';
    const parentLabel = document.createElement('label');
    parentLabel.className = 'stf-label';
    parentLabel.textContent = tr('parentFolderLabel');
    const parentSelect = document.createElement('select');
    parentSelect.className = 'text_pole width100p';

    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = tr('rootOption');
    parentSelect.appendChild(rootOption);

    const excluded = isEdit ? getDescendantIds(folders, folder.id) : null;
    for (const { folder: node, depth } of flattenFolderTree(folders, excluded)) {
        const opt = document.createElement('option');
        opt.value = node.id;
        const prefix = depth > 0 ? `${'  '.repeat(depth)}└ ` : '';
        opt.textContent = `${prefix}${node.name}`;
        parentSelect.appendChild(opt);
    }

    const initialParentId = isEdit ? (folder.parentId || '') : (defaultParentId || '');
    parentSelect.value = folders.some(f => f.id === initialParentId) && (!excluded || !excluded.has(initialParentId))
        ? initialParentId
        : '';

    parentGroup.append(parentLabel, parentSelect);
    container.appendChild(parentGroup);

    // Color picker field
    const colorGroup = document.createElement('div');
    colorGroup.className = 'stf-field';
    const colorLabel = document.createElement('label');
    colorLabel.className = 'stf-label';
    colorLabel.textContent = tr('folderColorLabel');

    const colorRow = document.createElement('div');
    colorRow.className = 'stf-color-row';
    let selectedColor = isEdit ? (folder.color || '') : '';

    const swatchButtons = [];
    for (const colorOpt of FOLDER_COLORS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stf-color-swatch';
        btn.title = colorOpt.hex ? colorOpt.id : tr('colorDefault');
        if (colorOpt.hex) {
            btn.style.backgroundColor = colorOpt.hex;
        } else {
            btn.classList.add('stf-color-default');
            btn.appendChild(createIcon('fa-ban'));
        }
        if (selectedColor === colorOpt.hex) {
            btn.classList.add('selected');
        }
        btn.addEventListener('click', () => {
            selectedColor = colorOpt.hex;
            swatchButtons.forEach(b => b.classList.toggle('selected', b === btn));
        });
        swatchButtons.push(btn);
        colorRow.appendChild(btn);
    }
    colorGroup.append(colorLabel, colorRow);
    container.appendChild(colorGroup);

    const popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        okButton: isEdit ? tr('save') : tr('create'),
        cancelButton: tr('cancel'),
        onClosing: (dlg) => {
            if (dlg.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }
            if (!nameInput.value.trim()) {
                globalThis.toastr?.warning?.(tr('folderNameRequired'));
                nameInput.focus();
                return false;
            }
            return true;
        },
    });

    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            popup.completeAffirmative();
        }
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    return {
        name: nameInput.value.trim(),
        parentId: parentSelect.value || null,
        color: selectedColor,
    };
}

/**
 * Opens a confirmation dialog before deleting a folder.
 * @param {string} folderName
 * @returns {Promise<boolean>}
 */
export async function confirmDeleteFolderPopup(folderName) {
    const context = getStContext();
    if (!context?.Popup) return false;
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;

    const content = document.createElement('div');
    content.className = 'stf-dialog';

    const header = document.createElement('h3');
    header.className = 'stf-dialog-title';
    header.textContent = tr('deleteFolderTitle', { name: folderName });

    const desc = document.createElement('p');
    desc.className = 'stf-dialog-desc';
    desc.textContent = tr('deleteFolderBody');

    content.append(header, desc);

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: tr('delete'),
        cancelButton: tr('cancel'),
    });
    const res = await popup.show();
    return res === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Opens the folder picker modal to move 1 or more items into a folder (or back to root).
 * Includes inline quick-create folder support.
 * @param {object} params
 * @param {string} params.title
 * @param {Array<any>} params.folders
 * @param {Record<string, string>} params.assignments
 * @param {string|null} [params.currentFolderId]
 * @param {Set<string>|null} [params.validItemKeys]
 * @param {string|null} [params.defaultParentId]
 * @param {(name: string, parentId: string|null) => any} params.onCreateFolder
 * @returns {Promise<{ targetFolderId: string|null } | null>}
 */
export async function openFolderPickerPopup({
    title,
    folders,
    assignments,
    currentFolderId = null,
    validItemKeys = null,
    defaultParentId = null,
    onCreateFolder,
}) {
    const context = getStContext();
    if (!context?.Popup) return null;
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;

    const container = document.createElement('div');
    container.className = 'stf-dialog stf-picker-dialog';

    const heading = document.createElement('h3');
    heading.className = 'stf-dialog-title';
    heading.textContent = title;
    container.appendChild(heading);

    let chosenFolderId;
    let didChoose = false;

    const listEl = document.createElement('div');
    listEl.className = 'stf-picker-list';

    const statsMap = computeFolderStats(folders, assignments, validItemKeys);

    let popup = null;

    // Root option ("Move out of folder")
    const rootBtn = document.createElement('button');
    rootBtn.type = 'button';
    rootBtn.className = 'stf-picker-item stf-picker-root';
    if (!currentFolderId) {
        rootBtn.classList.add('is-current');
    }
    const rootLeft = document.createElement('span');
    rootLeft.className = 'stf-picker-item-left';
    rootLeft.appendChild(createIcon('fa-house'));
    const rootText = document.createElement('span');
    rootText.textContent = tr('moveOutToRoot');
    rootLeft.appendChild(rootText);
    rootBtn.appendChild(rootLeft);
    if (!currentFolderId) {
        rootBtn.appendChild(createIcon('fa-check', 'stf-picker-check'));
    }
    rootBtn.addEventListener('click', () => {
        chosenFolderId = null;
        didChoose = true;
        popup?.completeAffirmative();
    });
    listEl.appendChild(rootBtn);

    // Folder tree rows
    const tree = flattenFolderTree(folders);
    for (const { folder, depth } of tree) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'stf-picker-item';
        row.style.paddingLeft = `${10 + depth * 18}px`;
        const isCurrent = currentFolderId === folder.id;
        if (isCurrent) {
            row.classList.add('is-current');
        }

        const left = document.createElement('span');
        left.className = 'stf-picker-item-left';

        const icon = createIcon('fa-folder');
        if (folder.color) {
            icon.style.color = folder.color;
        }
        left.appendChild(icon);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'stf-picker-item-name';
        nameSpan.textContent = folder.name;
        left.appendChild(nameSpan);

        const right = document.createElement('span');
        right.className = 'stf-picker-item-right';

        const countSpan = document.createElement('span');
        countSpan.className = 'stf-picker-item-count';
        const folderStats = statsMap.get(folder.id);
        countSpan.textContent = String(folderStats?.totalItems ?? 0);
        right.appendChild(countSpan);

        if (isCurrent) {
            right.appendChild(createIcon('fa-check', 'stf-picker-check'));
        }

        row.append(left, right);
        row.addEventListener('click', () => {
            chosenFolderId = folder.id;
            didChoose = true;
            popup?.completeAffirmative();
        });
        listEl.appendChild(row);
    }

    container.appendChild(listEl);

    // Quick-create bar
    const quickBar = document.createElement('div');
    quickBar.className = 'stf-quick-create';

    const quickInput = document.createElement('input');
    quickInput.type = 'text';
    quickInput.className = 'text_pole flex1';
    quickInput.maxLength = 80;
    quickInput.placeholder = tr('quickCreatePlaceholder');

    const quickBtn = document.createElement('button');
    quickBtn.type = 'button';
    quickBtn.className = 'menu_button menu_button_icon';
    quickBtn.appendChild(createIcon('fa-folder-plus'));
    const quickBtnLabel = document.createElement('span');
    quickBtnLabel.textContent = tr('quickCreateAndMove');
    quickBtn.appendChild(quickBtnLabel);

    const handleQuickCreate = () => {
        const name = quickInput.value.trim();
        if (!name) {
            globalThis.toastr?.warning?.(tr('folderNameRequired'));
            quickInput.focus();
            return;
        }
        const created = onCreateFolder?.(name, defaultParentId);
        if (created) {
            chosenFolderId = created.id;
            didChoose = true;
            popup?.completeAffirmative();
        }
    };

    quickBtn.addEventListener('click', handleQuickCreate);
    quickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            handleQuickCreate();
        }
    });

    quickBar.append(quickInput, quickBtn);
    container.appendChild(quickBar);

    popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: tr('cancel'),
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE || !didChoose) {
        return null;
    }

    return { targetFolderId: chosenFolderId ?? null };
}

/**
 * Attaches drag-and-drop drop-target behavior to a folder or breadcrumb element.
 * @param {HTMLElement} element
 * @param {object} options
 * @param {'char'|'chat'} options.domain
 * @param {string|null} options.targetFolderId
 * @param {Array<any>} options.folders
 * @param {(keys: string[], targetFolderId: string|null) => void} options.onDropItems
 * @param {(folderId: string, targetParentId: string|null) => void} [options.onDropFolder]
 */
export function attachDropTarget(element, { domain, targetFolderId, folders, onDropItems, onDropFolder }) {
    const canAcceptDrag = () => {
        const payload = getActiveDragPayload();
        if (!payload || payload.domain !== domain) return false;
        if (payload.kind === 'folder') {
            if (!payload.folderId || payload.folderId === targetFolderId) return false;
            return !wouldCreateCycle(folders, payload.folderId, targetFolderId);
        }
        return payload.kind === 'items' && Array.isArray(payload.keys) && payload.keys.length > 0;
    };

    element.addEventListener('dragover', (e) => {
        if (!canAcceptDrag()) return;
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
        }
        element.classList.add('stf-drop-hover');
    });

    element.addEventListener('dragleave', (e) => {
        if (e.relatedTarget instanceof Node && element.contains(e.relatedTarget)) {
            return;
        }
        element.classList.remove('stf-drop-hover');
    });

    element.addEventListener('drop', (e) => {
        element.classList.remove('stf-drop-hover');
        const payload = getActiveDragPayload();
        if (!payload || payload.domain !== domain) return;
        if (!canAcceptDrag()) return;

        e.preventDefault();
        e.stopPropagation();

        if (payload.kind === 'folder' && payload.folderId) {
            onDropFolder?.(payload.folderId, targetFolderId);
        } else if (payload.kind === 'items' && payload.keys?.length) {
            onDropItems?.(payload.keys, targetFolderId);
        }
        setActiveDragPayload(null);
    });
}

/**
 * Renders breadcrumb navigation into `container`.
 * @param {HTMLElement} container
 * @param {object} params
 * @param {'char'|'chat'} params.domain
 * @param {string} params.rootLabel
 * @param {Array<any>} params.folders
 * @param {string|null} params.activeFolderId
 * @param {(folderId: string|null) => void} params.onNavigate
 * @param {(keys: string[], targetFolderId: string|null) => void} params.onDropItems
 * @param {(folderId: string, targetParentId: string|null) => void} params.onDropFolder
 */
export function renderBreadcrumbs(container, {
    domain,
    rootLabel,
    folders,
    activeFolderId,
    onNavigate,
    onDropItems,
    onDropFolder,
}) {
    container.replaceChildren();
    const crumbs = getBreadcrumbs(folders, activeFolderId);

    const makeCrumb = (label, targetId, isCurrent, isRoot = false) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stf-crumb';
        if (isCurrent) btn.classList.add('is-current');
        if (isRoot) {
            btn.appendChild(createIcon('fa-house'));
        } else {
            btn.appendChild(createIcon('fa-folder-open'));
        }
        const span = document.createElement('span');
        span.textContent = label;
        btn.appendChild(span);

        btn.addEventListener('click', () => {
            onNavigate(targetId);
        });

        attachDropTarget(btn, {
            domain,
            targetFolderId: targetId,
            folders,
            onDropItems,
            onDropFolder,
        });

        return btn;
    };

    container.appendChild(makeCrumb(rootLabel, null, crumbs.length === 0, true));

    for (let i = 0; i < crumbs.length; i++) {
        const sep = document.createElement('span');
        sep.className = 'stf-crumb-sep';
        sep.appendChild(createIcon('fa-chevron-right'));
        container.appendChild(sep);

        const crumb = crumbs[i];
        const isLast = i === crumbs.length - 1;
        container.appendChild(makeCrumb(crumb.name, crumb.id, isLast, false));
    }
}

/**
 * Builds a reusable Folder Card DOM element for either character list or chat list.
 * @param {object} params
 * @param {'char'|'chat'} params.domain
 * @param {object} params.folder
 * @param {Array<any>} params.folders
 * @param {{ directItems: number, totalItems: number, directSubfolders: number }} params.stats
 * @param {string[]} [params.previewUrls]
 * @param {boolean} [params.hasActiveIndicator]
 * @param {(folderId: string) => void} params.onOpen
 * @param {(folder: object) => void} params.onEdit
 * @param {(folder: object) => void} params.onDelete
 * @param {(keys: string[], targetFolderId: string|null) => void} params.onDropItems
 * @param {(folderId: string, targetParentId: string|null) => void} params.onDropFolder
 * @returns {HTMLDivElement}
 */
export function buildFolderCard({
    domain,
    folder,
    folders,
    stats,
    previewUrls = [],
    hasActiveIndicator = false,
    onOpen,
    onEdit,
    onDelete,
    onDropItems,
    onDropFolder,
}) {
    const card = document.createElement('div');
    card.className = `stf-folder-card stf-folder-card-${domain}`;
    card.dataset.folderId = folder.id;
    card.setAttribute('draggable', 'true');
    if (folder.color) {
        card.style.setProperty('--stf-folder-accent', folder.color);
    }

    // Avatar / icon box
    const iconBox = document.createElement('div');
    iconBox.className = 'stf-folder-avatar';
    if (folder.color) {
        iconBox.style.backgroundColor = `${folder.color}26`;
        iconBox.style.borderColor = `${folder.color}88`;
        iconBox.style.color = folder.color;
    }
    iconBox.appendChild(createIcon('fa-folder'));
    if (hasActiveIndicator) {
        const dot = document.createElement('span');
        dot.className = 'stf-active-dot';
        dot.title = tr('activeChatHere');
        iconBox.appendChild(dot);
    }

    // Text meta block
    const meta = document.createElement('div');
    meta.className = 'stf-folder-meta';

    const titleRow = document.createElement('div');
    titleRow.className = 'stf-folder-title-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'stf-folder-name';
    nameEl.textContent = folder.name;
    nameEl.title = folder.name;

    const countEl = document.createElement('span');
    countEl.className = 'stf-folder-count';
    countEl.textContent = stats.directSubfolders > 0
        ? tr('subfolderCountText', { folders: stats.directSubfolders, items: stats.totalItems })
        : tr('folderCountText', { count: stats.totalItems });

    titleRow.append(nameEl, countEl);
    meta.appendChild(titleRow);

    if (previewUrls.length > 0) {
        const previews = document.createElement('div');
        previews.className = 'stf-folder-previews';
        for (const url of previewUrls.slice(0, 4)) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.loading = 'lazy';
            previews.appendChild(img);
        }
        meta.appendChild(previews);
    }

    // Actions block
    const actions = document.createElement('div');
    actions.className = 'stf-folder-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'stf-icon-btn';
    editBtn.title = tr('renameOrEdit');
    editBtn.appendChild(createIcon('fa-pen'));
    editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onEdit(folder);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'stf-icon-btn stf-icon-btn-danger';
    delBtn.title = tr('delete');
    delBtn.appendChild(createIcon('fa-trash-can'));
    delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onDelete(folder);
    });

    actions.append(editBtn, delBtn);
    card.append(iconBox, meta, actions);

    card.addEventListener('click', (e) => {
        // Ignore clicks during SillyTavern native bulk select overlay
        if (domain === 'char' && document.getElementById('rm_print_characters_block')?.classList.contains('group_overlay_mode_select')) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        onOpen(folder.id);
    });

    card.addEventListener('dragstart', (e) => {
        setActiveDragPayload({
            domain,
            kind: 'folder',
            folderId: folder.id,
        });
        card.classList.add('stf-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', `folder:${folder.id}`);
        }
    });

    card.addEventListener('dragend', () => {
        card.classList.remove('stf-dragging');
        setActiveDragPayload(null);
    });

    attachDropTarget(card, {
        domain,
        targetFolderId: folder.id,
        folders,
        onDropItems,
        onDropFolder,
    });

    return card;
}

/**
 * Shows or hides a character/group/chat card element when filtered out of root by folder rules.
 * Uses both inline `display` and the `.stf-hidden-by-folder` CSS class so theme styles cannot override it.
 * @param {HTMLElement} el
 * @param {boolean} hidden
 */
export function setElementFolderHidden(el, hidden) {
    if (hidden) {
        if (typeof el.style?.setProperty === 'function') {
            el.style.setProperty('display', 'none', 'important');
        } else if (el.style) {
            el.style.display = 'none';
        }
        el.hidden = true;
        el.classList.add('stf-hidden-by-folder');
        el.dataset.stfHiddenByFolder = '1';
    } else if (el.dataset.stfHiddenByFolder === '1' || el.classList.contains('stf-hidden-by-folder')) {
        if (typeof el.style?.removeProperty === 'function') {
            el.style.removeProperty('display');
        }
        if (el.style) {
            el.style.display = '';
        }
        el.hidden = false;
        el.classList.remove('stf-hidden-by-folder');
        delete el.dataset.stfHiddenByFolder;
    }
}

/**
 * Builds a clickable folder badge pill for item cards (`char`, `chat`, or `recent`).
 * @param {object} params
 * @param {object} params.folder
 * @param {Array<any>} params.folders
 * @param {string} [params.extraClass]
 * @param {(folderId: string) => void} params.onOpen
 * @returns {HTMLSpanElement}
 */
export function buildFolderBadge({ folder, folders, extraClass = '', onOpen }) {
    const badge = document.createElement('span');
    badge.className = extraClass ? `stf-folder-badge ${extraClass}` : 'stf-folder-badge';
    badge.title = tr('folderBadgeTitle', { path: getFolderPathLabel(folders, folder.id) });
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
        onOpen?.(folder.id);
    });

    return badge;
}

/**
 * Resolves thumbnail URLs (max 4, deduplicated) for entity keys (`char:...`, `group:...`, or `scope::chat`).
 * @param {string[]} previewKeys
 * @returns {string[]}
 */
export function resolveEntityPreviewUrls(previewKeys) {
    const context = getStContext();
    if (!context) return [];
    const urls = [];

    for (const rawKey of previewKeys) {
        if (urls.length >= 4) break;
        const parsed = parseRecentChatKey(rawKey);
        const entityKey = parsed ? parsed.scopeKey : String(rawKey || '');
        let url = '';

        if (entityKey.startsWith('char:')) {
            const avatar = entityKey.slice(5);
            const char = context.characters?.find(c => c.avatar === avatar);
            if (char && char.avatar !== 'none') {
                url = context.getThumbnailUrl?.('avatar', char.avatar) || '';
            }
        } else if (entityKey.startsWith('group:')) {
            const groupId = entityKey.slice(6);
            const group = context.groups?.find(g => String(g.id) === String(groupId));
            if (group?.members?.length) {
                const firstMember = context.characters?.find(c => c.avatar === group.members[0]);
                if (firstMember && firstMember.avatar !== 'none') {
                    url = context.getThumbnailUrl?.('avatar', firstMember.avatar) || '';
                }
            }
        }

        if (url && !urls.includes(url)) {
            urls.push(url);
        }
    }

    return urls;
}

/**
 * Builds a reusable folder toolbar scaffold (back button, breadcrumbs, create/batch/hide buttons, and batch bar).
 * @param {object} params
 * @param {string} params.id
 * @param {string} [params.extraClass]
 * @param {() => void} params.onBack
 * @param {() => void} params.onCreateFolder
 * @param {() => void} params.onToggleBatch
 * @param {() => void} params.onToggleHide
 * @param {() => void} params.onBatchSelectAll
 * @param {() => void} params.onBatchMove
 * @param {() => void} params.onBatchMoveOut
 * @param {() => void} params.onBatchCancel
 */
export function createFolderToolbarScaffold({
    id,
    extraClass = '',
    onBack,
    onCreateFolder,
    onToggleBatch,
    onToggleHide,
    onBatchSelectAll,
    onBatchMove,
    onBatchMoveOut,
    onBatchCancel,
}) {
    const toolbarEl = document.createElement('div');
    toolbarEl.id = id;
    toolbarEl.className = extraClass ? `stf-toolbar ${extraClass}` : 'stf-toolbar';

    const topRow = document.createElement('div');
    topRow.className = 'stf-toolbar-row';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'menu_button stf-back-btn';
    backBtn.appendChild(createIcon('fa-arrow-left'));
    backBtn.addEventListener('click', onBack);

    const breadcrumbEl = document.createElement('div');
    breadcrumbEl.className = 'stf-breadcrumbs';

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'stf-toolbar-actions';

    const newFolderBtn = document.createElement('button');
    newFolderBtn.type = 'button';
    newFolderBtn.className = 'menu_button menu_button_icon stf-toolbar-btn';
    newFolderBtn.appendChild(createIcon('fa-folder-plus'));
    const newLabel = document.createElement('span');
    newLabel.textContent = tr('newFolderShort');
    newFolderBtn.appendChild(newLabel);
    newFolderBtn.addEventListener('click', onCreateFolder);

    const batchBtn = document.createElement('button');
    batchBtn.type = 'button';
    batchBtn.className = 'menu_button menu_button_icon stf-toolbar-btn';
    batchBtn.appendChild(createIcon('fa-list-check'));
    const batchLabel = document.createElement('span');
    batchLabel.textContent = tr('batchSelect');
    batchBtn.appendChild(batchLabel);
    batchBtn.addEventListener('click', onToggleBatch);

    const hideToggleBtn = document.createElement('button');
    hideToggleBtn.type = 'button';
    hideToggleBtn.className = 'menu_button stf-toolbar-btn stf-icon-only-btn';
    hideToggleBtn.appendChild(createIcon('fa-eye-slash'));
    hideToggleBtn.addEventListener('click', onToggleHide);

    actionsWrap.append(newFolderBtn, batchBtn, hideToggleBtn);
    topRow.append(backBtn, breadcrumbEl, actionsWrap);

    const batchBarEl = document.createElement('div');
    batchBarEl.className = 'stf-batch-bar';
    batchBarEl.style.display = 'none';

    const countSpan = document.createElement('span');
    countSpan.className = 'stf-batch-count';

    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'menu_button stf-batch-select-all';
    selectAllBtn.addEventListener('click', onBatchSelectAll);

    const batchMoveBtn = document.createElement('button');
    batchMoveBtn.type = 'button';
    batchMoveBtn.className = 'menu_button stf-batch-move stf-primary-btn';
    batchMoveBtn.addEventListener('click', onBatchMove);

    const batchMoveOutBtn = document.createElement('button');
    batchMoveOutBtn.type = 'button';
    batchMoveOutBtn.className = 'menu_button stf-batch-move-out';
    batchMoveOutBtn.addEventListener('click', onBatchMoveOut);

    const batchCancelBtn = document.createElement('button');
    batchCancelBtn.type = 'button';
    batchCancelBtn.className = 'menu_button stf-batch-cancel';
    batchCancelBtn.addEventListener('click', onBatchCancel);

    batchBarEl.append(countSpan, selectAllBtn, batchMoveBtn, batchMoveOutBtn, batchCancelBtn);
    toolbarEl.append(topRow, batchBarEl);

    return {
        toolbarEl,
        backBtn,
        breadcrumbEl,
        newFolderBtn,
        batchBtn,
        hideToggleBtn,
        batchBarEl,
    };
}

/**
 * Updates common toolbar controls (breadcrumbs, labels, batch bar, hide toggle).
 * @param {ReturnType<typeof createFolderToolbarScaffold>} refs
 * @param {object} state
 */
export function updateFolderToolbarScaffold(refs, {
    enabled,
    domain,
    rootLabel,
    folders,
    activeFolderId,
    isBatchMode,
    selectedCount,
    hideInRoot,
    hideActiveHintKey,
    hideInactiveHintKey,
    onNavigate,
    onDropItems,
    onDropFolder,
}) {
    const { toolbarEl, backBtn, breadcrumbEl, newFolderBtn, batchBtn, hideToggleBtn, batchBarEl } = refs;
    if (!toolbarEl) return;

    if (!enabled) {
        toolbarEl.style.display = 'none';
        return;
    }
    toolbarEl.style.display = '';

    renderBreadcrumbs(breadcrumbEl, {
        domain,
        rootLabel,
        folders,
        activeFolderId,
        onNavigate,
        onDropItems,
        onDropFolder,
    });

    backBtn.style.display = activeFolderId ? '' : 'none';
    backBtn.title = tr('backUp');

    newFolderBtn.title = tr('newFolder');
    const newLabel = newFolderBtn.querySelector('span');
    if (newLabel) newLabel.textContent = tr('newFolderShort');

    batchBtn.classList.toggle('active', isBatchMode);
    batchBtn.title = tr('batchSelect');
    const batchLabel = batchBtn.querySelector('span');
    if (batchLabel) batchLabel.textContent = isBatchMode ? tr('batchDone') : tr('batchSelect');

    hideToggleBtn.title = tr(hideInRoot ? hideActiveHintKey : hideInactiveHintKey);
    hideToggleBtn.classList.toggle('active', hideInRoot);
    const icon = hideToggleBtn.querySelector('i');
    if (icon) {
        icon.className = hideInRoot ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }

    batchBarEl.style.display = isBatchMode ? 'flex' : 'none';
    const countEl = batchBarEl.querySelector('.stf-batch-count');
    if (countEl) countEl.textContent = tr('batchSelectedCount', { count: selectedCount });
    const selAllBtn = batchBarEl.querySelector('.stf-batch-select-all');
    if (selAllBtn) selAllBtn.textContent = tr('selectAllVisible');
    const moveBtn = batchBarEl.querySelector('.stf-batch-move');
    if (moveBtn) moveBtn.textContent = tr('batchMoveTo');
    const moveOutBtn = batchBarEl.querySelector('.stf-batch-move-out');
    if (moveOutBtn) moveOutBtn.textContent = tr('batchMoveOut');
    const cancelBtn = batchBarEl.querySelector('.stf-batch-cancel');
    if (cancelBtn) cancelBtn.textContent = tr('cancel');
}

/**
 * Scrolls the list container to the top and highlights a newly created folder card so it is immediately visible.
 * @param {HTMLElement|null} container
 * @param {string} folderId
 */
export function revealFolderCard(container, folderId) {
    if (!container) return;
    container.scrollTop = 0;
    const cards = container.querySelectorAll('.stf-folder-card');
    for (const card of cards) {
        if (card instanceof HTMLElement && card.dataset?.folderId === folderId) {
            card.classList.add('stf-just-created');
            card.scrollIntoView?.({ block: 'nearest' });
            break;
        }
    }
}
