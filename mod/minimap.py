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
    MINIMAP_HMI_VIEW_WIDTH,
    MINIMAP_HMI_VIEW_HEIGHT,
    MINIMAP_LAYERS,
    MINIMAP_MODE,
    MINIMAP_MAX_MSG,
    MINIMAP_MAX_NODES,
    MINIMAP_MAX_PORTS,
    MINIMAP_MAX_EDGES,
    MINIMAP_MAX_MENU,
    MINIMAP_MAX_PAIRS,
    MINIMAP_MAX_ROW_PAIRS,
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
MIN_CELL_H = 16       # tall enough that the label has air above and below the port stubs
PORT_PITCH = 4        # vertical distance between port stubs
CELL_PAD_V = 6
GUT_X = 14            # horizontal gutter, wide enough for several turning lanes
GUT_Y = 9             # vertical gutter, so a cable crossing a row is not against a box
MARGIN = 3

# Where a cable turns inside the gutter. Cables that share an end -- a fan-out from one
# box, a fan-in to one box -- turn on the same column, so they read as one bus; that is
# what makes a split or a merge legible. Cables that share nothing get columns of their
# own, because two unrelated pairs turning together merge into a single vertical line
# that looks exactly like a connection they do not have.
ROW_SWEEPS = 4        # median-heuristic passes over the columns, each way

# A cable that skips columns cannot be drawn straight from one stub to the other: it would
# plough through every box in between and read as a chain of connections that do not exist.
# It turns into the gutter beside its own box and crosses on a channel -- one of the free
# horizontal bands between the rows -- which only exist because uniform styles snap their
# columns to a shared row grid instead of centring each one on its own.
LANE_PITCH = 2        # spacing between bundles sharing a gutter
LONG_INSET = 3        # how far into the gutter a long cable turns
CHANNEL_PITCH = 2     # spacing between long cables sharing a band
CHANNEL_CLEAR = 2     # air to leave between a crossing cable and the boxes it passes

# The box label is cut to the width of the box, which in the compact picture leaves
# five characters -- not enough to tell COMPRES from COMPR_2. So each node also carries
# a label cut to the title bar instead, which is the full width of the panel, and the
# firmware puts that one above the graph for whichever node is selected.
TITLE_W = 100         # 25 characters of Terminal3x5, inside the 128px bar
PAIR_W = 44           # 11 characters: two port names fit the strip under the menu
CANVAS_STEP = 180     # a box and a gap on the web canvas, for placing a spliced one

# MINIMAP_NONE in the firmware: the id that means no box at all. Hardware takes the
# negative half of the id space from -2 down, so a negative id is not on its own a
# refusal -- IN1 is as spliceable as anything else.
NO_NODE = -1


# ---------------------------------------------------------------------------
# representations
# ---------------------------------------------------------------------------

MODE_DETAIL = 'detail'
MODE_COMPACT = 'compact'


class Style(object):
    """Geometry and level of detail for one way of drawing the same graph."""

    __slots__ = ('name', 'cell_w', 'hw_cell_w', 'min_cell_h', 'port_pitch',
                 'cell_pad_v', 'gut_x', 'gut_y', 'collapse', 'uniform')

    def __init__(self, name, cell_w, hw_cell_w, min_cell_h, port_pitch,
                 cell_pad_v, gut_x, gut_y, collapse, uniform):
        self.name = name
        self.cell_w = cell_w
        self.hw_cell_w = hw_cell_w
        self.min_cell_h = min_cell_h
        self.port_pitch = port_pitch
        self.cell_pad_v = cell_pad_v
        self.gut_x = gut_x
        self.gut_y = gut_y
        self.collapse = collapse        # one cable per pair of boxes, not per pair of ports
        self.uniform = uniform          # every box the same size, whatever it holds


STYLES = {
    # Port accurate. Boxes are sized to hold their stubs, so a 4-in mixer is
    # taller than a mono pedal, and every cable is drawn.
    MODE_DETAIL: Style(MODE_DETAIL, 38, 20, 16, 4, 6, 14, 9, False, False),

    # "What feeds what". A stereo pair is one line, four cables into a mixer are
    # one line, and boxes are all the same small size -- roughly twice as much
    # board on screen, at the cost of not showing which port goes where.
    MODE_COMPACT: Style(MODE_COMPACT, 24, 24, 11, 4, 4, 10, 7, True, True),
}


def normalize_mode(mode):
    """A mode name, falling back to the configured default and then to detail."""
    if mode in STYLES:
        return mode
    if MINIMAP_MODE in STYLES:
        return MINIMAP_MODE
    return MODE_DETAIL

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

# The bits the firmware uses for the same three, in app/inc/minimap.h. The connection
# commands speak in these because the HMI protocol carries integers, not names.
TYPE_BITS = ((TYPE_AUDIO, 1), (TYPE_MIDI, 2), (TYPE_CV, 4))


def types_from_bits(bits):
    """MINIMAP_AUDIO | MINIMAP_MIDI | MINIMAP_CV -> the type letters they stand for."""
    if not bits:
        return frozenset(_ALL_TYPES)
    return frozenset(t for t, bit in TYPE_BITS if bits & bit)


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
        if ch == ' ' or ch == RECORD_SEP or ch == '"':
            # spaces would break the field split, the separator would break the record
            # split, and a quote would break both: the firmware's strarr_split() treats
            # quoted runs as one token and parse_quote() then shifts the text under it,
            # which is what mode_builder.c rebuilds the message in place on top of
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
    __slots__ = ('key', 'kind', 'label', 'title', 'raw_label', 'bypassed',
                 'inputs', 'outputs', 'layer', 'row', 'x', 'y', 'w', 'h', 'nid')

    def __init__(self, key, kind, raw_label, bypassed, nid=-1):
        self.key = key
        self.nid = nid
        self.kind = kind
        self.raw_label = raw_label
        self.label = ''
        self.title = ''
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
    __slots__ = ('src', 'src_port', 'dst', 'dst_port', 'etype', 'points', 'eid',
                 'lane', 'lane_count', 'channel')

    def __init__(self, src, src_port, dst, dst_port, etype):
        self.src = src
        self.src_port = src_port
        self.dst = dst
        self.dst_port = dst_port
        self.etype = etype
        self.points = []
        self.eid = -1
        self.lane = 0
        self.lane_count = 1
        self.channel = None


