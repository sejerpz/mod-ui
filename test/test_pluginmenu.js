// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Run with: node test/test_pluginmenu.js
//
// The plugin right-click menu takes items from plugin code (add_plugin_menu_items), so
// what matters is that nothing a provider does can break the menu, and that groups come
// out separated and in order.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// html/js/utils/*.js are plain globals, no module system
eval(fs.readFileSync(path.join(__dirname, '..', 'html', 'js', 'utils', 'pluginmenu.js'), 'utf8'))

const noop = function () {}
console.log = noop   // the collector logs provider failures; keep the test output clean

// --- collecting from a provider -----------------------------------------------
{
    let seen = null
    const items = pluginMenuCollect(function (target) {
        seen = target
        return [{ label: ' Send to mixer ', action: noop }, { label: 'Tap', action: noop, key: 't' }]
    }, { instance: '/graph/sitar' })
    assert.deepEqual(seen, { instance: '/graph/sitar' })
    assert.deepEqual(items.map(i => i.label), ['Send to mixer', 'Tap'])
    assert.equal(items[0].key, '')
    assert.equal(items[1].key, 't')
}

// a provider with nothing to say for this target
assert.deepEqual(pluginMenuCollect(() => [], {}), [])
assert.deepEqual(pluginMenuCollect(() => undefined, {}), [])
assert.deepEqual(pluginMenuCollect(() => 'nope', {}), [])

// a throwing provider costs only its own items
assert.deepEqual(pluginMenuCollect(() => { throw new Error('boom') }, {}), [])

// malformed items are dropped, good ones kept
{
    const items = pluginMenuCollect(() => [
        null, 42, {}, { label: 'no action' }, { action: noop }, { label: '   ', action: noop },
        { label: 'ok', action: noop }, { label: 'bad key', action: noop, key: 5 },
    ], {})
    assert.deepEqual(items.map(i => i.label), ['ok', 'bad key'])
    assert.equal(items[1].key, '')
}

// --- assembling groups ----------------------------------------------------------
{
    const a = { label: 'Settings', action: noop }
    const b = { label: 'Send to mixer', action: noop }
    const c = { label: 'Remove', action: noop }
    assert.deepEqual(pluginMenuAssemble([[a], [b], [c]]), [a, { separator: true }, b, { separator: true }, c])
    // empty or missing groups leave no separators behind
    assert.deepEqual(pluginMenuAssemble([[a], [], null, [c]]), [a, { separator: true }, c])
    assert.deepEqual(pluginMenuAssemble([[], [b]]), [b])
    assert.deepEqual(pluginMenuAssemble([]), [])
}

process.stdout.write('pluginmenu: all assertions passed\n')
