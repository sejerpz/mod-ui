#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pedalboard plugin_map: a compact scene description of the live plugin graph.

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

from mod import plugin_map_font as font
from mod.settings import (
    PEDALBOARD_INSTANCE_ID,
    PLUGIN_MAP_MAX_WIDTH,
    PLUGIN_MAP_MAX_HEIGHT,
    PLUGIN_MAP_VIEW_WIDTH,
    PLUGIN_MAP_VIEW_HEIGHT,
    PLUGIN_MAP_HMI_VIEW_WIDTH,
    PLUGIN_MAP_HMI_VIEW_HEIGHT,
    PLUGIN_MAP_LAYERS,
    PLUGIN_MAP_MAX_MSG,
    PLUGIN_MAP_MAX_NODES,
    PLUGIN_MAP_MAX_PORTS,
    PLUGIN_MAP_MAX_EDGES,
    PLUGIN_MAP_MAX_MENU,
    PLUGIN_MAP_MAX_LIST,
    PLUGIN_MAP_MAX_PAIRS,
    PLUGIN_MAP_MAX_ROW_PAIRS,
    PLUGIN_MAP_WIN_PLUGINS,
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
# Where a plugin added from the device goes on the web canvas. A box is as big as its
# modgui, which the screenshot in its bundle gives to the pixel; one without a
# screenshot gets the guess the web UI makes for a box it has not drawn yet.
CANVAS_BOX = (350, 450)  # a box of unknown size
CANVAS_GAP = 200         # between two boxes side by side: their jacks and some air

# BM_NONE in the firmware: the id that means no box at all. Hardware takes the
# negative half of the id space from -2 down, so a negative id is not on its own a
# refusal -- IN1 is as spliceable as anything else.
NO_NODE = -1


# ---------------------------------------------------------------------------
# representations
# ---------------------------------------------------------------------------



class Style(object):
    """Geometry for the picture: box sizes, gutters, how much room a stub takes.

    One of these, because there is one picture. There used to be a port-accurate style
    beside it -- every cable drawn, boxes sized to hold their stubs -- and on a 124 pixel
    panel it was unreadable, so nothing ever shipped with it. What the port-accurate view
    was really needed for was not the drawing but the model behind it, and that is what
    PluginMap.model() hands out now.
    """

    __slots__ = ('cell_w', 'hw_cell_w', 'min_cell_h', 'port_pitch',
                 'cell_pad_v', 'gut_x', 'gut_y')

    def __init__(self, cell_w, hw_cell_w, min_cell_h, port_pitch,
                 cell_pad_v, gut_x, gut_y):
        self.cell_w = cell_w
        self.hw_cell_w = hw_cell_w
        self.min_cell_h = min_cell_h
        self.port_pitch = port_pitch
        self.cell_pad_v = cell_pad_v
        self.gut_x = gut_x
        self.gut_y = gut_y


# "What feeds what". A stereo pair is one line, four cables into a mixer are one line, and
# boxes are all the same small size -- roughly twice as much board on screen as drawing
# every cable would give, at the cost of not showing which port goes where. Which port goes
# where is a question for the connection menu, and it asks model() rather than the picture.
STYLE = Style(24, 22, 11, 4, 4, 10, 7)

# How far into a hardware box its point cuts. The tip lands on the middle row, which is
# exactly where the stub sits, so a cable runs into the point rather than alongside it.
# Five on an eleven row box is a true 45 degrees, the only slope that draws clean on a
# panel with no grey to soften a staircase.
HW_POINT = 5

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

# The bits the firmware uses for the same three, in app/inc/plugin_map.h. The connection
# commands speak in these because the HMI protocol carries integers, not names.
TYPE_BITS = ((TYPE_AUDIO, 1), (TYPE_MIDI, 2), (TYPE_CV, 4))


def types_from_bits(bits):
    """BM_AUDIO | BM_MIDI | BM_CV -> the type letters they stand for."""
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
                 'lane', 'lane_count', 'channel', 'bundle', 'arrival')

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
        self.bundle = None
        self.arrival = None


_GUI_SIZES = {}


def gui_size(uri):
    """(width, height) of a plugin's box on the web canvas, from its modgui screenshot.

    Read off the PNG header -- 24 bytes, not the image -- and kept per URI, since a
    plugin's GUI does not change while mod-ui runs.
    """
    size = _GUI_SIZES.get(uri)
    if size is not None:
        return size

    size = CANVAS_BOX
    try:
        from modtools.utils import get_plugin_gui_mini
        path = get_plugin_gui_mini(uri).get('screenshot')
        if path:
            with open(path, 'rb') as fh:
                head = fh.read(24)
            if head[:8] == b'\x89PNG\r\n\x1a\n':
                width = int.from_bytes(head[16:20], 'big')
                height = int.from_bytes(head[20:24], 'big')
                if width > 0 and height > 0:
                    size = (width, height)
    except Exception:
        pass

    _GUI_SIZES[uri] = size
    return size


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
# PluginMap
# ---------------------------------------------------------------------------