def _endpoint(node, port):
    """The '/graph/...' string a connection uses for this port."""
    return _endpoint_symbol(node, port.symbol)


def _endpoint_symbol(node, symbol):
    if node.kind == KIND_PLUGIN:
        return node.key + '/' + symbol
    return node.key


class Scene(object):
    """A laid-out graph: nodes with pixel rects, ports, edges with polylines."""

    def __init__(self):
        self.nodes = []          # ordered; ids are on the node, not the index
        self.edges = []
        self.by_key = {}
        self.width = 0
        self.height = 0
        self.plugin_count = 0
        self.column_x = {}       # left edge of each column, for placing cable turns


# ---------------------------------------------------------------------------
# Minimap
# ---------------------------------------------------------------------------

class Minimap(object):
    def __init__(self, mode=None):
        self.mode = normalize_mode(mode)
        self.style = STYLES[self.mode]
        self._fingerprint = None
        self._scene = None
        self._version = 0
        # emitted text keyed by (version, focus, layers, budget); the firmware
        # polls for changes, so an unchanged request should cost a dict lookup
        self._emitted = {}

    # -- state fingerprint --------------------------------------------------

    def fingerprint(self, host):
        """Cheap tuple capturing everything that can change the picture.

        The canvas position is deliberately absent: the layout no longer reads
        it, so dragging a plugin in the browser cannot change a single pixel
        here. Watching it would bump the version and send the device off to
        refetch a display list identical to the one it already has.

        Sorted explicitly: on Python 3.4 dict order is arbitrary, and an
        unsorted fingerprint would differ run to run, defeating the cache.
        """
        plugins = []
        for _instance_id, pluginData in self._iter_plugins(host):
            plugins.append((
                pluginData['instance'],
                pluginData.get('uri', ''),
                pluginData.get('label') or pluginData.get('name') or '',
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
            self._scene = self._layout(self._collapse(self._build_model(host)))
            self._fingerprint = fp
            self._version += 1
            self._emitted.clear()
        return self._scene

    @property
    def version(self):
        return self._version

    @staticmethod
    def key_for_id(scene, nid):
        """Scene key for a node id as it is numbered in the display list.

        The wire format carries ids, not keys: the HMI names the node it wants
        the window around with the id it was drawn with.
        """
        for node in scene.nodes:
            if node.nid == nid:
                return node.key
        return None

    @staticmethod
    def default_focus(scene):
        """Where a device opening the minimap should start.

        The first hardware input -- IN1 on a Dwarf -- because that is where the
        signal enters and reading the chain left to right is what the box
        arrangement is for. Falls back to the first plugin on a board with no
        hardware sources, and to nothing at all on an empty scene.

        Windowing does not follow this: _window_nodes() takes a hardware focus
        as "start from the first plugin", so the window is unchanged and only
        the cursor moves.
        """
        for kind in (KIND_HW_SRC, KIND_PLUGIN):
            for node in scene.nodes:
                if node.kind == kind:
                    return node.key
        return scene.nodes[0].key if scene.nodes else None

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
        hw_id = NO_NODE
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
            node = Node(key, kind, hw_label(symbol), False, hw_id)
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

    def _collapse(self, model):
        """One stub per signal type per side, and one cable per pair of boxes.

        The compact picture answers "what feeds what", not "which port feeds
        which port": a stereo pair, or four cables into a mixer, become one
        line. Collapsing per signal type as well rather than per pair alone, so
        a MIDI cable running beside audio keeps its own line and its own dash,
        and the layer filter still means something.

        A no-op in the detail style, which is the port-accurate picture.
        """
        if not self.style.collapse:
            return model

        nodes, edges, by_key = model

        # A stub per signal type that a cable actually uses, not per type the plugin
        # declares. A plugin with MIDI ports nobody has patched was drawing a second stub
        # beside the audio one, which pushed the audio stub off the middle of its box and
        # made every cable into it arrive on a slant.
        incoming = {}
        outgoing = {}
        for e in edges:
            outgoing.setdefault(e.src.key, set()).add(e.etype)
            incoming.setdefault(e.dst.key, set()).add(e.etype)

        for node in nodes:
            for pool, direction, present in ((node.inputs, 'i', incoming.get(node.key, ())),
                                             (node.outputs, 'o', outgoing.get(node.key, ()))):
                del pool[:]
                for index, ptype in enumerate(t for t in _ALL_TYPES if t in present):
                    pool.append(Port('*', direction, ptype, index))

        def stub(pool, etype):
            for port in pool:
                if port.ptype == etype:
                    return port
            return pool[0] if pool else None

        kept = []
        seen = set()
        for e in edges:
            key = (e.src.key, e.dst.key, e.etype)
            if key in seen:
                continue

            src_port = stub(e.src.outputs, e.etype)
            dst_port = stub(e.dst.inputs, e.etype)
            if src_port is None or dst_port is None:
                continue

            seen.add(key)
            e.src_port = src_port
            e.dst_port = dst_port
            kept.append(e)

        return (nodes, kept, by_key)

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

        self._order_rows(columns, edges)

        # sizes
        style = self.style
        for n in nodes:
            if style.uniform:
                n.w = style.cell_w
                n.h = style.min_cell_h
            else:
                n.w = style.cell_w if n.kind == KIND_PLUGIN else style.hw_cell_w
                span = max(len(n.inputs), len(n.outputs))
                n.h = max(style.min_cell_h, span * style.port_pitch + style.cell_pad_v)
            n.label = sanitize_label(n.raw_label, n.w - 4)
            n.title = sanitize_label(n.raw_label, TITLE_W)

        # place columns left to right, each stack vertically centred
        ordered_layers = sorted(columns)
        stack_heights = {}
        for layer in ordered_layers:
            group = columns[layer]
            total = sum(n.h for n in group) + style.gut_y * max(0, len(group) - 1)
            stack_heights[layer] = total

        content_h = max(list(stack_heights.values()) + [0])
        content_w = sum(max(n.w for n in columns[l]) for l in ordered_layers)
        content_w += style.gut_x * max(0, len(ordered_layers) - 1)

        # The scene is exactly the drawing, with no padding up to the size of the panel.
        # Padding it put a board smaller than the viewport in the middle of a canvas the
        # device then panned over, and since the builder screen keeps a title bar and a
        # footer for itself, its viewport is shorter than the panel -- so the padding did
        # not cancel out and the picture sat too low. A scene smaller than the viewport is
        # centred by the firmware instead, which is the only side that knows how much of
        # the panel is left for the graph.
        width = min(content_w + MARGIN * 2, MINIMAP_MAX_WIDTH)
        height = min(content_h + MARGIN * 2, MINIMAP_MAX_HEIGHT)

        x = MARGIN
        top = MARGIN

        # Every column is centred on one axis, so the hardware pairs -- the inputs on the
        # left and the outputs on the right -- sit across the middle of the picture and
        # everything else grows symmetrically above and below them. Snapping columns to a
        # shared row grid instead would tidy the bands and free a corridor between them,
        # but it rounds a column to a whole row: a board whose deepest column holds three
        # boxes then pushes IN1 and IN2 into the top two thirds.
        for layer in ordered_layers:
            group = columns[layer]
            widest = max(n.w for n in group)
            y = top + (content_h - stack_heights[layer]) // 2
            scene.column_x[layer] = x

            for n in group:
                n.x = x + (widest - n.w) // 2
                n.y = y
                y += n.h + style.gut_y

            x += widest + style.gut_x

        scene.width = width
        scene.height = height

        for n in nodes:
            self._place_ports(n)

        # Bundles, per gutter: everything leaving one box travels together, and so does
        # everything arriving at one box. A cable belongs to its source's bundle when that
        # source fans out, and to its target's otherwise, which is what makes a split and a
        # merge each collapse onto a single turning column.
        gutters = {}
        for e in edges:
            gutters.setdefault(e.src.layer, []).append(e)

        for layer in sorted(gutters):
            group = gutters[layer]

            fanout = {}
            for e in group:
                fanout[e.src.key] = fanout.get(e.src.key, 0) + 1

            slots = {}
            for e in group:
                bundle = e.src.key if fanout[e.src.key] > 1 else e.dst.key
                if bundle not in slots:
                    slots[bundle] = len(slots)
                e.lane = slots[bundle]

            for e in group:
                e.lane_count = len(slots)

        # A cable that skips columns needs a clear horizontal band to cross on. Without a
        # row grid there is no set of corridors to draw from, so each one is looked up in
        # the layout as it actually came out: the free bands between the boxes standing in
        # its way. Cables already using a band step aside from each other.
        used = {}
        for e in edges:
            if e.dst.layer - e.src.layer <= 1:
                continue
            e.channel = self._free_band(e, scene, nodes, used)

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
    def _order_rows(columns, edges):
        """Row order inside each column, from the wiring rather than the canvas.

        Following the web canvas Y kept every box where the user had dropped it,
        which reads well on a 1000px canvas and badly on 124: a plugin dropped
        high and wired to something low turns into a cable across the whole
        picture. So the canvas is ignored and rows are chosen to sit each node
        next to whatever it is wired to -- the median heuristic from layered
        graph drawing, swept both ways so an ordering settles instead of just
        following the first column.

        `key` stays the final tie-break, so the order is total and the picture
        is stable on 3.4's unordered dicts.
        """
        layers = sorted(columns)

        for layer in layers:
            group = columns[layer]
            group.sort(key=lambda n: n.key)
            for row, n in enumerate(group):
                n.row = row

        if len(layers) < 2:
            return

        # neighbours split by the side they sit on, so a sweep only looks at the
        # column it has already placed
        left = {}
        right = {}
        for layer in layers:
            for n in columns[layer]:
                left[n.key] = []
                right[n.key] = []

        for e in edges:
            if e.src.key == e.dst.key or e.src.key not in left or e.dst.key not in left:
                continue
            if e.src.layer < e.dst.layer:
                right[e.src.key].append(e.dst)
                left[e.dst.key].append(e.src)
            elif e.src.layer > e.dst.layer:
                left[e.src.key].append(e.dst)
                right[e.dst.key].append(e.src)

        def anchor(node, side):
            # a node with nothing on that side keeps the row it already has, so
            # unconnected boxes drift rather than pile up at the top
            rows = sorted(n.row for n in side[node.key])
            if not rows:
                return float(node.row)
            middle = len(rows) // 2
            if len(rows) % 2:
                return float(rows[middle])
            return (rows[middle - 1] + rows[middle]) / 2.0

        for _ in range(ROW_SWEEPS):
            for forward in (True, False):
                if forward:
                    order, side = layers[1:], left
                else:
                    order, side = layers[:-1][::-1], right

                for layer in order:
                    group = sorted(columns[layer],
                                   key=lambda n: (anchor(n, side), n.key))
                    columns[layer] = group
                    for row, n in enumerate(group):
                        n.row = row

    def _place_ports(self, node):
        pitch = self.style.port_pitch
        for pool, is_input in ((node.inputs, True), (node.outputs, False)):
            count = len(pool)
            if not count:
                continue
            span = count * pitch - (pitch - 1)
            start = node.y + max(1, (node.h - span) // 2)
            for index, port in enumerate(pool):
                port.pid = index
                port.y = start + index * pitch
                port.x = node.x - 1 if is_input else node.x + node.w

    @staticmethod
    def _turn(edge, scene, sx, tx):
        """The column a cable turns on, inside the gutter it leaves its box by.

        Measured on the gutter itself rather than on the distance to the far end, so a
        cable crossing several columns turns on the same line as its short neighbour out
        of the same stub -- otherwise two cables leaving one box set off a pixel apart and
        the trunk looks kinked.

        Bundles spread symmetrically about the middle of the gutter, so a plain chain --
        one bundle -- turns exactly on the centre. Handing out lanes from the left edge
        instead left every vertical a pixel off centre, plainly visible on 124 pixels.
        """
        far = scene.column_x.get(edge.src.layer + 1)
        far = (far - 1) if far is not None else tx

        centre = (sx + far) // 2
        shift = (2 * edge.lane - (edge.lane_count - 1)) * LANE_PITCH // 2
        return max(sx + 1, min(centre + shift, max(sx + 1, far - 1)))

    @staticmethod
    def _simplify(points):
        """Drop repeated and collinear points from a polyline.

        A route that turns onto the level it was already on leaves corners that bend
        by nothing. They draw the same picture, but each one costs bytes on the wire
        and a slot in the firmware's eight-point limit.
        """
        out = []
        for point in points:
            if out and out[-1] == point:
                continue
            if len(out) >= 2:
                (ax, ay), (bx, by) = out[-2], out[-1]
                cx, cy = point
                if (ax == bx == cx) or (ay == by == cy):
                    out[-1] = point
                    continue
            out.append(point)
        return out

    def _elbow(self, sx, sy, tx, ty, mid):
        """The three-segment cable, with any corner that bends by nothing dropped."""
        return self._simplify([(sx, sy), (mid, sy), (mid, ty), (tx, ty)])

    @staticmethod
    def _free_band(edge, scene, nodes, used):
        """A horizontal band this cable can cross on without touching a box.

        Looks at the boxes actually standing between the two ends and takes the gaps
        between them, nearest the straight line first. `used` remembers the bands other
        crossing cables have taken over the same stretch, so two of them do not end up
        drawn on top of each other. None when the boxes leave no gap at all, and the
        caller falls back to the ordinary route.
        """
        left = min(edge.src_port.x, edge.dst_port.x)
        right = max(edge.src_port.x, edge.dst_port.x)

        blocked = []
        for n in nodes:
            if n is edge.src or n is edge.dst:
                continue
            if n.x + n.w <= left or n.x >= right:
                continue
            blocked.append((n.y - CHANNEL_CLEAR, n.y + n.h + CHANNEL_CLEAR))
        blocked.sort()

        gaps = []
        cursor = 0
        for low, high in blocked:
            if low > cursor:
                gaps.append((cursor, low))
            cursor = max(cursor, high)
        if cursor < scene.height:
            gaps.append((cursor, scene.height))

        if not gaps:
            return None

        middle = (edge.src_port.y + edge.dst_port.y) // 2
        gaps.sort(key=lambda g: (abs((g[0] + g[1]) // 2 - middle), g[0]))

        for low, high in gaps:
            centre = (low + high) // 2

            # A band level with one of the two stubs lets the cable leave straight and
            # costs it no corner at all; the middle of the gap is only the fallback.
            # Without this a cable whose own stub already sits in the free band still
            # stepped across to the band's centre, for a kink that bought nothing.
            candidates = [y for y in (edge.src_port.y, edge.dst_port.y)
                          if low < y < high - 1]
            candidates.append(centre)

            # step aside from cables already crossing this stretch on the same band
            for offset in range(0, max(1, (high - low) // 2), CHANNEL_PITCH):
                for band in (centre + offset, centre - offset):
                    if band not in candidates:
                        candidates.append(band)

            for band in candidates:
                if band <= low or band >= high - 1:
                    continue
                clash = False
                for taken_band, taken_left, taken_right in used.get(band, ()):
                    if taken_left < right and taken_right > left:
                        clash = True
                        break
                if not clash:
                    used.setdefault(band, []).append((band, left, right))
                    return band

        low, high = gaps[0]
        return (low + high) // 2

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

        if edge.channel is not None:
            # Into the gutter beside our own box, across on the channel, back out beside
            # the target: never over the boxes in between. The turn out is the same column
            # the bundle uses, so a long cable and a short one leaving the same stub set
            # off together instead of splitting a pixel apart.
            out_x = self._turn(edge, scene, sx, tx)
            in_x = tx - LONG_INSET
            if in_x > out_x:
                return self._simplify([(sx, sy), (out_x, sy), (out_x, edge.channel),
                                       (in_x, edge.channel), (in_x, ty), (tx, ty)])

        if tx > sx + 2:
            if sy == ty:
                return [(sx, sy), (tx, ty)]

            return self._elbow(sx, sy, tx, ty, self._turn(edge, scene, sx, tx))

        below = min(scene.height - 1, max(edge.src.y + edge.src.h, edge.dst.y + edge.dst.h) + 3)
        return [(sx, sy), (sx + 3, sy), (sx + 3, below), (tx - 3, below), (tx - 3, ty), (tx, ty)]

    # -- windowing ----------------------------------------------------------

    def _window_nodes(self, scene, focus_key, budget):
        """The boxes nearest `focus_key` in the picture, viewport-shaped.

        Geometric, not graph-theoretic. The device pans a viewport over a scene and
        draws whatever the message holds, so the one thing the window must never do
        is leave out a box that is on screen. Choosing by graph distance did exactly
        that: stepping to the box next door swapped the picture for a different
        neighbourhood and boxes the user was looking at vanished.

        Nearest-first in a metric scaled to the viewport, so the set is the ellipse
        the panel can actually show rather than a column of a tall board or a strip
        of a wide one -- whole columns spend the whole budget vertically on a board
        forty plugins deep and leave the slice too narrow. Stepping one box along
        moves the centre by one box, so the window shifts rather than changes.

        Cables reaching outside are still emitted and flagged, so nothing is quietly
        hidden; see src_outside/dst_outside in the E records.
        """
        if not scene.nodes:
            return set()

        focus = scene.by_key.get(focus_key)
        if focus is None:
            plugins = [n for n in scene.nodes if n.kind == KIND_PLUGIN]
            focus = plugins[0] if plugins else scene.nodes[0]

        # Horizontally, exactly the viewport the device will be looking at: minimap_select()
        # centres the selection and minimap_scroll() clamps to the scene. Guessing this
        # wrong is not cosmetic -- near an edge the panel shows boxes on one side only, and
        # a window built around an unclamped centre leaves some of them out of the message.
        view_x = max(0, min(focus.x + focus.w // 2 - MINIMAP_HMI_VIEW_WIDTH // 2,
                            max(0, scene.width - MINIMAP_HMI_VIEW_WIDTH)))

        # Vertically the device scrolls only when the box would not fit whole on the panel,
        # so where it is looking depends on how the user arrived. The window has to cover
        # every position that keeps the focus fully visible, which is the band from a
        # viewport above the box to a viewport below it.
        band_top = focus.y + focus.h - MINIMAP_HMI_VIEW_HEIGHT
        band_bottom = focus.y + MINIMAP_HMI_VIEW_HEIGHT

        def distance(n):
            # Gap between the box and that region, as a rectangle because the panel is
            # one. A box merely touching it scores zero, so everything that could be on
            # screen sorts ahead of everything that could not.
            dx = max(0, view_x - (n.x + n.w), n.x - (view_x + MINIMAP_HMI_VIEW_WIDTH))
            dy = max(0, band_top - (n.y + n.h), n.y - band_bottom)
            return (max(dx / float(MINIMAP_HMI_VIEW_WIDTH),
                        dy / float(MINIMAP_HMI_VIEW_HEIGHT)),
                    dx + dy)

        # the key is total, so the picture is stable on 3.4's unordered dicts
        order = sorted(scene.nodes, key=lambda n: (distance(n), n.layer, n.row, n.key))

        chosen = set([focus.key])
        taken = 1 if focus.kind == KIND_PLUGIN else 0

        for n in order:
            if n.key in chosen:
                continue
            # hardware boxes do not count against the plugin budget, but they do take a
            # slot in the firmware's fixed array like everything else
            if len(chosen) >= MINIMAP_MAX_NODES:
                break
            if n.kind == KIND_PLUGIN:
                if taken >= budget:
                    continue
                taken += 1
            chosen.add(n.key)

        return chosen

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
            # Whatever we were asked to centre on is in the picture, whatever its kind.
            # _window_nodes() reasons about plugins, so a hardware box reaches the window
            # only when a cable lands on it -- but the device asked for this one by name,
            # and stepping onto a box that then fails to appear is how a walk gets stuck.
            if focus in scene.by_key:
                visible.add(focus)

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

        # N <nid> <kind> <x> <y> <w> <h> <bypassed> <layer> <row> <label> <title>
        # <title> is '=' when it would repeat <label>, which is most of the time in the
        # detail picture and costs nothing to say
        for n in nodes:
            label = n.label or '-'
            title = n.title or label
            lines.append('N %d %s %d %d %d %d %d %d %d %s %s' % (
                n.nid, n.kind, n.x, n.y, n.w, n.h,
                1 if n.bypassed else 0, n.layer, n.row, label,
                '=' if title == label else title))

        ports = 0
        for n in nodes:
            for pool in (n.inputs, n.outputs):
                for p in pool:
                    if p.ptype not in mask:
                        continue
                    ports += 1
                    lines.append('P %d %d %s %s %d %d %s' % (
                        n.nid, p.pid, p.direction, p.ptype, p.x, p.y, p.symbol))

        for e, inside_src, inside_dst in shown_edges:
            coords = ' '.join('%d,%d' % (px, py) for px, py in e.points)
            lines.append('E %d %d:%d %d:%d %s %d %d %s' % (
                e.eid, e.src.nid, e.src_port.pid, e.dst.nid, e.dst_port.pid,
                e.etype, 0 if inside_src else 1, 0 if inside_dst else 1, coords))

        for line in self._adjacency(scene.nodes, nodes):
            lines.append(line)

        # Records joined by a standalone separator token rather than by newlines: the HMI
        # protocol splits a message on spaces only, so a newline would be glued onto the
        # neighbouring token. One line, unambiguous either way -- see RECORD_SEP.
        text = (' ' + RECORD_SEP + ' ').join(lines) + ' ' + RECORD_SEP

        if windowed and budget > 1 and (len(text) > MINIMAP_MAX_MSG
                                        or len(nodes) > MINIMAP_MAX_NODES
                                        or ports > MINIMAP_MAX_PORTS
                                        or len(shown_edges) > MINIMAP_MAX_EDGES):
            # Shrink and retry rather than emit a message the firmware's 4K buffer would
            # drop, or more records than one of its fixed arrays can hold -- it keeps what
            # fits and drops the rest without a word, so a box or a cable just vanishes.
            return self.render(host, focus, layers, budget - 1)

        self._emitted[cache_key] = text
        return (text, self._version)

    @staticmethod
    def _adjacency(scene_nodes, nodes):
        """Previous and next in one walk of the whole board.

        The LCD has no touch and the graph is browsed with a single encoder, so
        what the firmware needs is a sequence, not a compass: left to right by
        column, top to bottom inside a column, every box exactly once.

        Built over the *whole* scene rather than over the window. The id either
        side of a windowed node can therefore name a box that was not sent, and
        that is the point -- it is how the firmware knows to ask for the next
        window instead of stopping dead at the edge of this one. The previous
        four-way version resolved neighbours within the window only, so a box
        outside it was simply unreachable, and which boxes those were changed
        every time the window moved.
        """
        order = sorted(scene_nodes, key=lambda n: (n.layer, n.row, n.key))
        position = dict((n.key, index) for index, n in enumerate(order))

        out = []
        for n in nodes:
            index = position[n.key]
            previous = order[index - 1].nid if index > 0 else -1
            following = order[index + 1].nid if index + 1 < len(order) else -1
            out.append('A %d %d %d' % (n.nid, previous, following))

        return out

    def connections(self, host, nid, bits=0):
        """The lines in and out of one box, the way the connection menu lists them.

        One entry per box at the far end and per signal type, never one per pair of
        ports: a stereo pair is one line on the picture and one line in the menu, and
        deleting it means dropping both cables. The compact picture already collapses
        that way, so this only has to deduplicate for the detail one.
        """
        scene = self.scene(host)
        wanted = types_from_bits(bits)

        out = []
        seen = set()
        for e in scene.edges:
            if e.etype not in wanted:
                continue
            if e.src.nid == nid:
                direction, other = 'o', e.dst
            elif e.dst.nid == nid:
                direction, other = 'i', e.src
            else:
                continue

            key = (direction, other.nid, e.etype)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                'direction': direction,
                'nid': other.nid,
                'type': e.etype,
                'bits': dict(TYPE_BITS).get(e.etype, 0),
                'label': other.title or other.label or '-',
                'layer': other.layer,
                'row': other.row,
                'key': other.key,
            })

        # what feeds this box first, then what it feeds, alphabetical inside each
        out.sort(key=lambda c: (c['direction'] != 'i', c['label'], c['key']))
        out = out[:MINIMAP_MAX_MENU]

        # the individual cables behind each line, for the strip under the menu. Budgeted
        # over the visible rows, which is why it happens after the truncation and not
        # inside the loop above.
        pairs = self._cable_pairs(host, nid, wanted)
        budget = MINIMAP_MAX_PAIRS
        for entry in out:
            got = pairs.get((entry['direction'], entry['nid'], entry['type']), [])
            entry['pairs'] = got[:budget]
            budget -= len(entry['pairs'])

        return out

    def _cable_pairs(self, host, nid, wanted):
        """The individual cables behind the collapsed menu lines, keyed the way they are.

        The lines come from whichever scene is on screen, and the compact one has already
        merged a stereo pair into a single cable -- the two ports behind it are gone by
        the time connections() sees it. The detail scene still has them and numbers its
        boxes the same way, so the cables are counted there and handed back per line.
        """
        pairs = {}
        for e in instance_for(MODE_DETAIL).scene(host).edges:
            if e.etype not in wanted:
                continue
            if e.src.nid == nid:
                key = ('o', e.dst.nid, e.etype)
            elif e.dst.nid == nid:
                key = ('i', e.src.nid, e.etype)
            else:
                continue

            bucket = pairs.setdefault(key, [])
            if len(bucket) >= MINIMAP_MAX_ROW_PAIRS:
                continue

            # The feeding end first, whichever side of the cable we are on: the strip
            # reads out -> in, so which of the two names is the output never moves.
            bucket.append((sanitize_label(e.src_port.symbol, PAIR_W),
                           sanitize_label(e.dst_port.symbol, PAIR_W)))
        return pairs

    def candidates(self, host, nid, bits=0, want_outputs=True):
        """The boxes that could meet one of our ports.

        The side is the caller's: having picked one of our own ports first, we know what
        the far end has to be -- our input wants somebody's output, our output wants
        somebody's input. A cable joins an output to an input and never two of a kind, so
        offering both ways round here would be offering half of them wrong.

        Boxes already wired to us stay on the list: the port comes next, and a stereo pair
        is wired one side at a time. A cable that already exists is refused later, by
        connect_port, where the ports are known.
        """
        scene = instance_for(MODE_DETAIL).scene(host)
        wanted = types_from_bits(bits)

        ours = None
        for node in scene.nodes:
            if node.nid == nid:
                ours = node
                break
        if ours is None:
            return []

        # their output feeding us reads "BOX >", our output feeding them reads "> BOX"
        direction = 'i' if want_outputs else 'o'

        out = []
        for node in scene.nodes:
            if node.nid == nid:
                continue

            pool = node.outputs if want_outputs else node.inputs
            for ptype in sorted(set(p.ptype for p in pool if p.ptype in wanted)):
                out.append({
                    'direction': direction,
                    'nid': node.nid,
                    'type': ptype,
                    'bits': dict(TYPE_BITS).get(ptype, 0),
                    'label': node.title or node.label or '-',
                    'layer': node.layer,
                    'row': node.row,
                    'key': node.key,
                })

        # Alphabetical. Ordering by where a box sits in the picture puts the likely one on
        # top, but twenty rows arranged by graph distance read as no order at all -- there
        # is no way to guess where a name will be, and no way to go back to it.
        out.sort(key=lambda entry: (entry['label'], entry['key']))

        # the device holds a fixed number of rows; anything past that would be dropped on
        # arrival without a word, so it is cut here where the count is known
        return out[:MINIMAP_MAX_MENU]

    def ports(self, host, nid, bits=0, outputs=True):
        """One side of a box's ports, in the shape the connection menus already use.

        The index is the position in this very list, and it is what connect_port() takes
        back: the device never sees a symbol, so the two have to agree on the ordering,
        and the ordering is the one the plugin declares.
        """
        scene = instance_for(MODE_DETAIL).scene(host)
        wanted = types_from_bits(bits)

        node = None
        for candidate in scene.nodes:
            if candidate.nid == nid:
                node = candidate
                break
        if node is None:
            return []

        # `outputs` None asks for both sides, inputs first: that is the list the device
        # shows of our own ports, and the direction letter is how it tells them apart
        if outputs is None:
            sides = ((False, node.inputs), (True, node.outputs))
        else:
            sides = ((outputs, node.outputs if outputs else node.inputs),)

        out = []
        for side, pool in sides:
            # Numbered within its own side, not across the pair. The index is what comes
            # back from the device and gets resolved against one side's list, so counting
            # across both would send the caller looking for a port that is not there. The
            # direction letter is what tells the two apart, and the device keeps it.
            index = 0

            for port in pool:
                if port.ptype not in wanted:
                    continue
                out.append({
                    # a port that feeds reads "PORT >", one that is fed reads "> PORT"
                    'direction': 'i' if side else 'o',
                    'index': index,
                    'type': port.ptype,
                    'bits': dict(TYPE_BITS).get(port.ptype, 0),
                    'label': sanitize_label(port.symbol, TITLE_W),
                    'symbol': port.symbol,
                })
                index += 1

        return out[:MINIMAP_MAX_MENU]

    def connect_port(self, host, from_nid, from_index, to_nid, to_index, bits=0):
        """The one cable behind picking a port: source end, target end, done.

        An index of -1 is the end the device did not ask about, and is filled with the
        least used port of the right type. Least used rather than first: wiring a stereo
        box twice then fills both its sides instead of doubling up on one.
        """
        scene = instance_for(MODE_DETAIL).scene(host)

        source = self._pick_port(host, scene, from_nid, from_index, bits, True)
        target = self._pick_port(host, scene, to_nid, to_index, bits, False)

        if source is None or target is None:
            return []

        link = (source, target)
        if link in set(tuple(c) for c in getattr(host, 'connections', ())):
            return []

        return [link]

    def _pick_port(self, host, scene, nid, index, bits, outputs):
        """The endpoint string for one end, choosing it when the device did not."""
        node = None
        for candidate in scene.nodes:
            if candidate.nid == nid:
                node = candidate
                break
        if node is None:
            return None

        listed = self.ports(host, nid, bits, outputs)
        if not listed:
            return None

        if index >= 0:
            if index >= len(listed):
                return None
            chosen = listed[index]['symbol']
        else:
            used = {}
            for connection in getattr(host, 'connections', ()):
                for endpoint in connection:
                    used[endpoint] = used.get(endpoint, 0) + 1

            chosen = min(listed,
                         key=lambda p: (used.get(_endpoint_symbol(node, p['symbol']), 0),
                                        p['index']))['symbol']

        return _endpoint_symbol(node, chosen)

    def links_between(self, host, from_nid, to_nid, bits=0):
        """The real port-to-port cables behind one line of the picture.

        Taken from the detail scene, where the ports were never collapsed, so the
        endpoints come back in exactly the form Host.disconnect() expects. Node ids are
        the mapper's instance ids and do not depend on the mode, so they match whatever
        the device is looking at.
        """
        scene = instance_for(MODE_DETAIL).scene(host)
        wanted = types_from_bits(bits)

        out = []
        for e in scene.edges:
            if e.etype not in wanted:
                continue
            if e.src.nid != from_nid or e.dst.nid != to_nid:
                continue
            out.append((_endpoint(e.src, e.src_port), _endpoint(e.dst, e.dst_port)))
        return out

    def splice_plan(self, host, nid, channels):
        """Where a new box would go if it were dropped into the cable leaving this one.

        Adding a plugin from the device is a two-second job and wiring it up afterwards is
        not, so the obvious case does itself: a box feeding one other box, and a new one
        with the same number of channels, goes in between and inherits the cable.

        "The same number of channels" is a count of cables, not of ports: a mono box
        feeding a stereo one over two cables is a two-channel run, and a stereo plugin
        splices into it by taking that one output into both of its inputs and then meeting
        the far box port for port. What the near end did, the new box goes on doing.

        A stereo box into a run of one cable is the other way round again: the cable feeds
        both of its inputs and both of its outputs meet the one input at the far end. The
        split and the sum cancel, so what reached the far box before still reaches it.

        Only the obvious case. The moment there is a choice to make -- a box that fans out,
        a far end that sums several sources, a run with as many cables as the new box has
        channels but nothing in it to say which channel is which, anything that is not
        audio -- guessing wrong costs the user more than doing nothing, and doing nothing
        leaves them exactly where they were before: a new box, unconnected, and the
        connection manager to wire it with.

        Returns None, or the cables to take over and the canvas spot to sit in.
        """
        if nid is None or nid == NO_NODE or channels < 1:
            return None

        scene = instance_for(MODE_DETAIL).scene(host)

        source = None
        for node in scene.nodes:
            if node.nid == nid:
                source = node
                break
        if source is None:
            return None

        outgoing = [e for e in scene.edges if e.src is source]

        # a box wired to nothing has no cable to be spliced into
        if not outgoing:
            return None

        # audio only: "the same number of channels" is an audio idea, and a chain
        # carrying MIDI or CV alongside it is not one to rearrange unasked
        if any(e.etype != TYPE_AUDIO for e in outgoing):
            return None

        target = outgoing[0].dst

        # fanning out means choosing which cable to take, which is the user's choice
        if any(e.dst is not target for e in outgoing):
            return None
        if target is source:
            return None

        # ... and a far end fed by more than us is a mixing point, not a chain
        if any(e.src is not source for e in scene.edges if e.dst is target):
            return None

        # A stereo box dropped into a single cable splits at its inputs and sums again at
        # its outputs, which leaves the far box hearing what it heard before. Nothing else
        # gets to differ: stereo into a mono plugin would have to fold two signals into one
        # and throw the difference away, and that is a decision, not a default.
        doubled = (channels == 2 and len(outgoing) == 1)

        if not doubled and len(outgoing) != channels:
            return None

        # One side has to have a port for every cable, or there is nothing to pair the
        # new box off against. Both sides do in a plain stereo run. A mono box feeding a
        # stereo one repeats its single output across the two inputs, and there it is the
        # far end that says which cable is which -- and the other way round for a stereo
        # box summed into a mono one. Only a run that repeats ports at both ends at once
        # is left alone, because then nothing in it names the channels.
        sources = set(id(e.src_port) for e in outgoing)
        sinks = set(id(e.dst_port) for e in outgoing)
        if len(sources) != len(outgoing) and len(sinks) != len(outgoing):
            return None

        # left to right in the order the boxes declare their ports, so a stereo pair comes
        # out L to L and R to R rather than crossed. The far end breaks the tie when the
        # near one repeats a port, which is the mono-into-stereo case above.
        from_order = dict((id(p), i) for i, p in enumerate(source.outputs))
        to_order = dict((id(p), i) for i, p in enumerate(target.inputs))
        outgoing.sort(key=lambda e: (from_order.get(id(e.src_port), 0),
                                     to_order.get(id(e.dst_port), 0)))

        x, y = self._splice_position(host, source, target)

        cut = [(_endpoint(e.src, e.src_port), _endpoint(e.dst, e.dst_port))
               for e in outgoing]

        # `cut` is the cables to drop and `links` the channels of the new box, one entry
        # each. The two differ only for the split-and-sum above, where both channels come
        # off the same cable and it must not be dropped twice.
        return {
            'cut': cut,
            'links': (cut + cut) if doubled else cut,
            'x': x,
            'y': y,
        }

    def unsplice_plan(self, host, nid):
        """The cables that close the gap when a box in the middle of a chain is removed.

        The inverse of splice_plan, and refused on the same terms: one box feeding it, one
        box fed by it, audio only, and a port of its own for every cable on each side so
        the two ends pair off without anything being guessed. Everything else is left open
        -- a box that fanned out was carrying a decision, and closing over it would be
        inventing one on the way past.

        The old cables die with the box, so there is nothing here to cut: only what to lay
        once it is gone.
        """
        if nid is None or nid == NO_NODE:
            return None

        scene = instance_for(MODE_DETAIL).scene(host)

        node = None
        for candidate in scene.nodes:
            if candidate.nid == nid:
                node = candidate
                break
        if node is None:
            return None

        incoming = [e for e in scene.edges if e.dst is node]
        outgoing = [e for e in scene.edges if e.src is node]

        # at either end of a chain there is nothing on one side to join to the other
        if not incoming or not outgoing:
            return None

        # as many cables out as in, or which channel meets which is a guess
        if len(incoming) != len(outgoing):
            return None

        if any(e.etype != TYPE_AUDIO for e in incoming):
            return None
        if any(e.etype != TYPE_AUDIO for e in outgoing):
            return None

        source = incoming[0].src
        target = outgoing[0].dst

        if any(e.src is not source for e in incoming):
            return None
        if any(e.dst is not target for e in outgoing):
            return None
        if source is target:
            return None

        # our own ports are what number the channels, so each has to appear once
        if len(set(id(e.dst_port) for e in incoming)) != len(incoming):
            return None
        if len(set(id(e.src_port) for e in outgoing)) != len(outgoing):
            return None

        into = dict((id(p), i) for i, p in enumerate(node.inputs))
        out_of = dict((id(p), i) for i, p in enumerate(node.outputs))

        incoming.sort(key=lambda e: into.get(id(e.dst_port), 0))
        outgoing.sort(key=lambda e: out_of.get(id(e.src_port), 0))

        # Channel by channel, and deduplicated: a stereo box between two mono ends carries
        # both its channels on the same cable at either end, so closing over it is the one
        # cable it was dropped into coming back.
        links = []
        for feed, drain in zip(incoming, outgoing):
            link = (_endpoint(feed.src, feed.src_port),
                    _endpoint(drain.dst, drain.dst_port))
            if link not in links:
                links.append(link)

        return {'links': links}

    def _splice_position(self, host, source, target):
        """A canvas spot between the two boxes the new one comes between.

        Halfway, when both ends are plugins and so have somewhere to be halfway between.
        Hardware has no canvas position of its own -- capture and playback sit outside it
        -- so a chain that starts or ends at one is measured from the plugin end instead.
        """
        plugins = getattr(host, 'plugins', {})

        def at(node):
            if node.kind != KIND_PLUGIN:
                return None
            data = plugins.get(node.nid)
            if not data:
                return None
            try:
                return (int(data['x']), int(data['y']))
            except (KeyError, TypeError, ValueError):
                return None

        here, there = at(source), at(target)

        if here and there:
            return ((here[0] + there[0]) // 2, (here[1] + there[1]) // 2)
        if here:
            return (here[0] + CANVAS_STEP, here[1])
        if there:
            return (max(0, there[0] - CANVAS_STEP), there[1])

        return (0, 0)

    def info(self, host):
        scene = self.scene(host)
        return {
            'mode': self.mode,
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


# One instance per representation, each holding its own cached scene: the HMI and
# the browser debug view can ask for different pictures without evicting each other.
_INSTANCES = {}


def instance_for(mode=None):
    name = normalize_mode(mode)
    inst = _INSTANCES.get(name)
    if inst is None:
        inst = Minimap(name)
        _INSTANCES[name] = inst
    return inst


INSTANCE = instance_for(MINIMAP_MODE)
