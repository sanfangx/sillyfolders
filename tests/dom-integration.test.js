import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal, faithful DOM + Event + SillyTavern context harness to test
 * `index.js`, `char-folders.js`, `chat-folders.js`, and `settings-panel.js` end-to-end.
 */

class MiniEventEmitter {
    #listeners = new Map();
    on(event, fn) {
        if (!this.#listeners.has(event)) this.#listeners.set(event, []);
        this.#listeners.get(event).push(fn);
    }
    emit(event, ...args) {
        for (const fn of this.#listeners.get(event) || []) {
            fn(...args);
        }
    }
}

class MiniClassList {
    constructor(el) {
        this.el = el;
        this.set = new Set();
    }
    syncFromString(str) {
        this.set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    add(...tokens) {
        tokens.forEach(t => t && this.set.add(t));
        this.el._className = [...this.set].join(' ');
    }
    remove(...tokens) {
        tokens.forEach(t => this.set.delete(t));
        this.el._className = [...this.set].join(' ');
    }
    toggle(token, force) {
        const shouldAdd = force !== undefined ? Boolean(force) : !this.set.has(token);
        if (shouldAdd) this.add(token);
        else this.remove(token);
        return shouldAdd;
    }
    contains(token) {
        return this.set.has(token);
    }
}

function matchesSingleSelector(el, sel) {
    if (!el || el.nodeType !== 1) return false;
    let s = sel.trim();
    if (!s) return false;

    if (s.startsWith(':scope > ')) {
        s = s.slice(9).trim();
    }

    const notMatches = [...s.matchAll(/:not\(([^)]+)\)/g)].map(m => m[1]);
    for (const inner of notMatches) {
        if (matchesSingleSelector(el, inner)) return false;
    }
    s = s.replace(/:not\([^)]+\)/g, '');

    // Split tag, #id, .class, [attr]
    const idMatch = s.match(/#([\w-]+)/);
    if (idMatch && el.id !== idMatch[1]) return false;

    const classMatches = [...s.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    for (const cls of classMatches) {
        if (!el.classList.contains(cls)) return false;
    }

    const attrMatches = [...s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    for (const [, attrName, attrVal] of attrMatches) {
        if (!el.hasAttribute(attrName)) return false;
        if (attrVal !== undefined && el.getAttribute(attrName) !== attrVal) return false;
    }

    const tagMatch = s.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch && el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;

    return true;
}

function matchesSelector(el, selectorGroup) {
    return selectorGroup.split(',').some((part) => {
        const partTrim = part.trim();
        if (partTrim.includes(' ')) {
            const tokens = partTrim.split(/\s+/).filter(t => t !== '>' && t !== ':scope');
            if (partTrim.startsWith(':scope > ')) {
                return matchesSingleSelector(el, tokens[tokens.length - 1]);
            }
            if (!matchesSingleSelector(el, tokens[tokens.length - 1])) return false;
            let cursor = el.parentElement;
            for (let i = tokens.length - 2; i >= 0; i--) {
                while (cursor && !matchesSingleSelector(cursor, tokens[i])) {
                    cursor = cursor.parentElement;
                }
                if (!cursor) return false;
                cursor = cursor.parentElement;
            }
            return true;
        }
        return matchesSingleSelector(el, partTrim);
    });
}

class MiniNode {
    constructor(nodeType, tagName = '') {
        this.nodeType = nodeType;
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.dataset = {};
        this.style = {
            setProperty: (k, v) => { this.style[k] = v; },
        };
        this._className = '';
        this.classList = new MiniClassList(this);
        this.listeners = { capture: new Map(), bubble: new Map() };
        this._text = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.selectedOptions = [];
        this.observers = [];
    }

    get parentElement() {
        return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }

    get id() {
        return this.attributes.get('id') || '';
    }
    set id(val) {
        this.attributes.set('id', String(val));
    }

    get className() {
        return this._className;
    }
    set className(val) {
        this._className = String(val || '');
        this.classList.syncFromString(this._className);
    }

    get textContent() {
        if (this.children.length === 0) return this._text;
        return this.children.map(c => c.textContent).join('');
    }
    set textContent(val) {
        this.children = [];
        this._text = String(val ?? '');
    }

    setAttribute(name, value) {
        const str = String(value);
        this.attributes.set(name, str);
        if (name === 'class') this.className = str;
        if (name.startsWith('data-')) {
            const camel = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            this.dataset[camel] = str;
        }
    }
    getAttribute(name) {
        if (name === 'class') return this._className;
        return this.attributes.get(name) ?? null;
    }
    hasAttribute(name) {
        return this.attributes.has(name);
    }
    removeAttribute(name) {
        this.attributes.delete(name);
    }

    appendChild(child) {
        if (child.nodeType === 11) {
            for (const sub of [...child.children]) {
                this.appendChild(sub);
            }
            return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        this._notifyObservers();
        return child;
    }

    append(...nodes) {
        nodes.forEach(n => this.appendChild(n));
    }

    prepend(...nodes) {
        const flat = [];
        for (const n of nodes) {
            if (n.nodeType === 11) flat.push(...n.children);
            else flat.push(n);
        }
        for (let i = flat.length - 1; i >= 0; i--) {
            const child = flat[i];
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = this;
            this.children.unshift(child);
        }
        this._notifyObservers();
    }

    insertBefore(newNode, refNode) {
        if (!refNode) return this.appendChild(newNode);
        if (newNode.nodeType === 11) {
            for (const sub of [...newNode.children]) {
                this.insertBefore(sub, refNode);
            }
            return newNode;
        }
        if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
        const idx = this.children.indexOf(refNode);
        newNode.parentNode = this;
        if (idx === -1) this.children.push(newNode);
        else this.children.splice(idx, 0, newNode);
        this._notifyObservers();
        return newNode;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentNode = null;
            this._notifyObservers();
        }
        return child;
    }

    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }

    replaceWith(node) {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx !== -1) {
            node.parentNode = this.parentNode;
            this.parentNode.children[idx] = node;
            this.parentNode = null;
        }
    }

    replaceChildren(...nodes) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        this._text = '';
        for (const n of nodes) {
            if (n.nodeType === 11) {
                for (const sub of [...n.children]) {
                    sub.parentNode = this;
                    this.children.push(sub);
                }
            } else {
                if (n.parentNode) n.parentNode.removeChild(n);
                n.parentNode = this;
                this.children.push(n);
            }
        }
        this._notifyObservers();
    }