class PluginMap(object):
    def __init__(self):
        self.style = STYLE
        self._fingerprint = None
        self._scene = None
        self._model_fingerprint = None
        self._model = None
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

    def model(self, host):
        """The graph before anything is merged or placed: every port, every cable.

        The picture merges a stereo pair into one line and one stub, which is what makes it
        readable and what makes it useless for answering "which port feeds which". Every
        question about actual ports -- what a menu line stands for, what a box could be
        wired to, what a cable really is -- is asked here instead.

        Built fresh rather than shared with scene(): _collapse() empties a node's port list
        in place and _layout() writes coordinates onto the same objects, so handing out the
        same model would hand out one that is about to be taken apart.
        """
        fp = self.fingerprint(host)
        if fp != self._model_fingerprint or self._model is None:
            self._model = self._build_model(host)
            self._model_fingerprint = fp
        return self._model

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
        """Where a device opening the plugin_map should start.

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
                # A connection naming a port the plugin does not have should not reach us,
                # but it does when the LV2 lookup and the pedalboard disagree about what a
                # plugin has. Drop it rather than drawing a cable to nowhere -- and say
                # which end failed and what that box does have, because a cable silently
                # missing from the picture is the worst outcome there is for an editor.
                self._report_unresolved(by_key, conn, src, dst)
                continue
            etype = src[1].ptype if src[1].ptype != TYPE_AUDIO else dst[1].ptype
            edges.append(Edge(src[0], src[1], dst[0], dst[1], etype))

        return (nodes, edges, by_key)

    @staticmethod
    def _report_unresolved(by_key, conn, src, dst):
        """Name the end that could not be found, and what that box actually has."""
        for endpoint, resolved, side in ((conn[0], src, 'o'), (conn[1], dst, 'i')):
            if resolved is not None:
                continue

            parsed = parse_endpoint(endpoint)
            node = by_key.get(parsed[1]) if parsed and parsed[0] != 'hw' else None

            if node is None:
                logging.warning("[plugin_map] connection '%s' -> '%s': no box named '%s'",
                                conn[0], conn[1], endpoint)
                continue

            pool = node.outputs if side == 'o' else node.inputs
            logging.warning("[plugin_map] connection '%s' -> '%s': %s has no %s port '%s'"
                            " -- it declares %s",
                            conn[0], conn[1], node.key,
                            'output' if side == 'o' else 'input',
                            parsed[2],
                            ', '.join(p.symbol for p in pool) or 'none')

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

        """
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

        self._pull_late(plugins, edges)

        columns = {}
        for n in nodes:
            columns.setdefault(n.layer, []).append(n)

        self._order_rows(columns, edges)

        # sizes
        style = self.style
        # every box the same size: the stubs have been merged by now, so there is nothing
        # left for a box to be taller than another one about
        for n in nodes:
            # The two ends of the world are drawn pointed, so the picture does not open and
            # close on what look like two more plugins. The point costs width, so the label
            # slot is measured on the straight part of the box.
            pointed = n.kind in (KIND_HW_SRC, KIND_HW_SINK)
            n.w = style.hw_cell_w if pointed else style.cell_w
            n.h = style.min_cell_h
            n.label = sanitize_label(n.raw_label,
                                     n.w - HW_POINT - 2 if pointed else n.w - 4)
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
        width = min(content_w + MARGIN * 2, PLUGIN_MAP_MAX_WIDTH)
        height = min(content_h + MARGIN * 2, PLUGIN_MAP_MAX_HEIGHT)

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

        self._assign_lanes(scene, edges, ())
        self._assign_channels(scene, edges, nodes)

        # A bundle can turn out to draw no vertical at all in the gutter it was given a
        # lane in: a long cable whose band is already its own stub's row leaves straight,
        # and so does a short one level with its target. It was still holding a lane and
        # pushing the cables that do turn off the centre line, for a corner nobody draws.
        # Hand the lanes out again without them, and keep the result only if it still
        # agrees with itself.
        idle = self._idle_bundles(scene, edges)
        if idle:
            keep = [(e.lane, e.lane_count, e.channel) for e in edges]

            self._assign_lanes(scene, edges, idle)
            self._assign_channels(scene, edges, nodes)

            if self._idle_bundles(scene, edges) != idle:
                # The new lanes moved a cable onto a different band, so the bundles that
                # draw nothing are no longer the ones the lanes were handed out for. The
                # first pass is coherent with itself; take that rather than chase a fixed
                # point that may not exist.
                for e, (lane, count, channel) in zip(edges, keep):
                    e.lane = lane
                    e.lane_count = count
                    e.channel = channel

        self._merge_arrivals(scene, edges, nodes)

        for index, e in enumerate(edges):
            e.eid = index
            e.points = self._route(e, scene)

        scene.nodes = nodes
        scene.edges = edges
        scene.by_key = by_key
        scene.plugin_count = len(plugins)
        return scene

    @staticmethod
    def _assign_lanes(scene, edges, idle):
        """Give each bundle its own turning column inside the gutter it leaves by.

        Bundles, per gutter: everything leaving one box travels together, and so does
        everything arriving at one box. A cable belongs to its source's bundle when that
        source fans out, and to its target's otherwise, which is what makes a split and a
        merge each collapse onto a single turning column.

        Bundles named in `idle` draw no vertical there and so cannot collide with anyone:
        they are handed the centre and left out of the count, which gives the cables that
        do turn the room they were being denied.
        """
        gutters = {}
        order = []
        for e in edges:
            if e.src.layer not in gutters:
                gutters[e.src.layer] = []
                order.append(e.src.layer)
            gutters[e.src.layer].append(e)

        for layer in sorted(order):
            group = gutters[layer]

            fanout = {}
            for e in group:
                fanout[e.src.key] = fanout.get(e.src.key, 0) + 1

            for e in group:
                e.bundle = (layer, e.src.key if fanout[e.src.key] > 1 else e.dst.key)

            slots = {}
            for e in group:
                if e.bundle in idle:
                    continue
                if e.bundle not in slots:
                    slots[e.bundle] = len(slots)

            count = max(1, len(slots))
            middle = (count - 1) // 2
            for e in group:
                e.lane = slots.get(e.bundle, middle)
                e.lane_count = count

    def _assign_channels(self, scene, edges, nodes):
        """Pick the horizontal band each cable that skips columns crosses on.

        Without a row grid there is no set of corridors to draw from, so each one is
        looked up in the layout as it actually came out: the free bands between the boxes
        standing in its way. Cables already using a band step aside from each other.
        """
        used = {}
        for e in edges:
            e.channel = None

        # The short cables have not been routed yet, but where they run horizontally is
        # already known: out of a stub at its own height, as far as the column they turn
        # on, then in at the far stub's height. Reserved here so a crossing cable does not
        # come to rest on the same row as one of them -- it never touches a box, so the
        # clearance check says nothing, but two cables sharing a row and meeting end to end
        # read as one line, and the picture then shows a cable leaving a box it never left.
        for e in edges:
            if e.dst.layer - e.src.layer > 1:
                continue

            sx = e.src_port.x + 1
            tx = e.dst_port.x - 1
            turn = self._turn(e, scene, sx, tx)

            used.setdefault(e.src_port.y, []).append((id(e.src_port), min(sx, turn),
                                                      max(sx, turn)))
            used.setdefault(e.dst_port.y, []).append((id(e.dst_port), min(turn, tx),
                                                      max(turn, tx)))

        # Long cables off the same stub take one band between them. The picture has already
        # merged their ports into a single stub, so it says they leave the same point:
        # drawing them apart for the width of the board contradicts it. One trunk, forking
        # where the destinations actually differ.
        groups = []
        by_stub = {}
        for e in edges:
            if e.dst.layer - e.src.layer <= 1:
                continue
            stub = id(e.src_port)
            if stub not in by_stub:
                by_stub[stub] = []
                groups.append(by_stub[stub])
            by_stub[stub].append(e)

        for group in groups:
            band = self._free_band(group, scene, nodes, used)
            if band is None and len(group) > 1:
                # Nothing clear for the whole trunk, which one long cable of the group can
                # still be too little room for while a shorter one has plenty. Each on its
                # own band beats sending them all back to the plain elbow.
                for e in group:
                    e.channel = self._free_band([e], scene, nodes, used)
                continue
            for e in group:
                e.channel = band

    @staticmethod
    def _idle_bundles(scene, edges):
        """The bundles none of whose cables draw a vertical in their gutter.

        Mirrors _route(): a cable is only holding its lane down if it really turns on it.
        """
        busy = set()
        seen = set()
        for e in edges:
            seen.add(e.bundle)
            if PluginMap._turns_in_gutter(e, scene):
                busy.add(e.bundle)
        return frozenset(seen - busy)

    @staticmethod
    def _turns_in_gutter(edge, scene):
        """Whether _route() will draw a vertical on this cable's turning column."""
        sx = edge.src_port.x + 1
        sy = edge.src_port.y
        tx = edge.dst_port.x

        if edge.channel is not None:
            out_x = PluginMap._turn(edge, scene, sx, tx)
            if tx - LONG_INSET > out_x:
                return edge.channel != sy

        if tx > sx + 2:
            return sy != edge.dst_port.y

        # the feedback detour turns below the scene, on a column of its own
        return False

    def _merge_arrivals(self, scene, edges, nodes):
        """Bring a long cable's arrival onto a turning column already in use, where the
        merged line still tells the truth.

        A cable that skips columns steps in at a fixed inset from the far stub, knowing
        nothing about the cables turning in the same gutter. When one of them turns a pixel
        away, the two verticals already read as a single thick line -- the picture has
        merged them, badly. Sharing the column draws that as one clean line instead.

        Only where it is honest, because a shared vertical is a junction: everything
        tapping it looks connected to everything it touches. The merge is allowed only when
        every source on the column really does reach every stub the column runs past --
        otherwise the picture claims a connection the graph does not have, which is worse
        than a thick line. Nothing else needs checking: the gutter holds no boxes.
        """
        wired = set()
        for e in edges:
            wired.add((id(e.src_port), id(e.dst_port)))

        # the input stubs each column offers, to read off what a merged line would claim
        column_stubs = {}
        for n in nodes:
            for p in n.inputs:
                column_stubs.setdefault(p.x, []).append(p)

        # verticals the short cables already draw, by gutter and column
        turning = {}
        for e in edges:
            if e.dst.layer - e.src.layer != 1:
                continue
            if e.dst_port.x <= e.src_port.x + 3:
                continue                        # the feedback detour turns elsewhere
            if e.src_port.y == e.dst_port.y:
                continue                        # straight, draws no vertical
            x0 = self._turn(e, scene, e.src_port.x + 1, e.dst_port.x)
            turning.setdefault((e.dst.layer, x0), []).append(
                (min(e.src_port.y, e.dst_port.y), max(e.src_port.y, e.dst_port.y),
                 e.src_port))

        for edge in edges:
            if edge.channel is None:
                continue

            tx = edge.dst_port.x
            in_x = tx - LONG_INSET
            if in_x <= self._turn(edge, scene, edge.src_port.x + 1, tx):
                continue                        # not drawn on its band at all

            lo = min(edge.channel, edge.dst_port.y)
            hi = max(edge.channel, edge.dst_port.y)
            if lo == hi:
                continue                        # arrives level with its band: no vertical

            for x0 in sorted(x for layer, x in turning if layer == edge.dst.layer):
                # leftwards only: the band was reserved as far as the old inset, and a
                # column further right would run past what was kept clear for it
                if x0 >= in_x:
                    continue

                span_lo, span_hi = lo, hi
                meets = False
                for a, b, _ in turning[(edge.dst.layer, x0)]:
                    if a < span_hi and span_lo < b:
                        meets = True
                    span_lo = min(span_lo, a)
                    span_hi = max(span_hi, b)

                if not meets:
                    # two separate stretches of one column stay two cables: the merge would
                    # buy no ink and still risk reading as a junction
                    continue

                sources = set([id(edge.src_port)])
                sources.update(id(port) for _, _, port in turning[(edge.dst.layer, x0)])

                honest = True
                for stub in column_stubs.get(tx, ()):
                    if not (span_lo <= stub.y <= span_hi):
                        continue
                    for src in sources:
                        if (src, id(stub)) not in wired:
                            honest = False
                            break
                    if not honest:
                        break

                if honest:
                    edge.arrival = x0
                    turning[(edge.dst.layer, x0)].append((lo, hi, edge.src_port))
                    break

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
    def _pull_late(plugins, edges):
        """Slide every plugin forward until it sits just before what it feeds.

        Longest-path layering puts a box as early as its inputs allow, which is right for
        the main chain but wrong for anything hanging off it: a player or a click track
        feeds one box near the end and gets parked in the first column anyway, with a cable
        crossing the whole picture to say nothing but "connected".

        The critical path cannot move -- for a box on it, as late as possible and as early
        as possible are the same column -- so this only touches the boxes that have slack,
        and the chain the eye follows is left exactly where it was.

        Two guards make it safe to run once and forget: only consumers on a strictly later
        layer count, so a feedback loop can never drag a box backwards, and running it a
        second time would change nothing.
        """
        movable = set(n.key for n in plugins)
        succ = {}
        for n in plugins:
            succ[n.key] = []
        for e in edges:
            if e.src.key in movable and e.src.key != e.dst.key:
                succ[e.src.key].append(e.dst)

        # deepest first, so a box is only moved once everything it feeds has settled
        for n in sorted(plugins, key=lambda n: (-n.layer, n.key)):
            after = [t.layer for t in succ[n.key] if t.layer > n.layer]
            if after:
                n.layer = min(after) - 1

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
    def _free_band(group, scene, nodes, used):
        """One horizontal band a set of cables off the same stub can all cross on.

        Looks at the boxes actually standing between the ends and takes the gaps between
        them, nearest the stub they leave by first. `used` remembers the bands other
        crossing cables have taken over the same stretch, so two of them do not end up
        drawn on top of each other. None when the boxes leave no gap at all, and the caller
        falls back to the ordinary route.

        The whole group shares one band, which is what makes several cables out of one stub
        read as a trunk that forks: they leave together and each steps aside at its own end.
        The band therefore has to be clear over the union of their runs, not just one.
        """
        edge = group[0]

        # The stretch the cables really lie on, which _route() draws from the column they
        # turn out on to LONG_INSET short of the far stub -- not from stub to stub. Asking
        # for the whole span had a band refused over a conflict in the last three pixels,
        # where the cable has already left it and stepped across to its own stub.
        spans = []
        for e in group:
            out_x = PluginMap._turn(e, scene, e.src_port.x + 1, e.dst_port.x)
            spans.append((out_x, e.dst_port.x - LONG_INSET))

        left = min(min(a, b) for a, b in spans)
        right = max(max(a, b) for a, b in spans)

        ends = set(id(e.dst) for e in group)
        blocked = []
        for n in nodes:
            if n is edge.src or id(n) in ends:
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

        own = set([id(edge.src_port)])
        own.update(id(e.dst_port) for e in group)

        # Nearest the stub it leaves by, not the middle of the run. A cable that sets off
        # straight and steps across at the far end draws one trunk out of the box with the
        # fork where the destinations actually differ; measuring from the middle sent two
        # cables off the same stub down opposite sides of the board, two full width lines
        # saying one thing.
        #
        # Measured on the row the cable would really take in that lane, which is one of its
        # own two ends when the lane reaches that far and the middle of the lane only
        # otherwise. A lane whose centre is a pixel nearer, but which the cable can only
        # use by leaving its stub and climbing, loses to one it can lie flat in: that is
        # what sent a cable up over the board to reach a box sitting below it.
        def lane_row(gap):
            low, high = gap
            best = None
            for y in [edge.src_port.y] + [e.dst_port.y for e in group]:
                if low < y < high - 1:
                    if best is None or abs(y - edge.src_port.y) < abs(best - edge.src_port.y):
                        best = y
            return best if best is not None else (low + high) // 2

        def crossings(row):
            """How many cables already drawn this one would step over to reach that row.

            Only the climb counts, not the run along the lane: two cables meeting head on
            in a lane are kept apart by the clash check below, while a cable crossing
            another at right angles is a junction the eye has to untangle.
            """
            total = 0
            for e in group:
                for column, from_y in (
                        (PluginMap._turn(e, scene, e.src_port.x + 1, e.dst_port.x),
                         e.src_port.y),
                        (e.dst_port.x - LONG_INSET, e.dst_port.y)):
                    lo = min(row, from_y)
                    hi = max(row, from_y)
                    for y in used:
                        if lo < y < hi:
                            for _, taken_left, taken_right in used[y]:
                                if taken_left <= column <= taken_right:
                                    total += 1
            return total

        # Nearest first, and when two lanes are the same distance away -- which is what a
        # board with no room at all comes down to, one pixel at the top and one at the
        # bottom -- the one whose climb crosses fewer cables. Without that second term the
        # tie fell to whichever lane had the smaller y, so the side the cable went round
        # was decided by nothing at all.
        gaps.sort(key=lambda g: (abs(lane_row(g) - edge.src_port.y),
                                 crossings(lane_row(g)), g[0]))

        def clear(band):
            """Whether a lane at this row is free of the cables already drawn.

            Not the same row only: a row apart, two cables read as one thick line on a
            panel this size, so they are kept CHANNEL_PITCH apart. Except cables that meet
            this group anyway -- its own stub, or the stub one of its cables is on its way
            to -- which may share the row, since they touch at that end regardless.
            """
            for near in range(band - CHANNEL_PITCH + 1, band + CHANNEL_PITCH):
                for owner, taken_left, taken_right in used.get(near, ()):
                    if owner in own:
                        continue
                    if taken_left < right and taken_right > left:
                        return False
            return True

        def take(band):
            used.setdefault(band, []).append((id(edge.src_port), left, right))
            return band

        for low, high in gaps:
            centre = (low + high) // 2

            # A band level with one of the two stubs lets the cable leave straight and
            # costs it no corner at all; the middle of the gap is only the fallback.
            # Without this a cable whose own stub already sits in the free band still
            # stepped across to the band's centre, for a kink that bought nothing.
            candidates = [y for y in [edge.src_port.y] + [e.dst_port.y for e in group]
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
                if clear(band):
                    return take(band)

        # Nothing fitted anywhere: the boxes wall off the whole height and every lane left
        # is a single row at the edge of the picture. A cable still has to be drawn, so it
        # takes the best lane going -- but among the lanes no other cable has claimed, and
        # it is reserved like any other.
        #
        # It used to be neither. The fallback read nothing and wrote nothing, so on a board
        # that pushed two cables this far they both landed on the same row and drew as one
        # line: exactly what the clash test above exists to prevent, skipped by the one
        # path that needed it most.
        for low, high in gaps:
            band = (low + high) // 2
            if clear(band):
                return take(band)

        low, high = gaps[0]
        return take((low + high) // 2)

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
            in_x = edge.arrival if edge.arrival is not None else tx - LONG_INSET
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

        # Horizontally, exactly the viewport the device will be looking at: plugin_map_select()
        # centres the selection and plugin_map_scroll() clamps to the scene. Guessing this
        # wrong is not cosmetic -- near an edge the panel shows boxes on one side only, and
        # a window built around an unclamped centre leaves some of them out of the message.
        view_x = max(0, min(focus.x + focus.w // 2 - PLUGIN_MAP_HMI_VIEW_WIDTH // 2,
                            max(0, scene.width - PLUGIN_MAP_HMI_VIEW_WIDTH)))

        # Vertically the device scrolls only when the box would not fit whole on the panel,
        # so where it is looking depends on how the user arrived. The window has to cover
        # every position that keeps the focus fully visible, which is the band from a
        # viewport above the box to a viewport below it.
        band_top = focus.y + focus.h - PLUGIN_MAP_HMI_VIEW_HEIGHT
        band_bottom = focus.y + PLUGIN_MAP_HMI_VIEW_HEIGHT

        def distance(n):
            # Gap between the box and that region, as a rectangle because the panel is
            # one. A box merely touching it scores zero, so everything that could be on
            # screen sorts ahead of everything that could not.
            dx = max(0, view_x - (n.x + n.w), n.x - (view_x + PLUGIN_MAP_HMI_VIEW_WIDTH))
            dy = max(0, band_top - (n.y + n.h), n.y - band_bottom)
            return (max(dx / float(PLUGIN_MAP_HMI_VIEW_WIDTH),
                        dy / float(PLUGIN_MAP_HMI_VIEW_HEIGHT)),
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
            if len(chosen) >= PLUGIN_MAP_MAX_NODES:
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
            budget = budget or PLUGIN_MAP_WIN_PLUGINS
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
        # picture and costs nothing to say
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

        if windowed and budget > 1 and (len(text) > PLUGIN_MAP_MAX_MSG
                                        or len(nodes) > PLUGIN_MAP_MAX_NODES
                                        or ports > PLUGIN_MAP_MAX_PORTS
                                        or len(shown_edges) > PLUGIN_MAP_MAX_EDGES):
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
        that way, so the deduplication here is belt and braces.
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
        out = out[:PLUGIN_MAP_MAX_MENU]

        # the individual cables behind each line, for the strip under the menu. Budgeted
        # over the visible rows, which is why it happens after the truncation and not
        # inside the loop above.
        pairs = self._cable_pairs(host, nid, wanted)
        budget = PLUGIN_MAP_MAX_PAIRS
        for entry in out:
            got = pairs.get((entry['direction'], entry['nid'], entry['type']), [])
            entry['pairs'] = got[:budget]
            budget -= len(entry['pairs'])

        return out

    def _cable_pairs(self, host, nid, wanted):
        """The individual cables behind the collapsed menu lines, keyed the way they are.

        The lines come from whichever scene is on screen, and the compact one has already
        merged a stereo pair into a single cable -- the two ports behind it are gone by
        the time connections() sees it. The model still has them and numbers its boxes
        the same way, so the cables are counted there and handed back per line.
        """
        pairs = {}
        for e in self.model(host)[1]:
            if e.etype not in wanted:
                continue
            if e.src.nid == nid:
                key = ('o', e.dst.nid, e.etype)
            elif e.dst.nid == nid:
                key = ('i', e.src.nid, e.etype)
            else:
                continue

            bucket = pairs.setdefault(key, [])
            if len(bucket) >= PLUGIN_MAP_MAX_ROW_PAIRS:
                continue

            # The feeding end first, whichever side of the cable we are on: the strip
            # reads out -> in, so which of the two names is the output never moves.
            bucket.append((sanitize_label(e.src_port.symbol, PAIR_W),
                           sanitize_label(e.dst_port.symbol, PAIR_W)))
        return pairs

    def listing(self, host):
        """Every plugin on the board as a name, alphabetically: the device's list view.

        The display list is windowed around a focus, which is right for the picture and
        wrong for a list -- the alphabetical neighbours of a box are scattered all over
        the graph, so a list built from one window stops dead at the edge of it. This is
        the whole board instead, and the device asks for a window of it the way it asks
        for one of the plugin catalog.

        Plugins only. The capture and playback boxes have nothing to open, bypass or
        delete, and their cables are already in the connection menu of every plugin at
        the other end; in the list they would only push IN1 and OUT1 in among the names.
        The connection picker, where they are destinations, has a list of its own.

        Sorted on the title as the device shows it (underscores back to spaces), and on
        the scene key to keep equal names in a stable order.
        """
        scene = self.scene(host)
        out = []
        for n in scene.nodes:
            if n.kind != KIND_PLUGIN:
                continue
            title = n.title or n.label or '-'
            out.append({'nid': n.nid, 'kind': n.kind, 'title': title,
                        'key': (title.replace('_', ' '), n.key)})
        out.sort(key=lambda entry: entry['key'])
        return out

    def list_window(self, host, first, nid, count=PLUGIN_MAP_MAX_LIST):
        """A window of listing(): (total, first, position of <nid> or -1, entries).

        A negative <first> asks for the window centred on <nid>, which is how the device
        opens the list on the box it was standing on. The window is pulled back from the
        end so it is always as full as the list allows.
        """
        entries = self.listing(host)
        total = len(entries)

        position = -1
        for index, entry in enumerate(entries):
            if entry['nid'] == nid:
                position = index
                break

        if first < 0:
            first = max(position, 0) - count // 2
        first = max(0, min(first, total - count))

        return (total, first, position, entries[first:first + count])

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
        nodes, edges, _by_key = self.model(host)
        wanted = types_from_bits(bits)

        ours = None
        for node in nodes:
            if node.nid == nid:
                ours = node
                break
        if ours is None:
            return []

        # their output feeding us reads "BOX >", our output feeding them reads "> BOX"
        direction = 'i' if want_outputs else 'o'

        out = []
        for node in nodes:
            if node.nid == nid:
                continue

            pool = node.outputs if want_outputs else node.inputs
            for ptype in sorted(set(p.ptype for p in pool if p.ptype in wanted)):
                out.append({
                    'direction': direction,
                    'nid': node.nid,
                    'type': ptype,
                    'bits': dict(TYPE_BITS).get(ptype, 0),
                    # the model is never laid out, and only the layout sets title and label
                    'label': node.title or sanitize_label(node.raw_label, TITLE_W) or '-',
                    'key': node.key,
                })

        # Alphabetical. Ordering by where a box sits in the picture puts the likely one on
        # top, but twenty rows arranged by graph distance read as no order at all -- there
        # is no way to guess where a name will be, and no way to go back to it.
        out.sort(key=lambda entry: (entry['label'], entry['key']))

        # the device holds a fixed number of rows; anything past that would be dropped on
        # arrival without a word, so it is cut here where the count is known
        return out[:PLUGIN_MAP_MAX_MENU]

    def ports(self, host, nid, bits=0, outputs=True):
        """One side of a box's ports, in the shape the connection menus already use.

        The index is the position in this very list, and it is what connect_port() takes
        back: the device never sees a symbol, so the two have to agree on the ordering,
        and the ordering is the one the plugin declares.
        """
        nodes, edges, _by_key = self.model(host)
        wanted = types_from_bits(bits)

        node = None
        for candidate in nodes:
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

        return out[:PLUGIN_MAP_MAX_MENU]

    def connect_port(self, host, from_nid, from_index, to_nid, to_index, bits=0):
        """The one cable behind picking a port: source end, target end, done.

        An index of -1 is the end the device did not ask about, and is filled with the
        least used port of the right type. Least used rather than first: wiring a stereo
        box twice then fills both its sides instead of doubling up on one.
        """
        nodes, _edges, _by_key = self.model(host)

        source = self._pick_port(host, nodes, from_nid, from_index, bits, True)
        target = self._pick_port(host, nodes, to_nid, to_index, bits, False)

        if source is None or target is None:
            return []

        link = (source, target)
        if link in set(tuple(c) for c in getattr(host, 'connections', ())):
            return []

        return [link]

    def _pick_port(self, host, nodes, nid, index, bits, outputs):
        """The endpoint string for one end, choosing it when the device did not."""
        node = None
        for candidate in nodes:
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

        Taken from the model, where the ports were never collapsed, so the
        endpoints come back in exactly the form Host.disconnect() expects. Node ids are
        the mapper's instance ids and do not depend on the mode, so they match whatever
        the device is looking at.
        """
        nodes, edges, _by_key = self.model(host)
        wanted = types_from_bits(bits)

        out = []
        for e in edges:
            if e.etype not in wanted:
                continue
            if e.src.nid != from_nid or e.dst.nid != to_nid:
                continue
            out.append((_endpoint(e.src, e.src_port), _endpoint(e.dst, e.dst_port)))
        return out

    def splice_plan(self, host, nid, channels, uri=None):
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

        Returns None, or the cables to take over, the canvas spot to sit in and the boxes
        to move out of its way.
        """
        def decline(why, *args):
            """Say why out loud: from the panel a refusal and a bug look the same."""
            logging.info("[splice] box %s, %d channel(s): " + why, nid, channels, *args)
            return None

        if nid is None or nid == NO_NODE or channels < 1:
            return decline("nothing selected")

        nodes, edges, _by_key = self.model(host)

        source = None
        for node in nodes:
            if node.nid == nid:
                source = node
                break
        if source is None:
            return decline("no such box")

        outgoing = [e for e in edges if e.src is source]

        # a box wired to nothing has no cable to be spliced into
        if not outgoing:
            return decline("it feeds nothing")

        # audio only: "the same number of channels" is an audio idea, and a chain
        # carrying MIDI or CV alongside it is not one to rearrange unasked
        if any(e.etype != TYPE_AUDIO for e in outgoing):
            return decline("what it feeds is not all audio")

        sources = set(id(e.src_port) for e in outgoing)
        sinks = set(id(e.dst_port) for e in outgoing)

        # One port leaving the box is one signal, however many places it goes: the new box
        # sits in front of the split and every destination hears what it heard. Several
        # ports going to several boxes is not one chain but two, and threading a single box
        # through both would merge paths the user kept apart.
        one_signal = (len(sources) == 1)

        target = outgoing[0].dst

        if target is source:
            return decline("it feeds itself")

        # Several ports going to several boxes is not one chain but two, and threading a
        # single box through both would merge paths the user kept apart. One signal is
        # exempt: where it goes is not a choice anyone made.
        if not one_signal and any(e.dst is not target for e in outgoing):
            return decline("%d ports of it go to %d different boxes, which is two chains"
                           " rather than one",
                           len(sources), len(set(id(e.dst) for e in outgoing)))

        # a far end fed by more than us is a mixing point, not a chain
        if any(e.src is not source for e in edges if e.dst is target):
            return decline("what it feeds is fed by others too, a mixing point")

        # A stereo box dropped into a single cable splits at its inputs and sums again at
        # its outputs, which leaves the far box hearing what it heard before. Stereo into a
        # mono plugin is the one that stays refused: it would have to fold two signals into
        # one and throw the difference away, and that is a decision, not a default.
        # left to right in the order the boxes declare their ports, so a stereo pair comes
        # out L to L and R to R rather than crossed. The far end breaks the tie when the
        # near one repeats a port, which is what happens when one output feeds two inputs.
        from_order = dict((id(p), i) for i, p in enumerate(source.outputs))
        to_order = dict((id(p), i) for i, p in enumerate(target.inputs))
        outgoing.sort(key=lambda e: (from_order.get(id(e.src_port), 0),
                                     to_order.get(id(e.dst_port), 0)))

        x, y, moves = self._place(host, source, target, uri)

        cut = [(_endpoint(e.src, e.src_port), _endpoint(e.dst, e.dst_port))
               for e in outgoing]

        """
        The two sides worked out separately, and each simply adapted to however many
        channels the new box has. There used to be a case for every shape -- a plain run, a
        stereo box in a mono one, a fan out -- and they were all the same two questions
        asked twice: what feeds each input, and where does each output go.

        More ends than channels means they share one: two outputs into a mono plugin are
        summed, and one output feeding four boxes leaves the new box feeding all four.
        Fewer ends than channels means one end serves several: a mono output reaching a
        stereo plugin arrives at both of its inputs.

        Summing is a real change to the signal and the old rule refused it. It is what a
        player expects when they drop a mono pedal into a stereo run, and editing the
        cables afterwards is there for when it is not.
        """
        src_ends = []
        for source_end, _t in cut:
            if source_end not in src_ends:
                src_ends.append(source_end)

        dst_ends = []
        for _s, target_end in cut:
            if target_end not in dst_ends:
                dst_ends.append(target_end)

        if len(src_ends) >= channels:
            feed = [(end, i % channels) for i, end in enumerate(src_ends)]
        else:
            feed = [(src_ends[i % len(src_ends)], i) for i in range(channels)]

        if len(dst_ends) >= channels:
            drain = [(i % channels, end) for i, end in enumerate(dst_ends)]
        else:
            drain = [(i, dst_ends[i % len(dst_ends)]) for i in range(channels)]

        return {
            'cut': cut,
            'feed': feed,
            'drain': drain,
            'x': x,
            'y': y,
            'moves': moves,
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

        nodes, edges, _by_key = self.model(host)

        node = None
        for candidate in nodes:
            if candidate.nid == nid:
                node = candidate
                break
        if node is None:
            return None

        incoming = [e for e in edges if e.dst is node]
        outgoing = [e for e in edges if e.src is node]

        # at either end of a chain there is nothing on one side to join to the other
        if not incoming or not outgoing:
            return None

        if any(e.etype != TYPE_AUDIO for e in incoming):
            return None
        if any(e.etype != TYPE_AUDIO for e in outgoing):
            return None

        source = incoming[0].src
        target = outgoing[0].dst

        # one box on each side, or closing over it would join things that were never on
        # the same path
        if any(e.src is not source for e in incoming):
            return None
        if source is target:
            return None

        # Several destination boxes are allowed where one endpoint feeds them all: that is
        # a split, and putting it back where it was chooses nothing.
        into = dict((id(p), i) for i, p in enumerate(node.inputs))
        out_of = dict((id(p), i) for i, p in enumerate(node.outputs))

        # Our own port first, then the endpoint at the other end as a tie break -- an
        # object address would order these by where they happen to sit in memory, which
        # reads as random and changes between runs.
        incoming.sort(key=lambda e: (into.get(id(e.dst_port), 0),
                                     _endpoint(e.src, e.src_port)))
        outgoing.sort(key=lambda e: (out_of.get(id(e.src_port), 0),
                                     _endpoint(e.dst, e.dst_port)))

        src_ends = []
        for e in incoming:
            end = _endpoint(e.src, e.src_port)
            if end not in src_ends:
                src_ends.append(end)

        dst_ends = []
        for e in outgoing:
            end = _endpoint(e.dst, e.dst_port)
            if end not in dst_ends:
                dst_ends.append(end)

        # Several destination boxes are fine where one endpoint reaches them all -- that
        # is a split, and putting it back chooses nothing -- and fine too where the box
        # being removed is what made them differ, since without it they carry one signal.
        # What stays refused is several sources: joining each of them to each destination
        # would wire together paths that never met.

        """
        The ends paired off, the same way splice_plan shares them over the channels of the
        box it puts in. Whichever side has more of them decides how many cables come back,
        and the shorter side repeats.

        This is what closes a summing box: stereo into a mono pedal into stereo has two
        ends on each side, so taking the pedal out joins them in order and the run is
        stereo again. It is a pairing by position, not a recovery -- once two signals have
        been summed there is nothing left that says which went where -- but in every shape
        splice_plan can produce, position is what they were.
        """
        if len(src_ends) >= len(dst_ends):
            pairs = [(src_ends[i], dst_ends[i % len(dst_ends)])
                     for i in range(len(src_ends))]
        else:
            pairs = [(src_ends[i % len(src_ends)], dst_ends[i])
                     for i in range(len(dst_ends))]

        links = []
        for link in pairs:
            if link not in links:
                links.append(link)

        return {'links': links}

    def place(self, host, nid, uri=None):
        """Where a box added unconnected goes: after the selected one, or after them all.

        Returns (x, y, moves) as _place does.
        """
        anchor = None
        if nid is not None and nid != NO_NODE:
            nodes, _edges, _by_key = self.model(host)
            for node in nodes:
                if node.nid == nid:
                    anchor = node
                    break
        return self._place(host, anchor, None, uri)

    def _place(self, host, source, target, uri=None):
        """A canvas spot for a new box after `source` and before `target`, and the room for it.

        The new box goes to the right of the plugin it follows, as far as that one is wide,
        at its height. If only the far end is a plugin, it takes that one's place instead
        -- hardware has no canvas position of its own. With neither, it goes after the
        rightmost box.

        It used to land halfway between the two ends, and that is what piled boxes up: a
        chain built from the device adds every box after the last one, so each landed half
        as far from the end of the chain as the one before and they all converged on it.
        So instead of fitting in, the new box makes room: whatever it would cover, and the
        box it feeds, moves right together with everything else from there on, which keeps
        the rest of the board arranged the way it was.

        Sizes are the boxes' own (gui_size), `uri` being the new one's: one step for every
        box was either too much for a gain or too little for an amp modeler.

        Returns (x, y, moves), moves being the (instance, x, y) to set before it is added.
        """
        boxes = {}
        for nid, data in getattr(host, 'plugins', {}).items():
            try:
                w, h = gui_size(data.get('uri'))
                boxes[nid] = (data['instance'], int(data['x']), int(data['y']), w, h)
            except (KeyError, TypeError, ValueError):
                continue

        def at(node):
            if node is None or node.kind != KIND_PLUGIN:
                return None
            return boxes.get(node.nid)

        here, there = at(source), at(target)
        width, height = gui_size(uri)

        if here:
            x, y = here[1] + here[3] + CANVAS_GAP, here[2]
        elif there:
            x, y = there[1], there[2]
        elif boxes:
            last = max(boxes.values(), key=lambda b: b[1] + b[3])
            return (last[1] + last[3] + CANVAS_GAP, last[2], [])
        else:
            return (0, 0, [])

        others = dict((nid, b) for nid, b in boxes.items()
                      if not (here and nid == source.nid))

        # The box it feeds always moves out of the way, unless the board runs right to
        # left there: then the user laid it out and it is not ours to turn round.
        edge = x
        follows = there and (not here or there[1] > here[1])
        if follows:
            edge = min(edge, there[1])

        # what the new box would cover, its jacks and the gap after it included
        right = x + width + CANVAS_GAP
        in_way = [b[1] for b in others.values()
                  if edge <= b[1] < right and b[2] < y + height and y < b[2] + b[4]]
        if follows:
            in_way.append(there[1])
        if not in_way:
            return (x, y, [])

        shift = right - min(in_way)
        if shift <= 0:
            return (x, y, [])

        moves = [(b[0], b[1] + shift, b[2]) for b in others.values() if b[1] >= edge]
        moves.sort(key=lambda m: m[0])
        return (x, y, moves)

    def info(self, host):
        scene = self.scene(host)
        return {
            'mode': self.mode,
            'version': self._version,
            'width': scene.width,
            'height': scene.height,
            'view': [PLUGIN_MAP_VIEW_WIDTH, PLUGIN_MAP_VIEW_HEIGHT],
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
        spec = PLUGIN_MAP_LAYERS
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


# One picture, one instance, holding the cached scene and the cached model behind it.
INSTANCE = PluginMap()
