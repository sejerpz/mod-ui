// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// The right-click menu of a plugin on the pedalboard, kept apart from the drawing so it
// is testable without a DOM. The menu is built from groups of items -- mod-ui's own and
// whatever plugins add through the modgui function add_plugin_menu_items -- and an item
// is { label: string, action: function, key: optional shortcut shown on the right }.

// Calls one plugin's provider for a target plugin and keeps only well-formed items. A
// provider is plugin code, so nothing it returns is trusted: a throw, a non-array or a
// malformed item costs that provider its own items, never the menu.
function pluginMenuCollect(provider, target) {
    var items
    try {
        items = provider(target)
    } catch (e) {
        if (typeof console !== 'undefined') {
            console.log('plugin menu provider failed:', e)
        }
        return []
    }
    if (! Array.isArray(items)) {
        return []
    }
    return items.filter(function (it) {
        return it && typeof it.label === 'string' && it.label.trim() !== '' &&
               typeof it.action === 'function'
    }).map(function (it) {
        return { label: it.label.trim(), action: it.action, key: typeof it.key === 'string' ? it.key : '' }
    })
}

// Flattens groups into one list with a separator between non-empty groups. Empty groups
// leave no trace, so a group can always be offered and simply come back empty.
function pluginMenuAssemble(groups) {
    var out = []
    for (var g = 0; g < groups.length; g++) {
        var group = groups[g] || []
        if (! group.length) {
            continue
        }
        if (out.length) {
            out.push({ separator: true })
        }
        out = out.concat(group)
    }
    return out
}