    _notifyObservers() {
        for (const obs of this.observers) {
            obs._trigger();
        }
    }

    cloneNode(deep = false) {
        const copy = new MiniNode(this.nodeType, this.tagName);
        copy._text = this._text;
        copy._className = this._className;
        copy.classList.syncFromString(this._className);
        for (const [k, v] of this.attributes.entries()) {
            copy.attributes.set(k, v);
        }
        copy.dataset = { ...this.dataset };
        if (deep) {
            for (const child of this.children) {
                copy.appendChild(child.cloneNode(true));
            }
        }
        return copy;
    }

    querySelectorAll(selector) {
        const results = [];
        const isDirectChild = selector.trim().startsWith(':scope > ');
        if (isDirectChild) {
            const subSel = selector.trim().slice(9).trim();
            for (const c of this.children) {
                if (matchesSelector(c, subSel)) results.push(c);
            }
            return results;
        }
        const walk = (node) => {
            for (const c of node.children) {
                if (matchesSelector(c, selector)) results.push(c);
                walk(c);
            }
        };
        walk(this);
        return results;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    closest(selector) {
        let cursor = this;
        while (cursor && cursor.nodeType === 1) {
            if (matchesSelector(cursor, selector)) return cursor;
            cursor = cursor.parentElement;
        }
        return null;
    }

    contains(node) {
        let cursor = node;
        while (cursor) {
            if (cursor === this) return true;
            cursor = cursor.parentNode;
        }
        return false;
    }

    addEventListener(type, fn, capture = false) {
        const bucket = capture ? this.listeners.capture : this.listeners.bubble;
        if (!bucket.has(type)) bucket.set(type, []);
        bucket.get(type).push(fn);
    }

    dispatchEvent(evt) {
        evt.target = evt.target || this;
        const path = [];
        let cursor = this;
        while (cursor) {
            path.unshift(cursor);
            cursor = cursor.parentNode;
        }
        // Capture phase
        for (const node of path) {
            if (evt._stoppedImmediate) break;
            for (const fn of node.listeners?.capture?.get(evt.type) || []) {
                evt.currentTarget = node;
                fn.call(node, evt);
                if (evt._stoppedImmediate) break;
            }
            if (evt._stopped) break;
        }
        if (evt._stopped || evt._stoppedImmediate) return !evt._defaultPrevented;

        // Bubble phase
        for (let i = path.length - 1; i >= 0; i--) {
            const node = path[i];
            if (evt._stoppedImmediate) break;
            for (const fn of node.listeners?.bubble?.get(evt.type) || []) {
                evt.currentTarget = node;
                fn.call(node, evt);
                if (evt._stoppedImmediate) break;
            }
            if (evt._stopped) break;
        }
        return !evt._defaultPrevented;
    }

    click() {
        const evt = createDomEvent('click', this);
        this.dispatchEvent(evt);
    }
}

function createDomEvent(type, target = null) {
    return {
        type,
        target,
        currentTarget: target,
        _stopped: false,
        _stoppedImmediate: false,
        _defaultPrevented: false,
        preventDefault() { this._defaultPrevented = true; },
        stopPropagation() { this._stopped = true; },
        stopImmediatePropagation() { this._stopped = true; this._stoppedImmediate = true; },
    };
}

function setupEnvironment() {
    const doc = new MiniNode(9, '#document');
    const body = new MiniNode(1, 'body');
    doc.appendChild(body);

    const createEl = (tag, attrs = {}, children = []) => {
        const el = new MiniNode(1, tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'textContent') el.textContent = v;
            else el.setAttribute(k, v);
        }
        for (const c of children) el.appendChild(c);
        return el;
    };

