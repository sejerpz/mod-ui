#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Parameter-to-actuator bindings, for the HMI's binding manager.

Three lists and two verbs: what the selected plugin has to offer, which page of the board,
and which actuator on that page -- then bind, or take one off. Everything is addressed by
position the way the Add screen is: the device carries no port symbols and no actuator
URIs, only the index of the row it was shown.

Nothing here acts. The lookups are here and the two verbs are in mod/host.py, where the
callbacks live, which is the same split minimap.py and its handlers already use.
"""

import logging

from mod.settings import MINIMAP_HMI_SUBPAGES
from mod.minimap import sanitize_label

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

    return max(1, min(MINIMAP_HMI_SUBPAGES, len(SUBPAGE_MARKS)))


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
        elif 'knob' in uri:
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

    return listed


def parameters(host, nid):
    """The control ports of one box, in the order the device will show them.

    Bypass first, the way the plugin editor lists it, then the plugin's own control inputs
    in the order it declares them. Outputs are left out: there is nothing to turn.
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

    try:
        controls = _plugin_info(plugin['uri'])['controlInputs']
    except Exception:
        logging.exception("[bindings] cannot read the ports of %s", plugin.get('uri'))
        controls = []

    values = plugin.get('ports') or {}
    ranges = plugin.get('ranges') or {}

    for port in controls:
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

    for addr in _addressings_of(host, uri):
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
