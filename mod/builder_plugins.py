#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The plugin catalogue behind the HMI's Add screen.

The device browses by category and picks by position, never by URI: a URI is sixty
characters of no use to a 128 pixel panel, and the lists it sees are built here anyway.
Both sides therefore have to agree on the ordering, so every listing is sorted the same
deterministic way and rebuilt from scratch rather than remembered.

The catalogue is cached: reading a plugin's ports is what tells audio from MIDI from CV,
and doing that for every installed plugin is a one-off cost worth paying once.
"""

import json
import os
import re

from mod.settings import FAVORITES_JSON_FILE
from mod.minimap import sanitize_label

# One column of the Add screen, in pixels: the panel is 128 wide and holds two of them,
# and a label longer than its column would be drawn straight over the other one.
COLUMN_W = 56

# The info overlay has the panel to itself, less a margin either side. The description now
# has the whole body and scrolls, so the cap is the device's own 400 character buffer
# rather than one screenful -- anything past that is parsed and then never drawn.
INFO_W = 120
INFO_WORDS = 70

# The two entries that are not an LV2 category. Sorted ahead of the rest by the ranks below.
CATEGORY_FAVORITES = 'Favorites'
CATEGORY_ALL = 'All'

_CATEGORY_RANK = {CATEGORY_FAVORITES: 0, CATEGORY_ALL: 1}

_catalog_provider = None
_info_provider = None

_cache = None


def set_catalog_provider(fn):
    """Override the LV2 index. Used by tests to run without the .so."""
    global _catalog_provider, _cache
    _catalog_provider = fn
    _cache = None


def set_info_provider(fn):
    """Override the per-plugin port lookup, for the same reason."""
    global _info_provider, _cache
    _info_provider = fn
    _cache = None


def _all_plugins():
    global _catalog_provider
    if _catalog_provider is None:
        from modtools.utils import get_all_plugins
        _catalog_provider = get_all_plugins
    return _catalog_provider()


def _plugin_info(uri):
    global _info_provider
    if _info_provider is None:
        from modtools.utils import get_plugin_info
        _info_provider = get_plugin_info
    return _info_provider(uri)


def _favorites():
    try:
        with open(FAVORITES_JSON_FILE, 'r') as fh:
            return set(json.load(fh))
    except Exception:
        return set()


def _type_bits(uri):
    """Which signal types a plugin deals in, from its ports.

    iotype in the index would be cheaper but only knows mono, stereo, instrument and
    MIDI -- there is no CV in it, and a CV filter that never matches anything is worse
    than the lookup this costs. get_plugin_info is cached on the C side, so the price
    is paid once per plugin and never again.
    """
    bits = 0
    try:
        ports = _plugin_info(uri)['ports']
    except Exception:
        return 0

    for group, bit in (('audio', 1), ('midi', 2), ('cv', 4)):
        block = ports.get(group) or {}
        if (block.get('input') or block.get('output')):
            bits |= bit

    return bits


def _build():
    """uri -> name, categories, type bits, for everything installed."""
    out = []
    for plugin in _all_plugins():
        uri = plugin.get('uri')
        if not uri:
            continue

        name = plugin.get('label') or plugin.get('name') or uri

        # The index hands back a hierarchy, not a set: the top level first and the LV2
        # sub-class after it, so a lowpass filter arrives as ('Filter', 'Lowpass') and a
        # compressor as ('Dynamics', 'Compressor'). The browser files a plugin under the
        # first of those and nothing else, and this list has to say what the browser says
        # -- taking the whole hierarchy invents a dozen categories the user has never seen
        # and counts every filter twice, once under its class and once under its family.
        categories = [c for c in (plugin.get('category') or []) if c][:1]

        out.append({
            'uri': uri,
            'name': name,
            'categories': categories,
            'bits': _type_bits(uri),
        })

    # a total order, so an index means the same entry on both sides of the wire
    out.sort(key=lambda p: (p['name'].upper(), p['uri']))
    return out


def catalog():
    global _cache
    if _cache is None:
        _cache = _build()
    return _cache


def invalidate():
    """Forget the catalogue; call when bundles are installed or removed."""
    global _cache
    _cache = None


def _matches(plugin, bits):
    if not bits:
        return True
    return bool(plugin['bits'] & bits)


def categories(bits=0):
    """The categories worth showing, with how many plugins each holds.

    An empty category is left out: there is nothing behind it to pick, and the panel
    has few enough rows without them.
    """
    favorites = _favorites()

    counts = {}
    for plugin in catalog():
        if not _matches(plugin, bits):
            continue

        counts[CATEGORY_ALL] = counts.get(CATEGORY_ALL, 0) + 1
        if plugin['uri'] in favorites:
            counts[CATEGORY_FAVORITES] = counts.get(CATEGORY_FAVORITES, 0) + 1

        for name in plugin['categories']:
            counts[name] = counts.get(name, 0) + 1

    names = sorted(counts, key=lambda n: (_CATEGORY_RANK.get(n, 2), n.upper()))

    return [{'index': index, 'name': name, 'count': counts[name],
             'label': sanitize_label(name, COLUMN_W)}
            for index, name in enumerate(names)]


def plugins(category_index, bits=0):
    """The plugins of one category, in the order the device will show them."""
    listed = categories(bits)
    if category_index < 0 or category_index >= len(listed):
        return []

    name = listed[category_index]['name']
    favorites = _favorites() if name == CATEGORY_FAVORITES else None

    out = []
    for plugin in catalog():
        if not _matches(plugin, bits):
            continue
        if name == CATEGORY_ALL:
            pass
        elif name == CATEGORY_FAVORITES:
            if plugin['uri'] not in favorites:
                continue
        elif name not in plugin['categories']:
            continue

        out.append({'index': len(out), 'uri': plugin['uri'], 'name': plugin['name'],
                    'bits': plugin['bits'],
                    'label': sanitize_label(plugin['name'], COLUMN_W)})

    return out


def window(category_index, bits=0, first=0, count=48):
    """A slice of a category, for a panel that holds a few dozen rows at a time.

    Returns the whole length as well, so the device knows there is more and can slide
    the window as the user scrolls rather than stopping at the first screenful.
    """
    listed = plugins(category_index, bits)
    total = len(listed)

    if first < 0:
        first = 0
    if first > total:
        first = total

    return (total, first, listed[first:first + count])


def initials(category_index, bits=0):
    """The distinct first letters of a category, and where each one starts.

    For scrubbing: holding the encoder down turns a list of hundreds into a list of
    twenty-odd, and letting go lands on the first plugin of the letter. The index is
    absolute, the same one CMD_DWARF_BUILDER_CATALOG hands out.
    """
    out = []
    seen = set()

    for plugin in plugins(category_index, bits):
        label = plugin['label'] or '?'
        letter = label[0].upper()

        if letter in seen:
            continue

        seen.add(letter)
        out.append({'letter': letter, 'index': plugin['index']})

    return out


def details(category_index, plugin_index, bits=0):
    """Everything the Add screen's info overlay shows about one plugin.

    Addressed by the same two positions as the pick itself, so the overlay is about the
    row under the cursor without the device ever having to name it.
    """
    chosen = plugin_at(category_index, plugin_index, bits)
    if chosen is None:
        return None

    try:
        info = _plugin_info(chosen['uri'])
    except Exception:
        info = {}

    ports = info.get('ports') or {}

    def count(group, side):
        return len((ports.get(group) or {}).get(side) or [])

    # the head of the hierarchy, the same one the category list files it under
    category = ([c for c in (info.get('category') or []) if c] or ['-'])[0]

    # One word per token: a word never holds a space, so the description crosses the
    # space-delimited protocol without any escaping and the device wraps it to the panel.
    words = []
    for word in (info.get('comment') or '').split():
        words.append(sanitize_label(word, INFO_W))
        if len(words) >= INFO_WORDS:
            break

    return {
        'name': sanitize_label(chosen['name'], INFO_W),
        'brand': sanitize_label(info.get('brand') or '-', INFO_W),
        'category': sanitize_label(category, INFO_W),
        'audio': (count('audio', 'input'), count('audio', 'output')),
        'midi': (count('midi', 'input'), count('midi', 'output')),
        'cv': (count('cv', 'input'), count('cv', 'output')),
        'comment': words,
    }


def audio_ports(uri):
    """A plugin's audio ports by symbol, in the order it declares them.

    The order is what pairs a stereo splice up L to L: nothing else in the port data says
    which side is which, and the declaration order is what every host uses for it.
    """
    try:
        block = _plugin_info(uri)['ports']['audio']
    except Exception:
        return ([], [])

    return ([port['symbol'] for port in (block.get('input') or [])],
            [port['symbol'] for port in (block.get('output') or [])])


def plugin_at(category_index, plugin_index, bits=0):
    """The plugin the device means by two positions, or None."""
    listed = plugins(category_index, bits)
    if plugin_index < 0 or plugin_index >= len(listed):
        return None
    return listed[plugin_index]


def instance_name(host, name):
    """A free '/graph/...' name for a new instance, built from the plugin's own.

    Numbered from two, the way the web UI names a second copy, and only when the plain
    name is taken.
    """
    stem = re.sub(r'[^a-zA-Z0-9_]+', '_', name).strip('_').lower() or 'plugin'

    taken = set()
    for _instance_id, data in getattr(host, 'plugins', {}).items():
        instance = data.get('instance')
        if instance:
            taken.add(instance)

    candidate = '/graph/' + stem
    if candidate not in taken:
        return candidate

    index = 2
    while ('/graph/%s_%d' % (stem, index)) in taken:
        index += 1
    return '/graph/%s_%d' % (stem, index)