    // Build SillyTavern skeleton DOM
    const charSearch = createEl('input', { id: 'character_search_bar', type: 'search' });
    const sortOptAsc = createEl('option', { 'data-field': 'name', 'data-order': 'asc', textContent: 'A-Z' });
    const charSort = createEl('select', { id: 'character_sort_order' }, [sortOptAsc]);
    charSort.selectedOptions = [sortOptAsc];

    const bulkDelBtn = createEl('i', { id: 'bulkDeleteButton' });
    const paginationJs = createEl('div', { class: 'paginationjs' });
    const pagination = createEl('div', { id: 'rm_print_characters_pagination' }, [bulkDelBtn, paginationJs]);
    const listBlock = createEl('div', { id: 'rm_print_characters_block' });
    const rmChars = createEl('div', { id: 'rm_characters_block' }, [charSearch, charSort, pagination, listBlock]);

    // Character & group & tag templates
    const charTpl = createEl('div', { id: 'character_template' }, [
        createEl('div', { class: 'character_select entity_block', chid: '', id: '' }, [
            createEl('div', { class: 'avatar' }, [createEl('img')]),
            createEl('div', { class: 'character_select_container' }, [
                createEl('div', { class: 'character_name_block' }, [
                    createEl('span', { class: 'ch_name' }),
                    createEl('small', { class: 'ch_assistant' }),
                    createEl('small', { class: 'character_version' }),
                    createEl('small', { class: 'ch_avatar_url' }),
                ]),
                createEl('i', { class: 'ch_fav_icon' }),
                createEl('input', { class: 'ch_fav' }),
                createEl('div', { class: 'ch_description' }),
                createEl('div', { class: 'tags tags_inline' }),
            ]),
        ]),
    ]);

    const groupTpl = createEl('div', { id: 'group_list_template' }, [
        createEl('div', { class: 'group_select entity_block' }, [
            createEl('div', { class: 'avatar' }, [createEl('img')]),
            createEl('div', { class: 'group_select_container' }, [
                createEl('div', { class: 'group_name_block character_name_block' }, [
                    createEl('div', { class: 'ch_name' }),
                    createEl('small', { class: 'group_select_counter' }),
                ]),
                createEl('i', { class: 'group_fav_icon' }),
                createEl('input', { class: 'ch_fav' }),
                createEl('div', { class: 'group_select_block_list ch_description' }),
                createEl('div', { class: 'tags tags_inline' }),
            ]),
        ]),
    ]);

    // Manage chats popup DOM
    const chatSearch = createEl('input', { id: 'select_chat_search', type: 'search' });
    const selectChatDiv = createEl('div', { id: 'select_chat_div' });
    const selectChatPopup = createEl('div', { id: 'select_chat_popup' }, [chatSearch, selectChatDiv]);
    const shadowChatPopup = createEl('div', { id: 'shadow_select_chat_popup' }, [selectChatPopup]);
    shadowChatPopup.style.display = 'none';

