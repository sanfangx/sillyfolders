/**
 * Bilingual localization helper (Simplified Chinese + English) for SillyTavern Folders.
 */

const MESSAGES = {
    zh: {
        extensionTitle: '文件夹管理 (Folders)',
        enabledLabel: '启用角色卡与对话文件夹',
        hideFolderedCharsLabel: '根目录隐藏已放入文件夹的角色卡/群组',
        hideFolderedChatsLabel: '根目录隐藏已放入文件夹的对话',
        languageLabel: '界面语言',
        languageAuto: '自动（跟随酒馆设置）',
        languageZh: '简体中文',
        languageEn: 'English',
        statsTemplate: '角色文件夹：{charFolders} 个（已归类 {charItems} 项） · 对话文件夹：{chatFolders} 个（已归类 {chatItems} 条）',
        exportConfig: '导出文件夹配置',
        importConfig: '导入文件夹配置',
        cleanupOrphans: '清理无效记录',
        cleanupDone: '已清理 {count} 条无效的归类记录',
        exportSuccess: '已导出文件夹配置',
        importSuccess: '文件夹配置导入成功',
        importInvalid: '导入失败：配置文件格式无效',
        rootChars: '全部',
        rootChats: '全部对话',
        rootRecentChats: '最近的聊天',
        backUp: '返回上级',
        newFolder: '新建文件夹',
        newFolderShort: '新建',
        batchSelect: '批量整理',
        batchDone: '完成',
        batchMoveTo: '移入文件夹...',
        batchMoveOut: '移出到根目录',
        batchSelectedCount: '已选 {count} 项',
        selectAllVisible: '全选当前',
        toggleHideFolderedChars: '切换根目录隐藏已归类角色',
        toggleHideFolderedChats: '切换根目录隐藏已归类对话',
        hideCharsActiveHint: '根目录已隐藏已归类角色卡（点击改为全部显示）',
        hideCharsInactiveHint: '根目录正显示全部角色卡（点击隐藏已归类角色）',
        hideChatsActiveHint: '根目录已隐藏已归类对话（点击改为全部显示）',
        hideChatsInactiveHint: '根目录正显示全部对话（点击隐藏已归类对话）',
        moveToFolder: '放入文件夹',
        nativeBulkMoveToFolder: '批量放入文件夹',
        moveCurrentChatToFolder: '将当前对话放入文件夹',
        noActiveChatForFolder: '请先打开一个角色卡或群组对话',
        createFolderTitle: '新建文件夹',
        editFolderTitle: '编辑文件夹',
        folderNameLabel: '文件夹名称',
        folderNamePlaceholder: '例如：收藏 / 奇幻 / 主线剧情',
        folderNameRequired: '请输入文件夹名称',
        parentFolderLabel: '所属父文件夹',
        rootOption: '根目录（无父级）',
        folderColorLabel: '文件夹颜色',
        colorDefault: '默认',
        save: '保存',
        create: '创建',
        cancel: '取消',
        delete: '删除',
        renameOrEdit: '编辑 / 重命名',
        deleteFolderTitle: '删除文件夹“{name}”？',
        deleteFolderBody: '删除文件夹不会删除里面的角色卡或对话。文件夹内的项目和子文件夹将自动移回上级目录（或根目录）。',
        folderCreated: '已创建文件夹“{name}”',
        folderUpdated: '已更新文件夹“{name}”',
        folderDeleted: '已删除文件夹“{name}”',
        pickerTitleSingle: '将“{name}”放入文件夹',
        pickerTitleBatch: '将选中的 {count} 项放入文件夹',
        moveOutToRoot: '移出文件夹（放到根目录）',
        quickCreatePlaceholder: '输入新文件夹名称，按回车或点击创建并移入...',
        quickCreateAndMove: '新建并移入',
        movedToFolder: '已移入文件夹“{name}”',
        movedToRoot: '已移出到根目录',
        pleaseSelectItems: '请先选择要整理的项目',
        emptyCharFolder: '此文件夹暂无角色卡。点击卡片上的文件夹按钮，或直接将卡片拖拽到文件夹即可移入。',
        emptyChatFolder: '此文件夹暂无对话。点击对话右侧的文件夹图标，或将对话拖拽到文件夹即可移入。',
        emptyRecentFolder: '此文件夹暂无最近对话。点击对话右上角的文件夹按钮，或将对话拖拽到文件夹即可移入。',
        folderCountText: '{count} 项',
        subfolderCountText: '{folders} 子文件夹 · {items} 项',
        activeChatHere: '当前对话在此文件夹中',
        folderBadgeTitle: '所在文件夹：{path}',
        pageInfo: '第 {page}/{totalPages} 页（共 {total} 项）',
        prevPage: '上一页',
        nextPage: '下一页',
        confirm: '确认',
    },
    en: {
        extensionTitle: 'Folders (Characters & Chats)',
        enabledLabel: 'Enable character and chat folders',
        hideFolderedCharsLabel: 'Hide foldered characters/groups from root view',
        hideFolderedChatsLabel: 'Hide foldered chats from root view',
        languageLabel: 'Language',
        languageAuto: 'Auto (Follow SillyTavern)',
        languageZh: '简体中文',
        languageEn: 'English',
        statsTemplate: 'Character folders: {charFolders} ({charItems} items) · Chat folders: {chatFolders} ({chatItems} chats)',
        exportConfig: 'Export Folders JSON',
        importConfig: 'Import Folders JSON',
        cleanupOrphans: 'Clean Orphaned Entries',
        cleanupDone: 'Cleaned {count} orphaned entries',
        exportSuccess: 'Exported folder configuration',
        importSuccess: 'Imported folder configuration',
        importInvalid: 'Import failed: invalid configuration file',
        rootChars: 'All',
        rootChats: 'All Chats',
        rootRecentChats: 'Recent Chats',
        backUp: 'Up',
        newFolder: 'New Folder',
        newFolderShort: 'New',
        batchSelect: 'Batch Move',
        batchDone: 'Done',
        batchMoveTo: 'Move to folder...',
        batchMoveOut: 'Move to root',
        batchSelectedCount: '{count} selected',
        selectAllVisible: 'Select all',
        toggleHideFolderedChars: 'Toggle hiding foldered characters at root',
        toggleHideFolderedChats: 'Toggle hiding foldered chats at root',
        hideCharsActiveHint: 'Foldered characters are hidden in root (click to show all)',
        hideCharsInactiveHint: 'All characters are shown in root (click to hide foldered)',
        hideChatsActiveHint: 'Foldered chats are hidden in root (click to show all)',
        hideChatsInactiveHint: 'All chats are shown in root (click to hide foldered)',
        moveToFolder: 'Move to folder',
        nativeBulkMoveToFolder: 'Move selected to folder',
        moveCurrentChatToFolder: 'Move current chat to folder',
        noActiveChatForFolder: 'Open a character or group chat first',
        createFolderTitle: 'New Folder',
        editFolderTitle: 'Edit Folder',
        folderNameLabel: 'Folder Name',
        folderNamePlaceholder: 'e.g. Favorites / Fantasy / Main Story',
        folderNameRequired: 'Please enter a folder name',
        parentFolderLabel: 'Parent Folder',
        rootOption: 'Root (Top Level)',
        folderColorLabel: 'Folder Color',
        colorDefault: 'Default',
        save: 'Save',
        create: 'Create',
        cancel: 'Cancel',
        delete: 'Delete',
        renameOrEdit: 'Edit / Rename',
        deleteFolderTitle: 'Delete folder "{name}"?',
        deleteFolderBody: 'Deleting a folder will NOT delete the characters or chats inside. They will be moved back to the parent folder or root.',
        folderCreated: 'Created folder "{name}"',
        folderUpdated: 'Updated folder "{name}"',
        folderDeleted: 'Deleted folder "{name}"',
        pickerTitleSingle: 'Move "{name}" to folder',
        pickerTitleBatch: 'Move {count} selected item(s) to folder',
        moveOutToRoot: 'Remove from folder (Move to root)',
        quickCreatePlaceholder: 'New folder name, press Enter or click to create & move...',
        quickCreateAndMove: 'Create & Move',
        movedToFolder: 'Moved to "{name}"',
        movedToRoot: 'Moved to root',
        pleaseSelectItems: 'Select one or more items first',
        emptyCharFolder: 'This folder is empty. Click the folder icon on any card or drag a card onto a folder to move it here.',
        emptyChatFolder: 'This folder has no chats yet. Click the folder icon on a chat row or drag a chat onto a folder.',
        emptyRecentFolder: 'This folder has no recent chats yet. Click the folder button on any recent chat or drag it onto a folder.',
        folderCountText: '{count}',
        subfolderCountText: '{folders} folders · {items} items',
        activeChatHere: 'Active chat is in this folder',
        folderBadgeTitle: 'Folder: {path}',
        pageInfo: 'Page {page}/{totalPages} ({total} items)',
        prevPage: 'Prev',
        nextPage: 'Next',
        confirm: 'Confirm',
    },
};

