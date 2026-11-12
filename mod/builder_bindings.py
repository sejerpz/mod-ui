#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Parameter-to-actuator bindings, for the HMI's binding manager.

Three lists and two verbs: what the selected plugin has to offer, which page of the board,
and which actuator on that page -- then bind, or take one off. Everything is addressed by
position the way the Add screen is: the device carries no port symbols and no actuator
URIs, only the index of the row it was shown.

Nothing here acts. The lookups are here and the two verbs are in mod/host.py, where the
callbacks live, which is the same split plugin_map.py and its handlers already use.
"""

import logging

from mod.settings import PLUGIN_MAP_HMI_SUBPAGES
from mod.plugin_map import sanitize_label

# The two columns, in pixels: what to bind on the left, what to bind it to on the right.
PARAM_W = 56
ACTUATOR_W = 56

# A knob is three actuators, not one: the panel turns its knobs over in sub-pages, and an
# addressing carries the sub-page it was made on alongside its page. So the list has each
# knob three times over -- knobs 1 to 3 of sub-page I, then of II, then of III -- and the
# footswitches once each, since those do not turn over. `I`, `II`, `III` on the label is
# what tells the three apart on the panel.
SUBPAGE_MARKS = ('I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII')

# what a plugin offers before its own ports: the bypass switch every plugin has
BYPASS_SYMBOL = ':bypass'
# ... and, when it has any, its presets, picked one at a time like an enumeration
PRESETS_SYMBOL = ':presets'

# Ports the host drives itself, whatever the plugin says: lv2:enabled is what :bypass
# turns, and the transport ones follow the board's clock. None of them is a parameter.
HIDDEN_DESIGNATIONS = (
    "http://lv2plug.in/ns/lv2core#enabled",
    "http://lv2plug.in/ns/lv2core#freeWheeling",
    "http://lv2plug.in/ns/ext/time#beatsPerBar",
    "http://lv2plug.in/ns/ext/time#beatsPerMinute",
    "http://lv2plug.in/ns/ext/time#speed",
)

_info_provider = None


def set_info_provider(fn):
    """Override the per-plugin port lookup. Used by tests to run without the .so."""
    global _info_provider
    _info_provider = fn


def _plugin_info(uri):
    global _info_provider
    if _info_provider is None:
        from modtools.utils import get_plugin_info_essentials
        _info_provider = get_plugin_info_essentials
    return _info_provider(uri)


def pages(host):
    """How many pages of addressings the board has, one-based on the device."""
    count = getattr(getattr(host, 'addressings', None), 'addressing_pages', 0) or 0

    return max(1, int(count))


def subpages(host):
    """How many times over the panel's knobs come round, or one where they do not."""
    if not getattr(getattr(host, 'addressings', None), 'has_hmi_subpages', False):
        return 1

    return max(1, min(PLUGIN_MAP_HMI_SUBPAGES, len(SUBPAGE_MARKS)))