    const extSettings = createEl('div', { id: 'extensions_settings' });
    const extMenu = createEl('div', { id: 'extensionsMenu' });

    body.append(rmChars, charTpl, groupTpl, shadowChatPopup, extSettings, extMenu);

    doc.getElementById = (id) => doc.querySelector(`#${id}`);
    doc.querySelector = (sel) => body.querySelector(sel);
    doc.querySelectorAll = (sel) => body.querySelectorAll(sel);
    doc.createElement = (tag) => new MiniNode(1, tag);
    doc.createDocumentFragment = () => new MiniNode(11, '#fragment');

    class FakeMutationObserver {
        constructor(cb) {
            this.cb = cb;
        }
        observe(target) {
            target.observers.push(this);
        }
        _trigger() {
            this.cb([]);
        }
    }

    const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3 };
    const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };

    // Queue of scripted modal actions for tests
    const popupQueue = [];
    class FakePopup {
        constructor(content, type, inputValue, options = {}) {
            this.content = content;
            this.type = type;
            this.options = options;
            this.result = null;
            this._resolve = null;
        }
        async complete(result) {
            this.result = result;
            if (this.options.onClosing) {
                const ok = await this.options.onClosing(this);
                if (!ok) return undefined;
            }
            this._resolve?.(result);
            return result;
        }
        async completeAffirmative() {
            return this.complete(POPUP_RESULT.AFFIRMATIVE);
        }
        show() {
            return new Promise((resolve) => {
                this._resolve = resolve;
                const action = popupQueue.shift();
                if (action) {
                    queueMicrotask(() => action(this));
                } else {
                    resolve(POPUP_RESULT.CANCELLED);
                }
            });
        }
    }

    const eventSource = new MiniEventEmitter();
    const eventTypes = {
        APP_READY: 'app_ready',
        EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
        SETTINGS_LOADED_AFTER: 'settings_loaded_after',
        CHARACTER_PAGE_LOADED: 'character_page_loaded',
        CHARACTER_DELETED: 'characterDeleted',
        CHARACTER_RENAMED: 'character_renamed',
        CHARACTER_DUPLICATED: 'character_duplicated',
        CHAT_CHANGED: 'chat_id_changed',
        CHAT_RENAMED: 'chat_renamed',
        CHAT_DELETED: 'chat_deleted',
        GROUP_CHAT_DELETED: 'group_chat_deleted',
    };

    let saveCount = 0;
    const state = {
        characterId: 0,
        groupId: null,
        chatId: 'Alice - Chat 1',
        characters: [
            { avatar: 'alice.png', name: 'Alice', fav: true, data: { creator_notes: 'Heroine' } },
            { avatar: 'bob.png', name: 'Bob', fav: false, data: { creator_notes: 'Companion' } },
        ],
        groups: [
            { id: 'grp_1', name: 'Adventure Party', members: ['alice.png', 'bob.png'] },
        ],
        extensionSettings: {},
        tagMap: {},
        tags: [],
        powerUserSettings: {},
        accountStorage: { getItem: () => '50' },
        getThumbnailUrl: (_type, avatar) => `/thumbnail?file=${avatar}`,
        getCurrentLocale: () => 'zh-cn',
        getCurrentChatId: () => state.chatId,
        saveSettingsDebounced: () => { saveCount++; },
        eventSource,
        eventTypes,
        Popup: FakePopup,
        POPUP_TYPE,
        POPUP_RESULT,
    };

    globalThis.document = doc;
    globalThis.Element = MiniNode;
    globalThis.Node = MiniNode;
    globalThis.HTMLElement = MiniNode;
    globalThis.HTMLInputElement = MiniNode;
    globalThis.HTMLSelectElement = MiniNode;
    globalThis.HTMLButtonElement = MiniNode;
    globalThis.HTMLImageElement = MiniNode;
    globalThis.MutationObserver = FakeMutationObserver;
    globalThis.toastr = { success() {}, info() {}, warning() {}, error() {} };
    globalThis.jQuery = (fn) => {
        if (typeof fn === 'function') fn();
        return { data: () => {} };
    };
    globalThis.SillyTavern = {
        getContext: () => state,
    };

    const renderNativeCharPage = () => {
        listBlock.replaceChildren();
        state.characters.forEach((char, idx) => {
            const card = createEl('div', { class: 'character_select entity_block', 'data-chid': String(idx), id: `CharID${idx}` }, [
                createEl('div', { class: 'avatar' }, [createEl('img', { src: `/thumb/${char.avatar}` })]),
                createEl('div', { class: 'character_select_container' }, [
                    createEl('div', { class: 'character_name_block' }, [createEl('span', { class: 'ch_name', textContent: char.name })]),
                    createEl('div', { class: 'tags tags_inline' }),
                ]),
            ]);
            listBlock.appendChild(card);
        });
        state.groups.forEach((grp) => {
            const card = createEl('div', { class: 'group_select entity_block', 'data-grid': grp.id }, [
                createEl('div', { class: 'avatar' }, [createEl('img')]),
                createEl('div', { class: 'group_select_container' }, [
                    createEl('div', { class: 'group_name_block character_name_block' }, [createEl('div', { class: 'ch_name', textContent: grp.name })]),
                    createEl('div', { class: 'tags tags_inline' }),
                ]),
            ]);
            listBlock.appendChild(card);
        });
        eventSource.emit(eventTypes.CHARACTER_PAGE_LOADED);
    };

    const renderPastChats = (chatFiles) => {
        selectChatDiv.replaceChildren();
        for (const fileName of chatFiles) {
            const wrapper = createEl('div', { class: 'select_chat_block_wrapper' }, [
                createEl('div', { class: 'select_chat_block', file_name: fileName }, [
                    createEl('div', { id: 'select_chat_name_wrapper' }, [
                        createEl('div', {}, [
                            createEl('small', { class: 'select_chat_block_filename', textContent: fileName }),
                            createEl('div', { class: 'renameChatButton' }),
                        ]),
                        createEl('div', {}, [
                            createEl('div', { class: 'select_chat_actions' }, [
                                createEl('div', { class: 'exportRawChatButton' }),
                                createEl('div', { class: 'exportChatButton' }),
                                createEl('div', { class: 'PastChat_cross', file_name: fileName }),
                            ]),
                        ]),
                    ]),
                    createEl('div', { class: 'select_chat_block_mes', textContent: 'Preview...' }),
                ]),
            ]);
            selectChatDiv.appendChild(wrapper);
        }
        shadowChatPopup.style.display = 'block';
    };

    return {
        doc,
        state,
        popupQueue,
        listBlock,
        selectChatDiv,
        shadowChatPopup,
        renderNativeCharPage,
        renderPastChats,
        getSaveCount: () => saveCount,
    };
}

