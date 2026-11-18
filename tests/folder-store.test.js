import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assignItemsToFolder,
    computeFolderStats,
    createFolder,
    deleteFolder,
    deleteRecentAssignmentsByScope,
    ensureChatScope,
    flattenFolderTree,
    getBreadcrumbs,
    getChatScopeKey,
    getDescendantIds,
    getFolderPathLabel,
    makeCharKey,
    makeGroupKey,
    makeRecentChatKey,
    migrateAssignmentKey,
    migrateRecentAssignmentsByScope,
    normalizeSettings,
    parseImportedConfig,
    parseRecentChatKey,
    pruneAssignments,
    sortCharacterEntities,
    stripJsonlExt,
    updateFolder,
    wouldCreateCycle,
} from '../src/folder-store.js';

test('normalizeSettings handles empty, invalid, cyclic, and .jsonl assignments safely', () => {
    const normalized = normalizeSettings({
        enabled: false,
        language: 'zh',
        hideFolderedCharsInRoot: false,
        charFolders: [
            { id: 'a', name: 'Folder A', parentId: 'b', color: '#4f86f7' },
            { id: 'b', name: 'Folder B', parentId: 'a', color: '' },
            { id: 'c', name: 'Dangling', parentId: 'missing' },
            { id: '', name: 'Invalid' },
        ],
        charAssignments: {
            'char:alice.png': 'a',
            'char:ghost.png': 'nonexistent',
        },
        chatFoldersByScope: {
            'char:alice.png': [{ id: 'cf1', name: 'Main Story', parentId: null }],
        },
        chatAssignmentsByScope: {
            'char:alice.png': {
                'Alice - 2026.jsonl': 'cf1',
                'bad': 'missing_folder',
            },
        },
    });

    assert.equal(normalized.enabled, false);
    assert.equal(normalized.language, 'zh');
    assert.equal(normalized.hideFolderedCharsInRoot, false);
    assert.equal(normalized.charFolders.length, 3);
    // Cycle between a and b should be broken without throwing
    const bFolder = normalized.charFolders.find(f => f.id === 'b');
    const aFolder = normalized.charFolders.find(f => f.id === 'a');
    assert.ok(aFolder.parentId === null || bFolder.parentId === null);
    assert.equal(normalized.charFolders.find(f => f.id === 'c').parentId, null);

    assert.deepEqual(normalized.charAssignments, { 'char:alice.png': 'a' });
    assert.deepEqual(normalized.chatAssignmentsByScope['char:alice.png'], {
        'Alice - 2026': 'cf1',
    });
});

test('folder CRUD, nesting, cycle prevention, and safe deletion', () => {
    const folders = [];
    const assignments = {};
    let seq = 1;
    const uuidFn = () => `id_${seq++}`;

    const root = createFolder(folders, { name: 'RPG', color: '#4f86f7', uuidFn });
    const sub = createFolder(folders, { name: 'Fantasy', parentId: root.id, uuidFn });
    const deep = createFolder(folders, { name: 'Dark Fantasy', parentId: sub.id, uuidFn });

    assert.equal(folders.length, 3);
    assert.equal(getFolderPathLabel(folders, deep.id), 'RPG / Fantasy / Dark Fantasy');
    assert.deepEqual(getBreadcrumbs(folders, deep.id).map(b => b.id), [root.id, sub.id, deep.id]);
    assert.deepEqual([...getDescendantIds(folders, root.id)], [root.id, sub.id, deep.id]);

    assert.equal(wouldCreateCycle(folders, root.id, deep.id), true);
    assert.equal(wouldCreateCycle(folders, deep.id, root.id), false);
    assert.throws(() => updateFolder(folders, root.id, { parentId: deep.id }));

    assignItemsToFolder(folders, assignments, ['char:a.png', 'char:b.png'], sub.id);
    assignItemsToFolder(folders, assignments, ['char:c.png'], deep.id);

    const tree = flattenFolderTree(folders);
    assert.deepEqual(tree.map(n => [n.folder.name, n.depth]), [
        ['RPG', 0],
        ['Fantasy', 1],
        ['Dark Fantasy', 2],
    ]);

    const stats = computeFolderStats(folders, assignments, new Set(['char:a.png', 'char:b.png', 'char:c.png']));
    assert.equal(stats.get(root.id).directItems, 0);
    assert.equal(stats.get(root.id).totalItems, 3);
    assert.equal(stats.get(root.id).directSubfolders, 1);
    assert.equal(stats.get(sub.id).directItems, 2);
    assert.equal(stats.get(sub.id).totalItems, 3);

    // Deleting `sub` promotes `deep` and `char:a.png`, `char:b.png` up to `root` without losing anything
    assert.equal(deleteFolder(folders, assignments, sub.id), true);
    assert.equal(deep.parentId, root.id);
    assert.equal(assignments['char:a.png'], root.id);
    assert.equal(assignments['char:b.png'], root.id);
    assert.equal(assignments['char:c.png'], deep.id);

    // Deleting `root` moves `char:a.png` and `char:b.png` back to root (unassigned) and `deep` to root level
    assert.equal(deleteFolder(folders, assignments, root.id), true);
    assert.equal(deep.parentId, null);
    assert.equal('char:a.png' in assignments, false);
    assert.equal('char:b.png' in assignments, false);
    assert.equal(assignments['char:c.png'], deep.id);
});