def actuators(host):
    """Every slot on the panel, in the order the device shows them.

    Only the panel's own: Control Chain and CV arrive through the same list and are not
    something the device can put a finger on. Nothing here reads a URI to decide what
    something is -- anything that takes several actuators at once is a group whatever it is
    called -- and inside each kind the URI is what puts knob1 before knob2 and footswitch B
    before footswitch C.

    The knobs are listed once per sub-page, sub-page by sub-page, because that is what they
    are: three knobs turning over three times is nine places to put a parameter, and an
    addressing carries which one it was made on. The footswitches do not turn over, so they
    come once each at the end.
    """
    knobs, switches, groups = [], [], []

    try:
        found = host.addressings.get_actuators()
    except Exception:
        logging.exception("[bindings] cannot read the actuator list")
        return []

    for meta in found:
        uri = meta.get('uri') or ''

        if not uri.startswith('/hmi/'):
            continue

        if meta.get('actuator_group'):
            groups.append(meta)
        # the Duo X's potentiometers are knobs too, after its two endless ones
        elif 'knob' in uri or 'potentiometer' in uri:
            knobs.append(meta)
        elif 'footswitch' in uri:
            switches.append(meta)

    for pool in (knobs, switches, groups):
        pool.sort(key=lambda m: m.get('uri') or '')

    over = subpages(host)
    marked = over > 1
    listed = []

    def entry(meta, subpage, mark):
        name = meta.get('name') or meta.get('uri')
        return {
            'uri': meta.get('uri'),
            'subpage': subpage,
            'name': mark and (name + ' ' + mark) or name,
            'modes': meta.get('modes') or '',
            'group': list(meta.get('actuator_group') or []),
        }

    for index in range(over):
        for meta in knobs:
            listed.append(entry(meta, index if marked else None,
                                marked and SUBPAGE_MARKS[index] or ''))

    # A footswitch is the same footswitch on every sub-page. mod-ui files its addressing
    # under sub-page zero on a panel that has them, so that is where we look for it.
    for meta in switches + groups:
        listed.append(entry(meta, 0 if marked else None, ''))

    for index, item in enumerate(listed):
        item['index'] = index
        item['label'] = sanitize_label(item['name'], ACTUATOR_W)

    # the rows a group is made of, which the device needs to know what it blocks
    rows = dict((item['uri'], item['index']) for item in listed if not item['group'])
    for item in listed:
        item['members'] = [rows[uri] for uri in item['group'] if uri in rows]

    return listed


def is_hidden_port(port):
    """Whether a control input stays out of every list of parameters.

    The same rule as shouldSkipPort() in html/js/modgui.js, and the one place the device's
    lists take it from: the plugin editor and the binding manager used to apply it each in
    their own way, and the binding manager not at all -- so a plugin with an lv2:enabled
    port offered "Enabled" twice, and its notOnGUI ports besides.
    """
    if 'notOnGUI' in (port.get('properties') or []):
        return True

    return port.get('designation') in HIDDEN_DESIGNATIONS


def _presets_of(host, uri):
    """The presets a plugin has, as Host.addr_task_get_plugin_presets() lists them."""
    lookup = getattr(host, 'addr_task_get_plugin_presets', None)
    if lookup is None:
        return []

    try:
        return lookup(uri) or []
    except Exception:
        logging.exception("[bindings] cannot read the presets of %s", uri)
        return []


def _presets_entry(plugin, presets):
    """The Presets row, ranged so that binding it leaves the plugin on the preset it is on.

    Addressings.add() works out the options and the range of a :presets addressing for
    itself, but Host.address() clamps the value to the range it was given first and sets
    the port when it had to -- which for presets means loading one. So the range is the
    one add() will use, and the value is where the plugin already is. Looked up here rather
    than through get_presets_as_options(), which would pick a preset for a plugin that has
    none selected yet.
    """
    current = 0
    for index, preset in enumerate(presets):
        if preset.get('uri') == plugin.get('preset'):
            current = index
            break

    return {
        'symbol': PRESETS_SYMBOL,
        'name': 'Presets',
        'minimum': 0.0,
        'maximum': float(len(presets)),
        'value': float(current),
        'steps': max(len(presets) - 1, 1),
    }


def parameters(host, nid):
    """The control ports of one box, in the order the device will show them.

    Bypass first, then the presets when there are any, the way the plugin editor lists
    them, then the plugin's own control inputs in the order it declares them. Outputs are left out: there is nothing to turn. So are
    the ports is_hidden_port() names, which the editor and the web UI do not show either.
    """
    plugin = getattr(host, 'plugins', {}).get(nid)
    if not plugin:
        return []

    out = [{
        'symbol': BYPASS_SYMBOL,
        'name': 'Enabled',
        'minimum': 0.0,
        'maximum': 1.0,
        'value': 0.0 if plugin.get('bypassed') else 1.0,
        'steps': 1,
    }]

    presets = _presets_of(host, plugin['uri'])
    if presets:
        out.append(_presets_entry(plugin, presets))

    try:
        controls = _plugin_info(plugin['uri'])['controlInputs']
    except Exception:
        logging.exception("[bindings] cannot read the ports of %s", plugin.get('uri'))
        controls = []

    values = plugin.get('ports') or {}
    ranges = plugin.get('ranges') or {}

    for port in controls:
        if is_hidden_port(port):
            continue

        symbol = port['symbol']
        low, high = ranges.get(symbol, (port['ranges']['minimum'], port['ranges']['maximum']))

        out.append({
            'symbol': symbol,
            'name': port.get('name') or symbol,
            'minimum': float(low),
            'maximum': float(high),
            'value': float(values.get(symbol, port['ranges']['default'])),
            'steps': 33,
        })

    for index, entry in enumerate(out):
        entry['index'] = index
        entry['label'] = sanitize_label(entry['name'], PARAM_W)

    return out