let currentLanguageSetting = 'auto';

/**
 * Sets the active language preference ('auto' | 'zh' | 'en').
 * @param {'auto'|'zh'|'en'} language
 */
export function setLanguagePreference(language) {
    if (language === 'zh' || language === 'en' || language === 'auto') {
        currentLanguageSetting = language;
    }
}

/**
 * Resolves the active locale ('zh' or 'en').
 * @param {() => string} [getLocaleFn]
 * @returns {'zh'|'en'}
 */
export function resolveLocale(getLocaleFn) {
    if (currentLanguageSetting === 'zh' || currentLanguageSetting === 'en') {
        return currentLanguageSetting;
    }

    let raw = '';
    try {
        if (typeof getLocaleFn === 'function') {
            raw = String(getLocaleFn() || '');
        } else if (typeof globalThis.SillyTavern?.getContext === 'function') {
            raw = String(globalThis.SillyTavern.getContext().getCurrentLocale?.() || '');
        }
    } catch {
        raw = '';
    }

    if (!raw && typeof navigator !== 'undefined') {
        raw = String(navigator.language || '');
    }

    return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Translates a UI message key with optional placeholder substitution.
 * @param {keyof typeof MESSAGES.zh} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function tr(key, params = {}) {
    const lang = resolveLocale();
    const table = MESSAGES[lang] || MESSAGES.en;
    let text = table[key] ?? MESSAGES.en[key] ?? String(key);

    for (const [paramKey, paramValue] of Object.entries(params)) {
        text = text.replaceAll(`{${paramKey}}`, String(paramValue));
    }

    return text;
}