test('chat scope, jsonl stripping, migration, pruning, and import validation', () => {
    assert.equal(stripJsonlExt('My Chat.jsonl'), 'My Chat');
    assert.equal(stripJsonlExt('My Chat'), 'My Chat');

    assert.equal(
        getChatScopeKey({ groupId: 'grp1', characterId: 0, characters: [{ avatar: 'a.png' }] }),
        makeGroupKey('grp1'),
    );
    assert.equal(
        getChatScopeKey({ groupId: null, characterId: 0, characters: [{ avatar: 'alice.png' }] }),
        makeCharKey('alice.png'),
    );
    assert.equal(getChatScopeKey({ groupId: null, characterId: undefined, characters: [] }), null);

    const settings = normalizeSettings({});
    const scope = ensureChatScope(settings, 'char:alice.png');
    const fld = createFolder(scope.folders, { name: 'Mainline', uuidFn: () => '1' });
    assignItemsToFolder(scope.folders, scope.assignments, ['Chat 1', 'Chat 2'], fld.id);

    assert.equal(migrateAssignmentKey(scope.assignments, 'Chat 1', 'Chat 1 Renamed'), true);
    assert.equal(scope.assignments['Chat 1'], undefined);
    assert.equal(scope.assignments['Chat 1 Renamed'], fld.id);

    const pruned = pruneAssignments(scope.folders, scope.assignments, new Set(['Chat 1 Renamed']));
    assert.equal(pruned, 1);
    assert.deepEqual(scope.assignments, { 'Chat 1 Renamed': fld.id });

    assert.equal(parseImportedConfig({ foo: 'bar' }), null);
    const imported = parseImportedConfig({
        charFolders: [{ id: 'f1', name: 'Favs', parentId: null }],
        charAssignments: { 'char:bob.png': 'f1' },
    });
    assert.ok(imported);
    assert.equal(imported.charFolders[0].name, 'Favs');
    assert.equal(imported.charAssignments['char:bob.png'], 'f1');
});

test('sortCharacterEntities respects SillyTavern sorting fields and directions', () => {
    const entities = [
        { type: 'character', item: { name: 'Zara', create_date: 100, fav: false, chat_size: 2 } },
        { type: 'character', item: { name: 'Alice', create_date: 300, fav: true, chat_size: 10 } },
        { type: 'group', item: { name: 'Party', create_date: 200, fav: false, chat_size: 5 } },
    ];

    assert.deepEqual(
        sortCharacterEntities(entities, 'name', 'asc').map(e => e.item.name),
        ['Alice', 'Party', 'Zara'],
    );
    assert.deepEqual(
        sortCharacterEntities(entities, 'name', 'desc').map(e => e.item.name),
        ['Zara', 'Party', 'Alice'],
    );
    assert.deepEqual(
        sortCharacterEntities(entities, 'create_date', 'desc').map(e => e.item.name),
        ['Alice', 'Party', 'Zara'],
    );
    assert.deepEqual(
        sortCharacterEntities(entities, 'fav', 'desc').map(e => e.item.name),
        ['Alice', 'Party', 'Zara'],
    );
    assert.deepEqual(
        sortCharacterEntities(entities, 'chat_size', 'asc').map(e => e.item.name),
        ['Zara', 'Party', 'Alice'],
    );
});

test('recent chat composite keys, normalization, scope migration, and deletion', () => {
    const kChar = makeRecentChatKey('char:alice.png', 'Main Story.jsonl');
    const kGrp = makeRecentChatKey('group:grp_1', 'Party Chat');
    assert.equal(kChar, 'char:alice.png::Main Story');
    assert.equal(kGrp, 'group:grp_1::Party Chat');
    assert.deepEqual(parseRecentChatKey(kChar), { scopeKey: 'char:alice.png', chatKey: 'Main Story' });
    assert.equal(parseRecentChatKey('invalid-key'), null);

    const normalized = normalizeSettings({
        recentFolders: [
            { id: 'rf1', name: 'Mainline', parentId: null, color: '#4f86f7' },
        ],
        recentAssignments: {
            'char:alice.png::Chapter 1.jsonl': 'rf1',
            'group:grp_1::BadChat': 'missing_folder',
            'badformat': 'rf1',
        },
    });
    assert.equal(normalized.recentFolders.length, 1);
    assert.deepEqual(normalized.recentAssignments, {
        'char:alice.png::Chapter 1': 'rf1',
    });

    assert.equal(
        migrateRecentAssignmentsByScope(normalized.recentAssignments, 'char:alice.png', 'char:alice_v2.png'),
        true,
    );
    assert.deepEqual(normalized.recentAssignments, {
        'char:alice_v2.png::Chapter 1': 'rf1',
    });

    assert.equal(deleteRecentAssignmentsByScope(normalized.recentAssignments, 'char:alice_v2.png'), true);
    assert.deepEqual(normalized.recentAssignments, {});

    const imported = parseImportedConfig({
        recentFolders: [{ id: 'rf2', name: 'Archived', parentId: null }],
        recentAssignments: { 'char:bob.png::Old Chat.jsonl': 'rf2' },
    });
    assert.ok(imported);
    assert.equal(imported.recentAssignments['char:bob.png::Old Chat'], 'rf2');
});