def index_of(listed, uri, subpage):
    """Which row of the actuator list an addressing sits on, or -1.

    A knob appears once per sub-page, so the URI alone does not name a row: the sub-page
    the addressing was made on is what tells the three apart.
    """
    for entry in listed:
        if entry['uri'] == uri and entry['subpage'] == subpage:
            return entry['index']

    return -1


def parameter_at(host, nid, index):
    """The parameter the device means by a position, or None."""
    listed = parameters(host, nid)

    if index < 0 or index >= len(listed):
        return None
    return listed[index]


def _addressings_of(host, uri):
    try:
        return host.addressings.hmi_addressings[uri]['addrs']
    except (AttributeError, KeyError, TypeError):
        return []


def _addressings_for_row(host, row):
    """The addressings one row of the actuator list stands for.

    mod-ui files an addressing made on a group under each footswitch of the group, marked
    with the group's URI, and nothing under the group itself. So a group's addressings are
    found on its first footswitch, and a footswitch's own are the ones without the mark:
    read naively, binding to B&C showed B and C as taken and B&C as free.
    """
    if row['group']:
        return [addr for addr in _addressings_of(host, row['group'][0])
                if addr.get('group') == row['uri']]

    return [addr for addr in _addressings_of(host, row['uri']) if not addr.get('group')]


def slot(host, page, index):
    """What is bound to one actuator on one page, or None.

    An actuator holds one addressing per page, which is what makes a page and an actuator
    together the thing the device points at -- and what DEL takes off.
    """
    listed = actuators(host)

    if index < 0 or index >= len(listed):
        return None

    uri = listed[index]['uri']
    subpage = listed[index]['subpage']

    for addr in _addressings_for_row(host, listed[index]):
        # a board with no pages puts everything on the first one
        if (addr.get('page') or 0) != page:
            continue

        # ... and a knob on a panel with sub-pages is a different slot on each of them
        if addr.get('subpage') != subpage:
            continue

        instance_id = addr.get('instance_id')
        instance = None

        try:
            instance = host.mapper.id_map[instance_id]
        except (AttributeError, KeyError):
            pass

        return {
            'actuator': index,
            'uri': uri,
            'page': page,
            'subpage': subpage,
            'instance_id': instance_id,
            'instance': instance,
            'portsymbol': addr.get('port'),
            'label': sanitize_label(addr.get('label') or '-', ACTUATOR_W),
        }

    return None


def blocked(host, page, index):
    """Whether a row cannot take a binding on one page, because of a group.

    The web UI's rule: a group is not available while one of its footswitches holds
    something, and a footswitch is not while a group it belongs to does. The device works
    the same out for itself from the members it is sent, so it can mark the rows straight
    after a bind; this is for refusing one that got through anyway.
    """
    listed = actuators(host)

    if index < 0 or index >= len(listed):
        return False

    row = listed[index]

    if row['members']:
        return any(slot(host, page, member) is not None for member in row['members'])

    return any(slot(host, page, other['index']) is not None
               for other in listed if index in other['members'])


def taken(host, page):
    """Which actuators already carry something on one page, by index.

    The device draws these differently and turns DEL on for them: a slot that is spoken
    for is the one thing about the actuator column a user cannot work out by looking.
    """
    out = {}

    for entry in actuators(host):
        held = slot(host, page, entry['index'])
        if held is not None:
            out[entry['index']] = held['label']

    return out