test('full DOM workflow: character folders and chat folders end-to-end', async () => {
    const env = setupEnvironment();
    await import('../index.js');

    // Verify toolbars & settings panel mounted
    assert.ok(env.doc.getElementById('stf_char_toolbar'));
    assert.ok(env.doc.getElementById('stf_chat_toolbar'));
    assert.ok(env.doc.getElementById('stf_settings_drawer'));
    assert.ok(env.doc.getElementById('stf_wand_move_chat'));

    // 1. Render initial character list
    env.renderNativeCharPage();
    assert.equal(env.listBlock.querySelectorAll('.character_select').length, 2);
    assert.equal(env.listBlock.querySelectorAll('.group_select').length, 1);

    // Move Alice into a newly created folder via quick-create inside the picker popup
    const aliceCard = env.doc.getElementById('CharID0');
    const moveBtn = aliceCard.querySelector('.stf-char-move-btn');
    assert.ok(moveBtn);

    env.popupQueue.push((popup) => {
        const quickInput = popup.content.querySelector('.stf-quick-create input');
        const quickBtn = popup.content.querySelector('.stf-quick-create button');
        quickInput.value = '我的最爱';
        quickBtn.click();
    });

    await moveBtn.click();
    // Wait for async popup promise settlement
    await new Promise(r => setTimeout(r, 20));

    // In root with hideFolderedCharsInRoot=true, 1 folder card should appear and Alice should be hidden from root
    const folderCards = env.listBlock.querySelectorAll('.stf-folder-card');
    assert.equal(folderCards.length, 1);
    assert.equal(folderCards[0].querySelector('.stf-folder-name').textContent, '我的最爱');
    assert.equal(aliceCard.style.display, 'none');

    // Click folder card -> drills into folder and shows Alice
    folderCards[0].click();
    const visibleAlice = env.listBlock.querySelectorAll('.character_select');
    assert.equal(visibleAlice.length, 1);
    assert.equal(visibleAlice[0].querySelector('.ch_name').textContent, 'Alice');

    // Navigate back to root via breadcrumb
    const rootCrumb = env.doc.getElementById('stf_char_toolbar').querySelector('.stf-crumb');
    rootCrumb.click();
    assert.equal(env.listBlock.querySelectorAll('.stf-folder-card').length, 1);

    // 2. Test character rename migration
    env.state.eventSource.emit(env.state.eventTypes.CHARACTER_RENAMED, 'alice.png', 'alice_new.png');
    assert.ok('char:alice_new.png' in env.state.extensionSettings.st_folders.charAssignments);
    assert.equal('char:alice.png' in env.state.extensionSettings.st_folders.charAssignments, false);

    // 3. Test Chat Folders inside Manage Chat Files
    env.state.characters[0].avatar = 'alice_new.png';
    env.renderPastChats(['Alice - Chat 1', 'Alice - Chat 2']);
    await new Promise(r => setTimeout(r, 20));

    const chatWrappers = env.selectChatDiv.querySelectorAll(':scope > .select_chat_block_wrapper');
    assert.equal(chatWrappers.length, 2);
    // Ensure .select_chat_block_filename text was NOT polluted by any badge or icon
    assert.equal(chatWrappers[0].querySelector('.select_chat_block_filename').textContent, 'Alice - Chat 1');

    // Move Chat 1 into a new chat folder via its move button
    const chatMoveBtn = chatWrappers[0].querySelector('.stf-chat-move-btn');
    assert.ok(chatMoveBtn);

    env.popupQueue.push((popup) => {
        const quickInput = popup.content.querySelector('.stf-quick-create input');
        const quickBtn = popup.content.querySelector('.stf-quick-create button');
        quickInput.value = '主线剧情';
        quickBtn.click();
    });

    await chatMoveBtn.click();
    await new Promise(r => setTimeout(r, 20));

    const chatFolders = env.selectChatDiv.querySelectorAll('.stf-folder-card-chat');
    assert.equal(chatFolders.length, 1);
    assert.equal(chatFolders[0].querySelector('.stf-folder-name').textContent, '主线剧情');
    assert.equal(chatWrappers[0].style.display, 'none');
    assert.notEqual(chatWrappers[1].style.display, 'none');

    // Click into chat folder -> shows Chat 1
    chatFolders[0].click();
    assert.equal(chatWrappers[0].style.display, '');
    assert.equal(chatWrappers[1].style.display, 'none');
    // Filename text still pure for native renameChatButton/exportChatButton
    assert.equal(chatWrappers[0].querySelector('.select_chat_block_filename').textContent, 'Alice - Chat 1');

    // Test CHAT_RENAMED event strips .jsonl and preserves assignment inside folder
    env.state.eventSource.emit(env.state.eventTypes.CHAT_RENAMED, {
        avatarId: 'alice_new.png',
        groupId: null,
        oldFileName: 'Alice - Chat 1.jsonl',
        newFileName: 'Alice - Epilogue.jsonl',
    });
    const chatAssign = env.state.extensionSettings.st_folders.chatAssignmentsByScope['char:alice_new.png'];
    assert.ok(chatAssign['Alice - Epilogue']);
    assert.equal(chatAssign['Alice - Chat 1'], undefined);

    assert.ok(env.getSaveCount() > 0);

    // 4. Test batch selection mode in character list (intercepts card clicks and moves multiple items)
    const charBatchBtn = env.doc.getElementById('stf_char_toolbar').querySelectorAll('.stf-toolbar-btn')[1];
    charBatchBtn.click(); // Enter batch mode
    const bobCard = env.doc.getElementById('CharID1');
    const grpCard = env.listBlock.querySelector('.group_select');
    assert.ok(bobCard && grpCard);

    let nativeCardClickLeaked = false;
    env.doc.addEventListener('click', (e) => {
        if (e.target.closest?.('.character_select, .group_select') && !e.target.closest?.('.stf-char-move-btn')) {
            nativeCardClickLeaked = true;
        }
    });

    bobCard.click();
    grpCard.click();
    assert.equal(nativeCardClickLeaked, false);
    assert.equal(bobCard.classList.contains('stf-batch-selected'), true);
    assert.equal(grpCard.classList.contains('stf-batch-selected'), true);

    const existingCharFolderId = env.state.extensionSettings.st_folders.charFolders[0].id;
    env.popupQueue.push((popup) => {
        const folderBtns = popup.content.querySelectorAll('.stf-picker-item:not(.stf-picker-root)');
        folderBtns[0].click();
    });
    const batchMoveBtn = env.doc.getElementById('stf_char_toolbar').querySelector('.stf-batch-move');
    await batchMoveBtn.click();
    await new Promise(r => setTimeout(r, 20));

    assert.equal(env.state.extensionSettings.st_folders.charAssignments['char:bob.png'], existingCharFolderId);
    assert.equal(env.state.extensionSettings.st_folders.charAssignments['group:grp_1'], existingCharFolderId);

    // 5. Test drag & drop from inside folder onto root breadcrumb
    env.listBlock.querySelector('.stf-folder-card').click();
    const bobInFolder = env.listBlock.querySelectorAll('.character_select')[1];
    assert.ok(bobInFolder);
    const dragStartEvt = createDomEvent('dragstart', bobInFolder);
    dragStartEvt.dataTransfer = { effectAllowed: '', setData() {} };
    bobInFolder.dispatchEvent(dragStartEvt);

    const dropEvt = createDomEvent('drop', rootCrumb);
    rootCrumb.dispatchEvent(dropEvt);
    assert.equal('char:bob.png' in env.state.extensionSettings.st_folders.charAssignments, false);

    // 6. Test deleting folder returns remaining items safely back to root
    env.doc.getElementById('stf_char_toolbar').querySelector('.stf-crumb').click();
    const folderToDelete = env.listBlock.querySelector('.stf-folder-card');
    env.popupQueue.push((popup) => popup.completeAffirmative());
    await folderToDelete.querySelector('.stf-icon-btn-danger').click();
    await new Promise(r => setTimeout(r, 20));

    assert.equal(env.state.extensionSettings.st_folders.charFolders.length, 0);
    assert.equal(Object.keys(env.state.extensionSettings.st_folders.charAssignments).length, 0);
    // All 3 native entities (Alice, Bob, Adventure Party) are visible again in root
    const visibleCardsAfterDel = env.listBlock.querySelectorAll('.character_select, .group_select')
        .filter(el => el.style.display !== 'none');
    assert.equal(visibleCardsAfterDel.length, 3);

    // 7. Test disabling and re-enabling via settings checkbox
    const enabledCheck = env.doc.getElementById('stf_opt_enabled');
    enabledCheck.checked = false;
    enabledCheck.dispatchEvent(createDomEvent('change', enabledCheck));
    assert.equal(env.doc.getElementById('stf_char_toolbar').style.display, 'none');
    assert.equal(env.listBlock.querySelectorAll('.stf-char-move-btn').length, 0);

    enabledCheck.checked = true;
    enabledCheck.dispatchEvent(createDomEvent('change', enabledCheck));
    assert.notEqual(env.doc.getElementById('stf_char_toolbar').style.display, 'none');
    assert.equal(env.listBlock.querySelectorAll('.stf-char-move-btn').length, 3);

    // 8. Test group chat scope isolation
    env.state.groupId = 'grp_1';
    env.state.chatId = 'Group Chat 1';
    env.state.eventSource.emit(env.state.eventTypes.CHAT_CHANGED);
    env.renderPastChats(['Group Chat 1', 'Group Chat 2']);
    await new Promise(r => setTimeout(r, 20));
    const grpChatFolders = env.selectChatDiv.querySelectorAll('.stf-folder-card-chat');
    assert.equal(grpChatFolders.length, 0); // Isolated from Alice's chat folders!

    // 9. Test multi-page character list (Characters_PerPage = 2 with 3 entities)
    env.state.accountStorage.getItem = () => '2';
    env.renderNativeCharPage();
    const pager = env.doc.getElementById('stf_char_toolbar').querySelector('.stf-pager');
    assert.equal(pager.style.display, 'flex');
    assert.equal(env.listBlock.querySelectorAll('.character_select, .group_select').length, 2);
    pager.querySelector('.stf-pager-next').click();
    assert.equal(env.listBlock.querySelectorAll('.character_select, .group_select').length, 1);
});
