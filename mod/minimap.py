#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pedalboard minimap: a compact scene description of the live plugin graph.

The HMI has a 128x64 monochrome LCD that acts as a window onto a larger scene.
Rather than shipping pixels, this module emits a *display list*: an ASCII
description of boxes, ports and cables with their pixel geometry. The firmware
draws it with its own GLCD primitives, which lets it pan, highlight a selection
and toggle signal layers without a round trip to the server.

The same records double as the hit-map for selection, so what is drawn and what
is selectable can never disagree.

Nothing here reacts to graph-change events. `host.plugins` / `host.connections`
are the authoritative model (Python originates every topology change; JACK never
reports connections back), so each request fingerprints the live state and only
rebuilds when it actually changed. That costs nothing while nobody is looking
and cannot miss the mutations that emit no message at all.

Targets Python 3.4: no f-strings, no variable annotations. Note that dicts are
unordered on 3.4, so every iteration over host.plugins is explicitly sorted --
otherwise both the fingerprint and the layout would be unstable.
"""

import logging

from mod import minimap_font as font
from mod.settings import (
    PEDALBOARD_INSTANCE_ID,
    MINIMAP_MAX_WIDTH,
    MINIMAP_MAX_HEIGHT,
    MINIMAP_VIEW_WIDTH,
    MINIMAP_VIEW_HEIGHT,
    MINIMAP_LAYERS,
    MINIMAP_MAX_MSG,
    MINIMAP_WIN_PLUGINS,
)

# ---------------------------------------------------------------------------
# geometry, tuned to the firmware's Terminal3x5 (3px glyphs + 1px gap = 4px/char)
# ---------------------------------------------------------------------------

# Density is a trade-off against the 128px-wide panel: every pixel spent on a
# box is a pixel not spent showing the rest of the chain. These values fit
# roughly three stages per screen while keeping labels readable at 4px/char.
CELL_W = 38           # ~8 characters of label
HW_CELL_W = 20        # hardware nodes carry short labels like IN1 / OUT2
MIN_CELL_H = 11       # 1 border + 1 pad + 5 text + 1 pad + 1 border, plus slack
PORT_PITCH = 3        # vertical distance between port stubs
CELL_PAD_V = 4
GUT_X = 10            # horizontal gutter, where cables turn
GUT_Y = 6
MARGIN = 3

# Records are separated by this, emitted as a token of its own, because the HMI protocol splits a
# message on spaces only (protocol.c: strarr_split(msg->data, ' ')) and would otherwise glue a
# newline onto the neighbouring token. sanitize_label() keeps it out of labels, and LV2 symbols
# cannot contain it, so it is unambiguous rather than merely unlikely.
RECORD_SEP = ';'

KIND_PLUGIN = 'p'
KIND_HW_SRC = 'i'     # feeds the graph -> drawn on the left
KIND_HW_SINK = 'o'    # consumes from the graph -> drawn on the right

TYPE_AUDIO = 'a'
TYPE_MIDI = 'm'
TYPE_CV = 'c'

_TYPE_NAMES = {'audio': TYPE_AUDIO, 'midi': TYPE_MIDI, 'cv': TYPE_CV}
_ALL_TYPES = (TYPE_AUDIO, TYPE_MIDI, TYPE_CV)


# ---------------------------------------------------------------------------
# plugin port lookup
#
# The in-memory plugin dict only carries *control* ports; audio/MIDI/CV symbols
# live behind get_plugin_info(), which is cached C-side per URI. We cache per
# URI here too so a redraw never repeats the ctypes hop.
# ---------------------------------------------------------------------------

_plugin_info_provider = None


def set_plugin_info_provider(fn):
    """Override the LV2 lookup. Used by tests to run without the .so."""
    global _plugin_info_provider
    _plugin_info_provider = fn


def _plugin_info(uri):
    global _plugin_info_provider
    if _plugin_info_provider is None:
        from modtools.utils import get_plugin_info
        _plugin_info_provider = get_plugin_info
    return _plugin_info_provider(uri)


# ---------------------------------------------------------------------------
# connection endpoint parsing
#
# Grammar per Host._fix_host_connection_port: every endpoint starts "/graph/".
# Three components means a hardware port, four or more a plugin port.
# ---------------------------------------------------------------------------

def parse_endpoint(endpoint):
    """('hw', symbol, None) or ('plugin', instance, portsymbol); None if unparseable."""
    parts = endpoint.split('/')
    if len(parts) == 3:
        return ('hw', parts[2], None)
    if len(parts) >= 4:
        return ('plugin', '/graph/' + parts[2], parts[3])
    return None


def hw_port_type(symbol):
    if symbol.startswith('cv_') or symbol in ('cv_exp_pedal',):
        return TYPE_CV
    if 'midi' in symbol or symbol.startswith('nooice'):
        return TYPE_MIDI
    return TYPE_AUDIO


def hw_label(symbol):
    """Short, uppercase label for a hardware node -- IN1, OUT2, CV1, MIDI..."""
    ptype = hw_port_type(symbol)
    tail = symbol.rsplit('_', 1)[-1]
    index = tail if tail.isdigit() else ''

    if ptype == TYPE_CV:
        return ('CVI' if 'capture' in symbol or 'exp' in symbol else 'CVO') + index
    if ptype == TYPE_MIDI:
        if 'merger' in symbol or symbol == 'serial_midi_in':
            return 'MIDIIN'
        if 'broadcaster' in symbol or symbol == 'serial_midi_out':
            return 'MIDIOUT'
        if 'loopback' in symbol:
            return 'MIDILOOP'
        return 'MIDI' + index
    if 'capture' in symbol or 'from_external' in symbol.lower() or 'Capture' in symbol:
        return 'IN' + index
    if 'playback' in symbol or 'to_external' in symbol.lower() or 'Playback' in symbol:
        return 'OUT' + index
    return symbol.upper()[:8]


def label_from_uri(uri):
    """Last meaningful component of an LV2 URI.

    Only reached when a plugin has no label and no name -- which happens when
    the LV2 lookup failed (get_plugin_info_essentials returns name='' on error).
    Showing "HTTP://." helps nobody; the tail of the URI at least identifies it.
    """
    if not uri:
        return '?'
    tail = uri
    for sep in ('#', '/', ':'):
        if sep in tail:
            tail = tail.rsplit(sep, 1)[-1] or tail
    return tail or uri


def sanitize_label(text, max_width):
    """Uppercase, wire-safe, truncated to fit `max_width` pixels.

    Terminal3x5 is marked "HARDCODED ALL CAPS" in the firmware, so uppercasing
    here keeps the truncation maths honest against what actually renders. Spaces
    become underscores, matching the `slabel` convention the space-delimited
    protocol already uses elsewhere.
    """
    if not text:
        text = '?'
    out = []
    for ch in text.upper():
        code = ord(ch)
        if ch == ' ' or ch == RECORD_SEP:
            # spaces would break the field split, the separator would break the record split
            out.append('_')
        elif 32 <= code <= 126:
            out.append(ch)
        # anything else (accents, non-latin) is dropped rather than mojibake'd
    cleaned = ''.join(out) or '?'
    return font.truncate(cleaned, max_width)


# ---------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------

class Port(object):
    __slots__ = ('symbol', 'direction', 'ptype', 'index', 'x', 'y', 'pid')

    def __init__(self, symbol, direction, ptype, index):
        self.symbol = symbol
        self.direction = direction   # 'i' or 'o'
        self.ptype = ptype
        self.index = index
        self.x = 0
        self.y = 0
        self.pid = index


class Node(object):
    __slots__ = ('key', 'kind', 'label', 'raw_label', 'cx', 'cy', 'bypassed',
                 'inputs', 'outputs', 'layer', 'row', 'x', 'y', 'w', 'h', 'nid')

    def __init__(self, key, kind, raw_label, cx, cy, bypassed, nid=-1):
        self.key = key
        self.nid = nid
        self.kind = kind
        self.raw_label = raw_label
        self.label = ''
        self.cx = cx                 # web canvas coords, only used for row order
        self.cy = cy
        self.bypassed = bypassed
        self.inputs = []
        self.outputs = []
        self.layer = 0
        self.row = 0
        self.x = 0
        self.y = 0
        self.w = 0
        self.h = 0

    def port(self, symbol, direction):
        for p in (self.inputs if direction == 'i' else self.outputs):
            if p.symbol == symbol:
                return p
        return None


class Edge(object):
    __slots__ = ('src', 'src_port', 'dst', 'dst_port', 'etype', 'points', 'eid')

    def __init__(self, src, src_port, dst, dst_port, etype):
        self.src = src
        self.src_port = src_port
        self.dst = dst
        self.dst_port = dst_port
        self.etype = etype
        self.points = []
        self.eid = -1


class Scene(object):
    """A laid-out graph: nodes with pixel rects, ports, edges with polylines."""

    def __init__(self):
        self.nodes = []          # ordered; ids are on the node, not the index
        self.edges = []
        self.by_key = {}
        self.width = 0
        self.height = 0
        self.plugin_count = 0


# ---------------------------------------------------------------------------
# Minimap
# ---------------------------------------------------------------------------

class Minimap(object):
    def __init__(self):
        self._fingerprint = None
        self._scene = None
        self._version = 0
        # emitted text keyed by (version, focus, layers, budget); the firmware
        # polls for changes, so an unchanged request should cost a dict lookup
        self._emitted = {}

    # -- state fingerprint --------------------------------------------------

    def fingerprint(self, host):
        """Cheap tuple capturing everything that can change the picture.

        Sorted explicitly: on Python 3.4 dict order is arbitrary, and an
        unsorted fingerprint would differ run to run, defeating the cache.
        """
        plugins = []
        for _instance_id, pluginData in self._iter_plugins(host):
            plugins.append((
                pluginData['instance'],
                pluginData.get('uri', ''),
                pluginData.get('label') or pluginData.get('name') or '',
                int(pluginData.get('x', 0)),
                int(pluginData.get('y', 0)),
                bool(pluginData.get('bypassed', False)),
            ))

        midiports = []
        for entry in getattr(host, 'midiports', ()):
            try:
                midiports.append(entry[0])
            except (IndexError, TypeError):
                pass

        return (
            tuple(plugins),
            tuple(tuple(c) for c in getattr(host, 'connections', ())),
            tuple(getattr(host, 'audioportsIn', ())),
            tuple(getattr(host, 'audioportsOut', ())),
            tuple(getattr(host, 'cvportsIn', ())),
            tuple(getattr(host, 'cvportsOut', ())),
            tuple(midiports),
            bool(getattr(host, 'midi_aggregated_mode', False)),
            bool(getattr(host, 'midi_loopback_enabled', False)),
        )

    @staticmethod
    def _iter_plugins(host):
        """Plugins in a stable order, skipping the pedalboard pseudo-instance.

        That entry has no 'x'/'y'/'name' keys at all, so it must be filtered
        before anything touches them.
        """
        plugins = getattr(host, 'plugins', {})
        items = []
        for instance_id, pluginData in plugins.items():
            if instance_id == PEDALBOARD_INSTANCE_ID:
                continue
            if not isinstance(pluginData, dict) or 'instance' not in pluginData:
                continue
            items.append((instance_id, pluginData))
        items.sort(key=lambda pair: pair[1]['instance'])
        return items

    def scene(self, host):
        """Laid-out scene for the current state, rebuilt only when it changed."""
        fp = self.fingerprint(host)
        if fp != self._fingerprint or self._scene is None:
            self._scene = self._layout(self._build_model(host))
            self._fingerprint = fp
            self._version += 1
            self._emitted.clear()
        return self._scene

    @property
    def version(self):
        return self._version

    # -- model --------------------------------------------------------------

    def _build_model(self, host):
        nodes = []
        by_key = {}

        for instance_id, pluginData in self._iter_plugins(host):
            key = pluginData['instance']
            raw = (pluginData.get('label') or pluginData.get('name')
                   or label_from_uri(pluginData.get('uri', '')))
            # the wire id is the mapper's instance_id, stable for the life of the
            # instance, because the device sends it back when it asks for another window
            node = Node(key, KIND_PLUGIN, raw,
                        float(pluginData.get('x', 0) or 0),
                        float(pluginData.get('y', 0) or 0),
                        bool(pluginData.get('bypassed', False)),
                        int(instance_id))
            self._attach_ports(node, pluginData.get('uri', ''))
            nodes.append(node)
            by_key[key] = node

        connections = list(getattr(host, 'connections', ()))

        # Hardware nodes: the declared audio/CV ports always show (they are the
        # chain's boundaries), plus any hardware endpoint a connection actually
        # references. The second source matters -- it guarantees no edge is left
        # dangling even when a MIDI port is named in a way we would not predict.
        hw_seen = {}

        def note_hw(symbol, is_source):
            if symbol in hw_seen:
                if is_source is not None:
                    hw_seen[symbol] = is_source
                return
            hw_seen[symbol] = is_source

        for symbol in getattr(host, 'audioportsIn', ()):
            note_hw(symbol, True)
        for symbol in getattr(host, 'cvportsIn', ()):
            note_hw(symbol, True)
        for symbol in getattr(host, 'audioportsOut', ()):
            note_hw(symbol, False)
        for symbol in getattr(host, 'cvportsOut', ()):
            note_hw(symbol, False)

        # a hardware endpoint used as a connection source feeds the graph
        for conn in connections:
            for endpoint, is_source in ((conn[0], True), (conn[1], False)):
                parsed = parse_endpoint(endpoint)
                if parsed is not None and parsed[0] == 'hw':
                    note_hw(parsed[1], is_source)

        # -1 is reserved: it is the 'no node' sentinel in the A records and in the
        # header's focus field, so hardware ids start at -2
        hw_id = -1
        for symbol in sorted(hw_seen):
            is_source = hw_seen[symbol]
            if is_source is None:
                is_source = 'capture' in symbol or symbol.endswith('_in') or 'merger' in symbol
            kind = KIND_HW_SRC if is_source else KIND_HW_SINK
            key = '/graph/' + symbol
            if key in by_key:
                continue
            # hardware has no instance_id, so it takes the negative half of the id space,
            # assigned over the sorted symbols so it is stable across renders too
            hw_id -= 1
            node = Node(key, kind, hw_label(symbol), 0.0, 0.0, False, hw_id)
            ptype = hw_port_type(symbol)
            port = Port(symbol, 'o' if is_source else 'i', ptype, 0)
            if is_source:
                node.outputs.append(port)
            else:
                node.inputs.append(port)
            nodes.append(node)
            by_key[key] = node

        # edges
        edges = []
        for conn in connections:
            src = self._resolve(by_key, conn[0], 'o')
            dst = self._resolve(by_key, conn[1], 'i')
            if src is None or dst is None:
                # A connection naming a port the plugin does not have should not
                # reach us, but it does under a fake host. Drop it rather than
                # drawing a cable to nowhere -- and say so, because a silently
                # under-reported graph is the worst outcome for an editor.
                logging.warning("[minimap] cannot resolve connection '%s' -> '%s'",
                                conn[0], conn[1])
                continue
            etype = src[1].ptype if src[1].ptype != TYPE_AUDIO else dst[1].ptype
            edges.append(Edge(src[0], src[1], dst[0], dst[1], etype))

        return (nodes, edges, by_key)

    def _attach_ports(self, node, uri):
        """Fill in audio/MIDI/CV ports from the LV2 world.

        A failing lookup is not fatal: the node still draws, it just shows no
        stubs, which is better than dropping the plugin from the picture.
        """
        try:
            info = _plugin_info(uri)
            ports = info['ports']
        except Exception:
            return

        for group in ('audio', 'cv', 'midi'):
            ptype = _TYPE_NAMES[group]
            block = ports.get(group) or {}
            for direction, bucket in (('i', 'input'), ('o', 'output')):
                target = node.inputs if direction == 'i' else node.outputs
                for port in block.get(bucket) or ():
                    symbol = port.get('symbol')
                    if not symbol:
                        continue
                    target.append(Port(symbol, direction, ptype, len(target)))

    @staticmethod
    def _resolve(by_key, endpoint, direction):
        parsed = parse_endpoint(endpoint)
        if parsed is None:
            return None

        if parsed[0] == 'hw':
            node = by_key.get('/graph/' + parsed[1])
            if node is None:
                return None
            pool = node.outputs if direction == 'o' else node.inputs
            if not pool:
                return None
            return (node, pool[0])

        node = by_key.get(parsed[1])
        if node is None:
            return None
        port = node.port(parsed[2], direction)
        if port is None:
            return None
        return (node, port)

    # -- layout -------------------------------------------------------------

    def _layout(self, model):
        nodes, edges, by_key = model
        scene = Scene()

        plugins = [n for n in nodes if n.kind == KIND_PLUGIN]
        sources = [n for n in nodes if n.kind == KIND_HW_SRC]
        sinks = [n for n in nodes if n.kind == KIND_HW_SINK]

        self._assign_layers(plugins, edges)

        # hardware pinned to the outer columns
        depth = max([n.layer for n in plugins]) + 1 if plugins else 0
        for n in plugins:
            n.layer += 1
        for n in sources:
            n.layer = 0
        for n in sinks:
            n.layer = depth + 1

        columns = {}
        for n in nodes:
            columns.setdefault(n.layer, []).append(n)

        # Row order is the "hybrid" part: follow the web canvas Y when it
        # actually distinguishes the nodes, otherwise fall back to the key.
        # `key` is always the final tie-break so the order is total -- required
        # for a stable picture on 3.4's unordered dicts.
        for layer in columns:
            group = columns[layer]
            ys = set(n.cy for n in group)
            if len(ys) > 1:
                group.sort(key=lambda n: (n.cy, n.key))
            else:
                group.sort(key=lambda n: n.key)
            for row, n in enumerate(group):
                n.row = row

        # sizes
        for n in nodes:
            n.w = CELL_W if n.kind == KIND_PLUGIN else HW_CELL_W
            span = max(len(n.inputs), len(n.outputs))
            n.h = max(MIN_CELL_H, span * PORT_PITCH + CELL_PAD_V)
            n.label = sanitize_label(n.raw_label, n.w - 4)

        # place columns left to right, each stack vertically centred
        ordered_layers = sorted(columns)
        stack_heights = {}
        for layer in ordered_layers:
            group = columns[layer]
            total = sum(n.h for n in group) + GUT_Y * max(0, len(group) - 1)
            stack_heights[layer] = total

        content_h = max(list(stack_heights.values()) + [0])
        content_w = sum(max(n.w for n in columns[l]) for l in ordered_layers)
        content_w += GUT_X * max(0, len(ordered_layers) - 1)

        # The scene never shrinks below the panel, so the pan maths always has
        # somewhere to go. When it is padded up to that floor the content is
        # centred in the padding -- left aligned would put half a blank screen
        # in front of the user on any board smaller than the panel.
        width = min(max(MINIMAP_VIEW_WIDTH, content_w + MARGIN * 2), MINIMAP_MAX_WIDTH)
        height = min(max(MINIMAP_VIEW_HEIGHT, content_h + MARGIN * 2), MINIMAP_MAX_HEIGHT)

        x = max(MARGIN, (width - content_w) // 2)
        top = max(MARGIN, (height - content_h) // 2)

        for layer in ordered_layers:
            group = columns[layer]
            widest = max(n.w for n in group)
            y = top + (content_h - stack_heights[layer]) // 2
            for n in group:
                n.x = x + (widest - n.w) // 2
                n.y = y
                y += n.h + GUT_Y
            x += widest + GUT_X

        scene.width = width
        scene.height = height

        for n in nodes:
            self._place_ports(n)

        for index, e in enumerate(edges):
            e.eid = index
            e.points = self._route(e, scene)

        scene.nodes = nodes
        scene.edges = edges
        scene.by_key = by_key
        scene.plugin_count = len(plugins)
        return scene

    @staticmethod
    def _assign_layers(plugins, edges):
        """Longest-path layering, cycle-safe.

        Kahn handles the acyclic part; whatever is left is in a feedback loop,
        and gets relaxed a bounded number of times rather than looping forever.
        """
        for n in plugins:
            n.layer = 0
        if not plugins:
            return

        keys = set(n.key for n in plugins)
        succ = {}
        indeg = {}
        for n in plugins:
            succ[n.key] = []
            indeg[n.key] = 0

        for e in edges:
            a = e.src.key
            b = e.dst.key
            if a in keys and b in keys and a != b:
                succ[a].append(b)
                indeg[b] += 1

        nodes_by_key = dict((n.key, n) for n in plugins)
        queue = sorted([k for k in indeg if indeg[k] == 0])
        seen = set(queue)

        while queue:
            key = queue.pop(0)
            base = nodes_by_key[key].layer
            for nxt in succ[key]:
                node = nodes_by_key[nxt]
                if node.layer < base + 1:
                    node.layer = base + 1
                indeg[nxt] -= 1
                if indeg[nxt] == 0 and nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
                    queue.sort()

        # anything still unvisited sits on a cycle
        leftover = sorted(k for k in indeg if k not in seen)
        for _ in range(len(leftover)):
            changed = False
            for key in leftover:
                node = nodes_by_key[key]
                for nxt in succ[key]:
                    target = nodes_by_key[nxt]
                    if target.layer < node.layer + 1:
                        target.layer = node.layer + 1
                        changed = True
            if not changed:
                break

    @staticmethod
    def _place_ports(node):
        for pool, is_input in ((node.inputs, True), (node.outputs, False)):
            count = len(pool)
            if not count:
                continue
            span = count * PORT_PITCH - (PORT_PITCH - 1)
            start = node.y + max(1, (node.h - span) // 2)
            for index, port in enumerate(pool):
                port.pid = index
                port.y = start + index * PORT_PITCH
                port.x = node.x - 1 if is_input else node.x + node.w

    def _route(self, edge, scene):
        """Orthogonal 1px cable from an output stub to an input stub.

        Forward edges take the usual three segments through the gutter. A cable
        that runs backwards (feedback) would cut straight through the boxes in
        between, so it detours below the whole scene instead.
        """
        sx = edge.src_port.x + 1
        sy = edge.src_port.y
        tx = edge.dst_port.x
        ty = edge.dst_port.y

        if tx > sx + 2:
            mid = (sx + tx) // 2
            if sy == ty:
                return [(sx, sy), (tx, ty)]
            return [(sx, sy), (mid, sy), (mid, ty), (tx, ty)]

        below = min(scene.height - 1, max(edge.src.y + edge.src.h, edge.dst.y + edge.dst.h) + 3)
        return [(sx, sy), (sx + 3, sy), (sx + 3, below), (tx - 3, below), (tx - 3, ty), (tx, ty)]

    # -- windowing ----------------------------------------------------------

    def _window_nodes(self, scene, focus_key, budget):
        """Plugins near `focus_key`, breadth-first over the undirected graph.

        The unit is the plugin, never the connection: we pick a bounded set of
        plugins and then emit *all* their cables. Clipping by geometry instead
        would show plugins with cables missing, which is exactly the wrong lie
        to tell while someone is editing the routing.

        A budget rather than a hop limit, because a hop limit explodes in dense
        regions and the point is to bound the message.
        """
        plugins = [n for n in scene.nodes if n.kind == KIND_PLUGIN]
        if not plugins:
            return set(n.key for n in scene.nodes)

        focus = scene.by_key.get(focus_key)
        if focus is None or focus.kind != KIND_PLUGIN:
            focus = plugins[0]

        neighbours = {}
        for n in plugins:
            neighbours[n.key] = set()
        for e in scene.edges:
            a, b = e.src.key, e.dst.key
            if a in neighbours and b in neighbours and a != b:
                neighbours[a].add(b)
                neighbours[b].add(a)

        chosen = [focus.key]
        seen = set(chosen)
        queue = [focus.key]

        while queue and len(chosen) < budget:
            key = queue.pop(0)
            for nxt in sorted(neighbours[key],
                              key=lambda k: (scene.by_key[k].layer, scene.by_key[k].row, k)):
                if nxt in seen:
                    continue
                seen.add(nxt)
                chosen.append(nxt)
                queue.append(nxt)
                if len(chosen) >= budget:
                    break

        # a disconnected board would otherwise strand every island; top up with
        # the nearest unvisited plugins by layout position
        if len(chosen) < budget:
            rest = sorted((n for n in plugins if n.key not in seen),
                          key=lambda n: (abs(n.layer - focus.layer), n.layer, n.row, n.key))
            for n in rest:
                if len(chosen) >= budget:
                    break
                seen.add(n.key)
                chosen.append(n.key)

        return set(chosen)

    # -- emission -----------------------------------------------------------

    def render(self, host, focus=None, layers=None, budget=None):
        """Display list for the current graph.

        `focus` limits output to the plugins around that instance; without it
        the whole scene is emitted, which is what the reference renderer and
        the browser debug view use.
        """
        scene = self.scene(host)
        mask = parse_layers(layers)

        cache_key = (focus, mask, budget)
        cached = self._emitted.get(cache_key)
        if cached is not None:
            return (cached, self._version)

        if focus is None:
            visible = set(n.key for n in scene.nodes)
            windowed = False
        else:
            budget = budget or MINIMAP_WIN_PLUGINS
            visible = self._window_nodes(scene, focus, budget)
            windowed = True
            # hardware nodes ride along when they terminate a visible cable
            for e in scene.edges:
                if e.src.key in visible and e.dst.kind != KIND_PLUGIN:
                    visible.add(e.dst.key)
                if e.dst.key in visible and e.src.kind != KIND_PLUGIN:
                    visible.add(e.src.key)

        lines = []
        nodes = [n for n in scene.nodes if n.key in visible]
        node_ids = set(n.nid for n in nodes)

        # every cable with at least one end inside the window; the far end of an
        # outgoing one is emitted as a marked reference so the firmware knows
        # there is more that way and can ask for the window around it
        shown_edges = []
        for e in scene.edges:
            if e.etype not in mask:
                continue
            inside_src = e.src.nid in node_ids
            inside_dst = e.dst.nid in node_ids
            if inside_src or inside_dst:
                shown_edges.append((e, inside_src, inside_dst))

        focus_id = -1
        if focus is not None and focus in scene.by_key:
            focus_id = scene.by_key[focus].nid

        lines.append('M %d %d %d %s %d %d %d' % (
            scene.width, scene.height, self._version, layers_to_str(mask),
            focus_id, len(nodes), scene.plugin_count))

        for n in nodes:
            lines.append('N %d %s %d %d %d %d %d %d %d %s' % (
                n.nid, n.kind, n.x, n.y, n.w, n.h,
                1 if n.bypassed else 0, n.layer, n.row, n.label or '-'))

        for n in nodes:
            for pool in (n.inputs, n.outputs):
                for p in pool:
                    if p.ptype not in mask:
                        continue
                    lines.append('P %d %d %s %s %d %d %s' % (
                        n.nid, p.pid, p.direction, p.ptype, p.x, p.y, p.symbol))

        for e, inside_src, inside_dst in shown_edges:
            coords = ' '.join('%d,%d' % (px, py) for px, py in e.points)
            lines.append('E %d %d:%d %d:%d %s %d %d %s' % (
                e.eid, e.src.nid, e.src_port.pid, e.dst.nid, e.dst_port.pid,
                e.etype, 0 if inside_src else 1, 0 if inside_dst else 1, coords))

        for line in self._adjacency(nodes):
            lines.append(line)

        # Records joined by a standalone separator token rather than by newlines: the HMI
        # protocol splits a message on spaces only, so a newline would be glued onto the
        # neighbouring token. One line, unambiguous either way -- see RECORD_SEP.
        text = (' ' + RECORD_SEP + ' ').join(lines) + ' ' + RECORD_SEP

        if windowed and len(text) > MINIMAP_MAX_MSG and budget > 1:
            # the budget is normally tuned to fit; shrink and retry rather than
            # ever emitting a message the firmware's 4K buffer would drop
            return self.render(host, focus, layers, budget - 1)

        self._emitted[cache_key] = text
        return (text, self._version)

    @staticmethod
    def _adjacency(nodes):
        """Precomputed up/down/left/right for encoder navigation.

        The LCD has no touch: selection moves with an encoder, so shipping the
        neighbours saves the firmware from redoing nearest-neighbour search.
        Computed over the visible set only, so navigation never lands on
        something that was not drawn.
        """
        by_layer = {}
        for n in nodes:
            by_layer.setdefault(n.layer, []).append(n)
        for layer in by_layer:
            by_layer[layer].sort(key=lambda n: (n.row, n.key))

        layers = sorted(by_layer)
        out = []

        for index, layer in enumerate(layers):
            group = by_layer[layer]
            prev_group = by_layer[layers[index - 1]] if index > 0 else []
            next_group = by_layer[layers[index + 1]] if index + 1 < len(layers) else []

            for pos, n in enumerate(group):
                up = group[pos - 1].nid if pos > 0 else -1
                down = group[pos + 1].nid if pos + 1 < len(group) else -1
                left = prev_group[min(pos, len(prev_group) - 1)].nid if prev_group else -1
                right = next_group[min(pos, len(next_group) - 1)].nid if next_group else -1
                out.append('A %d %d %d %d %d' % (n.nid, up, down, left, right))

        return out

    def info(self, host):
        scene = self.scene(host)
        return {
            'version': self._version,
            'width': scene.width,
            'height': scene.height,
            'view': [MINIMAP_VIEW_WIDTH, MINIMAP_VIEW_HEIGHT],
            'nodes': len(scene.nodes),
            'plugins': scene.plugin_count,
            'edges': len(scene.edges),
        }


# ---------------------------------------------------------------------------
# layer masks
# ---------------------------------------------------------------------------

def parse_layers(spec):
    """'audio,midi' -> frozenset('a','m'). None means the configured default."""
    if spec is None:
        spec = MINIMAP_LAYERS
    if isinstance(spec, (set, frozenset, tuple, list)):
        return frozenset(spec)

    out = set()
    for token in str(spec).split(','):
        token = token.strip().lower()
        if not token:
            continue
        if token in _TYPE_NAMES:
            out.add(_TYPE_NAMES[token])
        elif token in _ALL_TYPES:
            out.add(token)
        elif token == 'all':
            out.update(_ALL_TYPES)
        elif token == 'none':
            out.clear()
    return frozenset(out)


def layers_to_str(mask):
    return ''.join(t for t in _ALL_TYPES if t in mask) or '-'


# the webserver keeps one instance; it holds only the cached scene
INSTANCE = Minimap()
