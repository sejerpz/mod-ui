#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Standalone checks for the pedalboard plugin_map.

Runs without JACK, LV2 or mod-host: a FakeHost mirrors the real Host attributes
and get_plugin_info is stubbed, so this works on a plain desktop checkout.

    python test/test_plugin_map.py                 # run everything
    python test/test_plugin_map.py --out DIR       # also write reference PNGs
    python test/test_plugin_map.py --check-compat  # Python 3.4 syntax audit
    python test/test_plugin_map.py --show NAME     # ASCII art for one scenario
"""

import argparse
import ast
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mod import plugin_map
from mod import plugin_map_font as font
from mod.settings import (PLUGIN_MAP_MAX_MSG, PLUGIN_MAP_WIN_PLUGINS, PLUGIN_MAP_MAX_MENU,
                          PLUGIN_MAP_VIEW_WIDTH, PLUGIN_MAP_VIEW_HEIGHT,
                          PLUGIN_MAP_HMI_VIEW_WIDTH, PLUGIN_MAP_HMI_VIEW_HEIGHT)


# ---------------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------------

class FakeHost(object):
    """Mirrors the attributes mod/plugin_map.py reads off the real Host."""

    def __init__(self):
        self.plugins = {}
        self.connections = []
        self.audioportsIn = ['capture_1', 'capture_2']
        self.audioportsOut = ['playback_1', 'playback_2']
        self.cvportsIn = []
        self.cvportsOut = []
        self.midiports = []
        self.midi_aggregated_mode = True
        self.midi_loopback_enabled = False
        self._next_id = 1

    def add(self, name, uri='urn:test:stereo', x=0, y=0, bypassed=False, label=''):
        instance_id = self._next_id
        self._next_id += 1
        self.plugins[instance_id] = {
            'instance': '/graph/' + name,
            'uri': uri,
            'name': name,
            'label': label,
            'x': x,
            'y': y,
            'bypassed': bypassed,
        }
        return '/graph/' + name

    def connect(self, a, b):
        self.connections.append((a, b))


# port tables keyed by URI, standing in for the LV2 world
PORT_TABLES = {
    'urn:test:stereo': {'audio': (['in_l', 'in_r'], ['out_l', 'out_r'])},
    'urn:test:mono': {'audio': (['in'], ['out'])},
    'urn:test:midi': {'audio': (['in'], ['out']), 'midi': (['midi_in'], [])},
    'urn:test:cv': {'audio': (['in'], ['out']), 'cv': ([], ['cv_out'])},
    'urn:test:fat': {'audio': (['i1', 'i2', 'i3', 'i4'], ['o1', 'o2', 'o3', 'o4'])},
    'urn:test:broken': None,
}


def fake_plugin_info(uri):
    table = PORT_TABLES.get(uri, PORT_TABLES['urn:test:stereo'])
    if table is None:
        raise RuntimeError('simulated LV2 lookup failure for %s' % uri)

    ports = {}
    for group in ('audio', 'midi', 'cv'):
        ins, outs = table.get(group, ([], []))
        ports[group] = {
            'input': [{'symbol': s, 'name': s} for s in ins],
            'output': [{'symbol': s, 'name': s} for s in outs],
        }
    ports['control'] = {'input': [], 'output': []}
    return {'ports': ports}


plugin_map.set_plugin_info_provider(fake_plugin_info)


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------

def sc_empty():
    return FakeHost()


def sc_linear():
    h = FakeHost()
    comp = h.add('comp', 'urn:test:mono', 100, 100)
    drive = h.add('drive', 'urn:test:mono', 300, 100)
    delay = h.add('delay', 'urn:test:mono', 500, 100)
    verb = h.add('reverb', 'urn:test:mono', 700, 100)
    h.connect('/graph/capture_1', comp + '/in')
    h.connect(comp + '/out', drive + '/in')
    h.connect(drive + '/out', delay + '/in')
    h.connect(delay + '/out', verb + '/in')
    h.connect(verb + '/out', '/graph/playback_1')
    h.connect(verb + '/out', '/graph/playback_2')
    return h


def sc_stereo_split():
    h = FakeHost()
    split = h.add('splitter', 'urn:test:stereo', 100, 100)
    left = h.add('leftchain', 'urn:test:mono', 300, 40)
    right = h.add('rightchain', 'urn:test:mono', 300, 200)
    merge = h.add('merger', 'urn:test:stereo', 500, 100)
    h.connect('/graph/capture_1', split + '/in_l')
    h.connect('/graph/capture_2', split + '/in_r')
    h.connect(split + '/out_l', left + '/in')
    h.connect(split + '/out_r', right + '/in')
    h.connect(left + '/out', merge + '/in_l')
    h.connect(right + '/out', merge + '/in_r')
    h.connect(merge + '/out_l', '/graph/playback_1')
    h.connect(merge + '/out_r', '/graph/playback_2')
    return h


def sc_all_zero():
    """Old or generated boards carry no canvasX/Y at all -- every plugin at 0,0."""
    h = FakeHost()
    a = h.add('alpha', 'urn:test:mono', 0, 0)
    b = h.add('beta', 'urn:test:mono', 0, 0)
    c = h.add('gamma', 'urn:test:mono', 0, 0)
    h.connect('/graph/capture_1', a + '/in')
    h.connect(a + '/out', b + '/in')
    h.connect(b + '/out', c + '/in')
    h.connect(c + '/out', '/graph/playback_1')
    return h


def sc_cyclic():
    h = FakeHost()
    a = h.add('loopa', 'urn:test:mono', 100, 100)
    b = h.add('loopb', 'urn:test:mono', 300, 100)
    c = h.add('loopc', 'urn:test:mono', 500, 100)
    h.connect('/graph/capture_1', a + '/in')
    h.connect(a + '/out', b + '/in')
    h.connect(b + '/out', c + '/in')
    h.connect(c + '/out', a + '/in')          # feedback
    h.connect(c + '/out', '/graph/playback_1')
    return h


def sc_islands():
    h = FakeHost()
    a = h.add('wired', 'urn:test:mono', 100, 100)
    h.add('orphan1', 'urn:test:mono', 100, 300)
    h.add('orphan2', 'urn:test:mono', 300, 300, bypassed=True)
    h.connect('/graph/capture_1', a + '/in')
    h.connect(a + '/out', '/graph/playback_1')
    return h


def sc_mixed_types():
    h = FakeHost()
    h.cvportsIn = ['cv_capture_1']
    h.cvportsOut = ['cv_playback_1']
    m = h.add('midiplug', 'urn:test:midi', 100, 100)
    c = h.add('cvplug', 'urn:test:cv', 300, 200)
    h.connect('/graph/capture_1', m + '/in')
    h.connect(m + '/out', c + '/in')
    h.connect(c + '/out', '/graph/playback_1')
    h.connect(c + '/cv_out', '/graph/cv_playback_1')
    h.connect('/graph/midi_merger_out', m + '/midi_in')
    return h


def sc_broken_info():
    """A plugin whose LV2 lookup fails must still appear, just without stubs."""
    h = FakeHost()
    ok = h.add('good', 'urn:test:mono', 100, 100)
    h.add('bad', 'urn:test:broken', 300, 100)
    h.connect('/graph/capture_1', ok + '/in')
    h.connect(ok + '/out', '/graph/playback_1')
    return h


def sc_long_labels():
    h = FakeHost()
    a = h.add('x1', 'urn:test:mono', 100, 100, label='Super Massive Reverb Deluxe')
    b = h.add('x2', 'urn:test:mono', 300, 100, label='Ampli Tübe Überdrive')
    h.connect('/graph/capture_1', a + '/in')
    h.connect(a + '/out', b + '/in')
    h.connect(b + '/out', '/graph/playback_1')
    return h


def sc_stress():
    h = FakeHost()
    prev = None
    for i in range(40):
        uri = 'urn:test:fat' if i % 7 == 0 else 'urn:test:mono'
        node = h.add('fx%02d' % i, uri, 100 + (i % 8) * 200, 100 + (i // 8) * 150)
        src = prev + '/out' if prev else '/graph/capture_1'
        dst = node + ('/i1' if uri == 'urn:test:fat' else '/in')
        h.connect(src, dst)
        prev = node + ('/o1' if uri == 'urn:test:fat' else '')
        if uri == 'urn:test:fat':
            prev = node
            prev = node + '/o1'
            prev = node
        prev = node
    h.connect(prev + '/out' if 'fx39' in prev else prev + '/in', '/graph/playback_1')
    return h


SCENARIOS = [
    ('empty', sc_empty),
    ('linear', sc_linear),
    ('stereo-split', sc_stereo_split),
    ('all-zero-coords', sc_all_zero),
    ('cyclic', sc_cyclic),
    ('islands', sc_islands),
    ('mixed-types', sc_mixed_types),
    ('broken-plugin-info', sc_broken_info),
    ('long-labels', sc_long_labels),
    ('stress-40', sc_stress),
]


# ---------------------------------------------------------------------------
# display list parsing (an independent reader, so the tests do not trust the
# writer's own view of the format)
# ---------------------------------------------------------------------------

def parse_displaylist(text):
    out = {'M': None, 'N': [], 'P': [], 'E': [], 'A': []}
    for line in text.split(plugin_map.RECORD_SEP):
        line = line.strip()
        if not line:
            continue
        kind = line[0]
        parts = line.split(' ')
        if kind == 'M':
            out['M'] = {
                'w': int(parts[1]), 'h': int(parts[2]), 'ver': int(parts[3]),
                'mask': parts[4], 'focus': int(parts[5]),
                'n_win': int(parts[6]), 'n_total': int(parts[7]),
            }
        elif kind == 'N':
            out['N'].append({
                'nid': int(parts[1]), 'kind': parts[2],
                'x': int(parts[3]), 'y': int(parts[4]),
                'w': int(parts[5]), 'h': int(parts[6]),
                'byp': int(parts[7]), 'layer': int(parts[8]),
                'row': int(parts[9]), 'label': parts[10],
                # '=' means the title bar shows the same string as the box
                'title': parts[10] if len(parts) < 12 or parts[11] == '=' else parts[11],
            })
        elif kind == 'P':
            out['P'].append({
                'nid': int(parts[1]), 'pid': int(parts[2]),
                'dir': parts[3], 'type': parts[4],
                'x': int(parts[5]), 'y': int(parts[6]), 'symbol': parts[7],
            })
        elif kind == 'E':
            src = parts[2].split(':')
            dst = parts[3].split(':')
            out['E'].append({
                'eid': int(parts[1]),
                'src': int(src[0]), 'src_port': int(src[1]),
                'dst': int(dst[0]), 'dst_port': int(dst[1]),
                'type': parts[4],
                'src_out': int(parts[5]), 'dst_out': int(parts[6]),
                'points': [tuple(int(v) for v in p.split(',')) for p in parts[7:]],
            })
        elif kind == 'A':
            out['A'].append({
                'nid': int(parts[1]), 'prev': int(parts[2]), 'next': int(parts[3]),
            })
    return out


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------

class Results(object):
    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, ok, label, detail=''):
        if ok:
            self.passed += 1
        else:
            self.failed.append((label, detail))
        return ok

    def report(self):
        print('')
        if self.failed:
            print('FAILED (%d of %d)' % (len(self.failed), self.passed + len(self.failed)))
            for label, detail in self.failed:
                print('  x %s' % label)
                if detail:
                    for line in str(detail).splitlines():
                        print('      %s' % line)
            return 1
        print('all %d checks passed' % self.passed)
        return 0


def check_font(r):
    print('== font proof: %s %dx%d, %d glyphs ==' % (
        font.NAME, font.WIDTH, font.HEIGHT, font.CHAR_COUNT))

    alphabet = ''.join(chr(c) for c in range(font.FIRST_CHAR, font.FIRST_CHAR + font.CHAR_COUNT))
    for start in range(0, len(alphabet), 24):
        chunk = alphabet[start:start + 24]
        for y in range(font.HEIGHT):
            row = []
            for ch in chunk:
                for column in font.glyph(ch):
                    row.append('#' if (column >> y) & 1 else '.')
                row.append(' ')
            print('  ' + ''.join(row))
        print('  ' + ''.join(('%-4s' % ch) for ch in chunk))
        print('')

    r.check(font.text_width('AB') == font.WIDTH * 2 + font.INTERCHAR,
            'font: text_width accounts for intercharacter space')
    r.check(font.text_width('') == 0, 'font: empty string has zero width')
    r.check(font.glyph(chr(0x1F600)) == font.glyph('?'),
            'font: unmapped codepoint falls back to "?"')
    r.check(font.text_width(font.truncate('COMPRESSOR', 20)) <= 20,
            'font: truncate respects the pixel budget')
    r.check(font.truncate('AB', 100) == 'AB', 'font: truncate leaves short text alone')
    r.check(font.truncate('COMPRESSOR', 0) == '', 'font: truncate degrades to empty')


def check_scenario(r, name, host, out_dir):
    mm = plugin_map.PluginMap()
    text, version = mm.render(host)
    dl = parse_displaylist(text)
    scene = mm.scene(host)

    prefix = 'scenario %s' % name

    # geometry inside declared bounds
    m = dl['M']
    r.check(m is not None, '%s: has an M header' % prefix)
    if m is None:
        return

    bad = [n for n in dl['N']
           if n['x'] < 0 or n['y'] < 0 or n['x'] + n['w'] > m['w'] or n['y'] + n['h'] > m['h']]
    r.check(not bad, '%s: every node rect is inside the scene bounds' % prefix, bad[:3])

    # The scene is the drawing and nothing more -- no padding up to the panel size.
    # A board smaller than the viewport is centred by the firmware, which is the only
    # side that knows how much of the panel the builder's chrome has taken.
    tight = [n for n in dl['N']]
    if tight:
        r.check(min(n['x'] for n in tight) == 3
                and min(n['y'] for n in tight) == 3,
                '%s: the drawing starts at the margin' % prefix,
                (min(n['x'] for n in tight), min(n['y'] for n in tight)))
        r.check(m['w'] - max(n['x'] + n['w'] for n in tight) == 3
                and m['h'] - max(n['y'] + n['h'] for n in tight) == 3,
                '%s: the scene ends at the margin' % prefix,
                (m['w'] - max(n['x'] + n['w'] for n in tight),
                 m['h'] - max(n['y'] + n['h'] for n in tight)))
    r.check(m['w'] <= 1024 and m['h'] <= 512,
            '%s: scene respects the size cap' % prefix, '%dx%d' % (m['w'], m['h']))

    # ports must sit on their node's edge
    nodes_by_id = dict((n['nid'], n) for n in dl['N'])
    misplaced = []
    for p in dl['P']:
        n = nodes_by_id.get(p['nid'])
        if n is None:
            misplaced.append(p)
            continue
        expected_x = n['x'] - 1 if p['dir'] == 'i' else n['x'] + n['w']
        if p['x'] != expected_x or not (n['y'] <= p['y'] < n['y'] + n['h']):
            misplaced.append(p)
    r.check(not misplaced, '%s: port stubs sit on their node edge' % prefix, misplaced[:3])

    # edges reference real nodes/ports and have a polyline
    dangling = [e for e in dl['E']
                if e['src'] not in nodes_by_id or e['dst'] not in nodes_by_id
                or len(e['points']) < 2]
    r.check(not dangling, '%s: every edge resolves and has a polyline' % prefix, dangling[:3])

    # walk order: this list is unwindowed, so every step lands on a drawn node
    ids = set(nodes_by_id)
    bad_adj = []
    for a in dl['A']:
        for direction in ('prev', 'next'):
            target = a[direction]
            if target != -1 and (target not in ids or target == a['nid']):
                bad_adj.append((a['nid'], direction, target))
    r.check(not bad_adj, '%s: walk order points only at real nodes' % prefix, bad_adj[:3])
    r.check(len(dl['A']) == len(dl['N']),
            '%s: every node has a walk-order record' % prefix)

    # and the steps form one chain through every box, exactly once
    step = dict((a['nid'], a['next']) for a in dl['A'])
    back = dict((a['nid'], a['prev']) for a in dl['A'])
    heads = [a['nid'] for a in dl['A'] if a['prev'] == -1]
    r.check(len(heads) == 1, '%s: the walk has one beginning' % prefix, heads)
    if len(heads) == 1:
        seen = []
        cursor = heads[0]
        while cursor != -1 and len(seen) <= len(ids):
            seen.append(cursor)
            cursor = step[cursor]
        r.check(sorted(seen) == sorted(ids),
                '%s: the walk visits every box exactly once' % prefix,
                (len(seen), len(ids)))
        r.check(all(back[seen[i + 1]] == seen[i] for i in range(len(seen) - 1)),
                '%s: prev and next agree' % prefix)

    # labels are wire-safe: the format is space delimited
    spacey = [n['label'] for n in dl['N'] if ' ' in n['label']]
    r.check(not spacey, '%s: labels carry no spaces' % prefix, spacey[:3])

    # every plugin in host.plugins made it into the scene
    expected = len([p for k, p in host.plugins.items()])
    r.check(scene.plugin_count == expected,
            '%s: all %d plugins are present' % (prefix, expected),
            'got %d' % scene.plugin_count)

    # determinism: same graph, rebuilt from scratch
    mm2 = plugin_map.PluginMap()
    text2, _ = mm2.render(host)
    r.check(strip_version(text) == strip_version(text2),
            '%s: render is deterministic' % prefix)

    if out_dir:
        write_preview(name, mm, host, out_dir)


def strip_version(text):
    return re.sub(r'M (\d+) (\d+) \d+ ', r'M \1 \2 V ', text)


def check_wire_sufficiency(r):
    """The display list alone must be enough to draw the picture.

    Rasterising from the emitted text and from the in-memory scene must produce
    identical pixels. This is the property Plan B rests on: if the wire format
    were missing something, the firmware could not draw it either, and we would
    only discover that once the firmware existed.
    """
    try:
        from mod import plugin_map_render
    except ImportError:
        return
    if not plugin_map_render.available():
        return

    for name, factory in SCENARIOS:
        host = factory()
        mm = plugin_map.PluginMap()
        text, _ = mm.render(host)

        from_scene = plugin_map_render.render(mm.scene(host))
        from_wire = plugin_map_render.render_displaylist(text)

        if from_scene is None or from_wire is None:
            continue

        r.check(from_scene.size == from_wire.size,
                'wire %s: rasterised size matches' % name,
                '%s vs %s' % (from_scene.size, from_wire.size))
        if from_scene.size != from_wire.size:
            continue

        r.check(from_scene.tobytes() == from_wire.tobytes(),
                'wire %s: display list draws the same pixels as the model' % name,
                'the wire format is missing something the renderer needed')


def check_insertion_order(r):
    """Same graph, plugins inserted in a different order -> identical output.

    This is the guard against Python 3.4's unordered dicts: without explicit
    sorting the layout and the fingerprint would both wobble.
    """
    def build(order):
        h = FakeHost()
        made = {}
        for name in order:
            made[name] = h.add(name, 'urn:test:mono', 100, 100)
        h.connect('/graph/capture_1', made['aa'] + '/in')
        h.connect(made['aa'] + '/out', made['bb'] + '/in')
        h.connect(made['bb'] + '/out', made['cc'] + '/in')
        h.connect(made['cc'] + '/out', '/graph/playback_1')
        return h

    # Node ids are the mapper's instance_id now, so they legitimately differ when the plugins
    # were created in a different order. What must not differ is the geometry: same graph,
    # same picture.
    def geometry(host):
        dl = parse_displaylist(plugin_map.PluginMap().render(host)[0])
        return sorted((n['x'], n['y'], n['w'], n['h'], n['label']) for n in dl['N'])

    ga = geometry(build(['aa', 'bb', 'cc']))
    gb = geometry(build(['cc', 'bb', 'aa']))
    r.check(ga == gb,
            'insertion order does not change the picture',
            'differs:\n%s\n%s' % (ga, gb))


def check_layers(r):
    """Layer masks must hide cables without ever moving a box."""
    host = sc_mixed_types()
    mm = plugin_map.PluginMap()

    rects = {}
    for spec in ('audio,midi,cv', 'audio', 'midi', 'cv', 'none', 'audio,midi'):
        text, _ = mm.render(host, layers=spec)
        dl = parse_displaylist(text)
        mask = dl['M']['mask']

        leaked = [e for e in dl['E'] if mask != '-' and e['type'] not in mask]
        r.check(not leaked, 'layers %r: no edge of a disabled type' % spec, leaked[:3])
        if spec == 'none':
            r.check(not dl['E'], 'layers none: no cables at all')

        leaked_ports = [p for p in dl['P'] if mask != '-' and p['type'] not in mask]
        r.check(not leaked_ports, 'layers %r: no port of a disabled type' % spec, leaked_ports[:3])

        rects[spec] = dict((n['nid'], (n['x'], n['y'], n['w'], n['h'])) for n in dl['N'])

    reference = rects['audio,midi,cv']
    for spec in rects:
        r.check(rects[spec] == reference,
                'layers %r: node rects identical to the full view' % spec,
                'boxes moved when toggling a layer')


def check_windowing(r):
    """Window by plugin, never by connection; and every plugin stays reachable."""
    for name, factory in (('stress-40', sc_stress), ('islands', sc_islands),
                          ('stereo-split', sc_stereo_split)):
        host = factory()
        mm = plugin_map.PluginMap()
        scene = mm.scene(host)
        plugins = [n for n in scene.nodes if n.kind == plugin_map.KIND_PLUGIN]
        if not plugins:
            continue

        focus = plugins[0].key
        text, _ = mm.render(host, focus=focus)
        dl = parse_displaylist(text)

        r.check(len(text) <= PLUGIN_MAP_MAX_MSG,
                'window %s: message fits the firmware 4K buffer' % name,
                '%d bytes' % len(text))

        win_plugins = [n for n in dl['N'] if n['kind'] == plugin_map.KIND_PLUGIN]
        r.check(len(win_plugins) <= PLUGIN_MAP_WIN_PLUGINS,
                'window %s: plugin budget respected' % name,
                '%d plugins' % len(win_plugins))

        # connections are never windowed: for each plugin in the window, every
        # cable it has in the full scene must be present
        shown = set(n['nid'] for n in dl['N'])
        emitted = set(e['eid'] for e in dl['E'])
        missing = []
        for e in scene.edges:
            if e.src.nid in shown or e.dst.nid in shown:
                if e.eid not in emitted:
                    missing.append((e.eid, e.src.key, e.dst.key))
        r.check(not missing,
                'window %s: no cable of a visible plugin is dropped' % name,
                missing[:3])

        # an edge leaving the window must be flagged so the firmware knows
        # there is more that way
        for e in dl['E']:
            if e['src'] not in shown:
                r.check(e['src_out'] == 1,
                        'window %s: outside source is flagged' % name)
            if e['dst'] not in shown:
                r.check(e['dst_out'] == 1,
                        'window %s: outside target is flagged' % name)

        # Coverage, simulating the firmware exactly: hold one window, step to the
        # next id, and refetch centred on it whenever it is not in the window we
        # have. Every box must be reachable this way, in one pass, without looping.
        node_by_id = dict((n.nid, n) for n in scene.nodes)
        all_ids = set(node_by_id)

        wtext, _ = mm.render(host, focus=focus)
        wdl = parse_displaylist(wtext)
        cursor = scene.by_key[focus].nid
        # rewind to the first box, the way the device does when it opens on IN1
        walked = []
        fetches = 0

        while cursor != -1 and len(walked) <= len(all_ids):
            walked.append(cursor)
            step = dict((a['nid'], a['next']) for a in wdl['A'])
            nxt = step.get(cursor, -1)
            if nxt == -1:
                break
            if nxt not in set(n['nid'] for n in wdl['N']):
                wtext, _ = mm.render(host, focus=node_by_id[nxt].key)
                wdl = parse_displaylist(wtext)
                fetches += 1
                r.check(nxt in set(n['nid'] for n in wdl['N']),
                        'window %s: a refetch really brings in the next box' % name)
            cursor = nxt

        start = scene.by_key[focus].nid
        expected = sorted(all_ids, key=lambda i: (node_by_id[i].layer, node_by_id[i].row,
                                                  node_by_id[i].key))
        tail = expected[expected.index(start):]
        r.check(walked == tail,
                'window %s: one encoder walks every box from here to the end' % name,
                (len(walked), len(tail)))

        # global coordinates: the same plugin seen from different windows
        # must never move
        seen_rects = {}
        drift = []
        for plugin in plugins[:6]:
            wtext, _ = mm.render(host, focus=plugin.key)
            for n in parse_displaylist(wtext)['N']:
                rect = (n['x'], n['y'], n['w'], n['h'])
                if n['nid'] in seen_rects and seen_rects[n['nid']] != rect:
                    drift.append((n['nid'], seen_rects[n['nid']], rect))
                seen_rects[n['nid']] = rect
        r.check(not drift, 'window %s: coordinates stay global' % name, drift[:3])


def check_caching(r):
    """The fingerprint must skip work when nothing changed, and notice when it does."""
    host = sc_linear()
    mm = plugin_map.PluginMap()

    _, v1 = mm.render(host)
    _, v2 = mm.render(host)
    r.check(v1 == v2, 'cache: identical state does not bump the version')

    host.plugins[1]['bypassed'] = True
    _, v3 = mm.render(host)
    r.check(v3 > v2, 'cache: a bypass change bumps the version')

    host.plugins[1]['x'] = 999
    _, v4 = mm.render(host)
    r.check(v4 == v3, 'cache: dragging a plugin on the canvas changes nothing here')

    node = host.add('extra', 'urn:test:mono', 900, 100)
    host.connect(node + '/out', '/graph/playback_2')
    _, v5 = mm.render(host)
    r.check(v5 > v4, 'cache: adding a plugin bumps the version')

    host.connections.pop()
    _, v6 = mm.render(host)
    r.check(v6 > v5, 'cache: a silent connection removal is still noticed')


def check_hmi_request(r):
    """The CMD_BUILDER_PLUGIN_MAP round trip, without importing mod.host.

    Mirrors what Host.hmi_builder_plugin_map does: pick a focus, render, hand the
    text back as the command response. What matters here is that the answer is
    something one HMI message can carry, and that every node the firmware
    could name back resolves to a focus -- that pair is what makes panning
    from the device work.
    """
    for name, factory in SCENARIOS:
        host = factory()
        mm = plugin_map.PluginMap()
        scene = mm.scene(host)

        # FLAG_PAGINATION_INITIAL_REQ: no node named yet, the server picks one
        focus = mm.default_focus(scene)
        r.check(focus is not None or scene.plugin_count == 0,
                'hmi %s: initial request has a focus' % name)

        text, version = mm.render(host, focus=focus)
        r.check(len(text) <= PLUGIN_MAP_MAX_MSG,
                'hmi %s: initial window fits one message' % name, len(text))
        r.check(version > 0, 'hmi %s: response carries a version' % name, version)

        # every id in the answer is a focus the HMI can ask for next
        records = parse_displaylist(text)
        unresolved = [n['nid'] for n in records['N']
                      if mm.key_for_id(scene, n['nid']) is None]
        r.check(not unresolved, 'hmi %s: every drawn node id resolves' % name,
                unresolved[:5])

        # ... including the far ends of cables leaving the window, which is
        # exactly what the user pans towards
        outside = set()
        for edge in records['E']:
            for nid in (edge['src'], edge['dst']):
                if mm.key_for_id(scene, nid) is None:
                    outside.add(nid)
        r.check(not outside, 'hmi %s: every referenced node id resolves' % name,
                sorted(outside)[:5])

        for node in records['N']:
            follow, _ = mm.render(host, focus=mm.key_for_id(scene, node['nid']))
            if len(follow) > PLUGIN_MAP_MAX_MSG:
                r.check(False, 'hmi %s: window around node %d fits one message'
                        % (name, node['nid']), len(follow))
                break
        else:
            r.check(True, 'hmi %s: every follow-up window fits one message' % name)

        # an id the firmware made up must not take the server down
        r.check(mm.key_for_id(scene, 31337) is None,
                'hmi %s: unknown node id resolves to nothing' % name)

        # The sign of an id is what tells a plugin from a piece of hardware, and
        # hmi_builder_plugin_delete leans on it: capture and playback are drawn like everything
        # else but are not on the board, and a delete must never reach them.
        wrong = [n.key for n in scene.nodes
                 if (n.nid < 0) != (n.kind != plugin_map.KIND_PLUGIN)]
        r.check(not wrong,
                'hmi %s: only hardware takes a negative id' % name, wrong[:3])


def spliced(plan, ins, outs):
    """The wiring a plan produces, the way Host._splice_plugin lays it.

    Asserting on this rather than on the plan's own lists: what matters is which cable
    ends up where, and the two sides of the plan differ in length as soon as a box fans
    out or a stereo one goes into a mono run.
    """
    out = []
    for source, channel in plan['feed']:
        out.append((source, 'new/' + ins[channel]))
    for channel, target in plan['drain']:
        out.append(('new/' + outs[channel], target))
    return out


MONO = (['in'], ['out'])
STEREO = (['in_l', 'in_r'], ['out_l', 'out_r'])


def check_splice(r):
    """Where an added plugin lands when the server is allowed to guess.

    Adding a tremolo with a gain selected should put the tremolo between the gain and
    whatever the gain fed. The whole value of that is in never being wrong: a guess that
    rearranges a board the user did not want rearranged costs far more than the wiring it
    saved, so everything below the first two cases has to come back with nothing.
    """
    mm = plugin_map.INSTANCE

    # -- mono, the plain case: one cable, taken over ---------------------------------
    host = FakeHost()
    gain = host.add('gain', 'urn:test:mono', 100, 40)
    amp = host.add('amp', 'urn:test:mono', 500, 40)
    host.connect(gain + '/out', amp + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[gain], 1)

    r.check(plan is not None, 'splice: a lone cable is spliceable')
    r.check(plan and spliced(plan, *MONO) == [(gain + '/out', 'new/in'),
                                              ('new/out', amp + '/in')],
            'splice: the cable to take over is the one between the two',
            plan and spliced(plan, *MONO))
    r.check(plan and (plan['x'], plan['y']) == (300, 40),
            'splice: the new box lands between the two it comes between', plan)
    r.check(plan and len(plan['feed']) == 1 and len(plan['drain']) == 1,
            'splice: with a channel per cable there is one of each side', plan)

    # -- a stereo box between two mono ends: split in, sum out ------------------------
    plan = mm.splice_plan(host, ids[gain], 2)

    r.check(plan and plan['cut'] == [(gain + '/out', amp + '/in')],
            'splice: the one cable is dropped once, not once per channel', plan)
    r.check(plan and spliced(plan, *STEREO) == [
                (gain + '/out', 'new/in_l'), (gain + '/out', 'new/in_r'),
                ('new/out_l', amp + '/in'), ('new/out_r', amp + '/in')],
            'splice: and both channels of the new box come off it',
            plan and spliced(plan, *STEREO))

    # what the far box hears has to be what it heard: the cable feeds both inputs and
    # both outputs meet the one input again, so the split and the sum cancel
    r.check(plan and plan['cut'] == [(gain + '/out', amp + '/in')],
            'splice: which is one cable dropped, not one per channel', plan)

    # and a box with more channels than the run has ends simply gets them all off it
    plan = mm.splice_plan(host, ids[gain], 4)
    r.check(plan and [c for _e, c in plan['feed']] == [0, 1, 2, 3],
            'splice: every channel of a wider box is fed from the one cable', plan)
    r.check(plan and set(e for _c, e in plan['drain']) == set([amp + '/in']),
            'splice: and all of them come back together at the far end', plan)

    # -- stereo, where the pairing has to come out straight ---------------------------
    host = FakeHost()
    left = host.add('left', 'urn:test:stereo', 0, 10)
    right = host.add('right', 'urn:test:stereo', 200, 30)
    # deliberately back to front: the plan must sort them, not trust the order it got
    host.connect(left + '/out_r', right + '/in_r')
    host.connect(left + '/out_l', right + '/in_l')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[left], 2)

    r.check(plan and spliced(plan, *STEREO) == [
                (left + '/out_l', 'new/in_l'), (left + '/out_r', 'new/in_r'),
                ('new/out_l', right + '/in_l'), ('new/out_r', right + '/in_r')],
            'splice: a stereo pair is taken over left to left',
            plan and spliced(plan, *STEREO))
    r.check(plan and (plan['x'], plan['y']) == (100, 20),
            'splice: stereo lands halfway too', plan)

    # a mono plugin has no shape to take a stereo cable over with, and the other way round
    # A mono plugin in a stereo run sums the two ends into its one input and hands the
    # result to both. That is a real change to the signal, and it is what a player means
    # when they drop a mono pedal into a stereo path; editing the cables is there for the
    # times it is not.
    plan = mm.splice_plan(host, ids[left], 1)
    r.check(plan and spliced(plan, *MONO) == [
                (left + '/out_l', 'new/in'), (left + '/out_r', 'new/in'),
                ('new/out', right + '/in_l'), ('new/out', right + '/in_r')],
            'splice: a mono plugin sums a stereo run rather than refusing it',
            plan and spliced(plan, *MONO))

    # -- a mono box feeding a stereo one over two cables ------------------------------
    # Two cables leaving one output: the run is stereo even though the near end is not,
    # so a stereo plugin belongs in it -- the mono output goes on feeding both inputs,
    # and the new box meets the far one port for port.
    host = FakeHost()
    drive = host.add('drive', 'urn:test:mono', 0, 0)
    verb = host.add('verb', 'urn:test:stereo', 400, 100)
    host.connect(drive + '/out', verb + '/in_r')
    host.connect(drive + '/out', verb + '/in_l')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[drive], 2)

    r.check(plan and spliced(plan, *STEREO) == [
                (drive + '/out', 'new/in_l'), (drive + '/out', 'new/in_r'),
                ('new/out_l', verb + '/in_l'), ('new/out_r', verb + '/in_r')],
            'splice: a mono output feeding a stereo box is a two channel run',
            plan and spliced(plan, *STEREO))

    # -- the same run with a mono plugin: one signal in, the same fan out again ---------
    # One output feeding several places is carrying one signal however many places it
    # goes, so a one channel plugin sits in front of the split rather than being refused.
    plan = mm.splice_plan(host, ids[drive], 1)
    r.check(plan and spliced(plan, *MONO) == [
                (drive + '/out', 'new/in'),
                ('new/out', verb + '/in_l'), ('new/out', verb + '/in_r')],
            'splice: a mono plugin goes in front of a fan out, not into it',
            plan and spliced(plan, *MONO))
    r.check(plan and len(plan['cut']) == 2,
            'splice: and both cables of the fan out are taken over', plan)

    # the other way round: a stereo box summed into a mono one
    host = FakeHost()
    wide = host.add('wide', 'urn:test:stereo', 0, 0)
    sum_in = host.add('sum', 'urn:test:mono', 200, 0)
    host.connect(wide + '/out_r', sum_in + '/in')
    host.connect(wide + '/out_l', sum_in + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[wide], 2)
    r.check(plan and spliced(plan, *STEREO) == [
                (wide + '/out_l', 'new/in_l'), (wide + '/out_r', 'new/in_r'),
                ('new/out_l', sum_in + '/in'), ('new/out_r', sum_in + '/in')],
            'splice: and a stereo box summed into a mono one is one as well',
            plan and spliced(plan, *STEREO))

    # a run that repeats ports at both ends has nothing left to name its channels with
    host = FakeHost()
    fat = host.add('fat', 'urn:test:fat', 0, 0)
    pair = host.add('pair', 'urn:test:stereo', 200, 0)
    host.connect(fat + '/o1', pair + '/in_l')
    host.connect(fat + '/o1', pair + '/in_r')
    host.connect(fat + '/o2', pair + '/in_r')

    # three cables off two ports into two ports: the ends are shared out over the
    # channels rather than the whole thing being refused
    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[fat], 3)
    r.check(plan is not None,
            'splice: cables that repeat ports are shared out over the channels')

    # The invariant that has to hold whatever the shape: a spliced box has every one of
    # its channels fed and every one drained. A channel left dangling is silence on it.
    for channels in (1, 2, 3, 4):
        p = mm.splice_plan(host, ids[fat], channels)
        if p is None:
            continue
        fed = set(c for _e, c in p['feed'])
        drained = set(c for c, _e in p['drain'])
        r.check(fed == set(range(channels)) and drained == set(range(channels)),
                'splice: with %d channels every one is fed and drained' % channels,
                (sorted(fed), sorted(drained)))

    # -- hardware at either end still has a spot to aim at ----------------------------
    host = FakeHost()
    only = host.add('only', 'urn:test:mono', 400, 60)
    host.connect('/graph/capture_1', only + '/in')
    host.connect(only + '/out', '/graph/playback_1')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[only], 1)
    r.check(plan and plan['x'] > 400 and plan['y'] == 60,
            'splice: a chain ending at hardware is measured from the plugin', plan)

    plan = mm.splice_plan(host, ids['/graph/capture_1'], 1)
    r.check(plan and plan['x'] < 400 and plan['y'] == 60,
            'splice: and so is one starting at it', plan)

    # -- everything that has to come back with nothing --------------------------------
    host = FakeHost()
    head = host.add('head', 'urn:test:mono')
    one = host.add('one', 'urn:test:mono')
    two = host.add('two', 'urn:test:mono')
    host.connect(head + '/out', one + '/in')
    host.connect(head + '/out', two + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)

    # One output feeding two boxes is still one signal, and a one channel plugin goes in
    # front of the split. Which destinations they are does not come into it.
    plan = mm.splice_plan(host, ids[head], 1)
    r.check(plan and spliced(plan, *MONO) == [
                (head + '/out', 'new/in'),
                ('new/out', one + '/in'), ('new/out', two + '/in')],
            'splice: a fan out to several boxes is still one signal',
            plan and spliced(plan, *MONO))
    r.check(mm.splice_plan(host, ids[one], 1) is None,
            'splice: a box wired to nothing has no cable to be spliced into')

    host = FakeHost()
    a = host.add('a', 'urn:test:mono')
    b = host.add('b', 'urn:test:mono')
    summed = host.add('summed', 'urn:test:mono')
    host.connect(a + '/out', summed + '/in')
    host.connect(b + '/out', summed + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    r.check(mm.splice_plan(host, ids[a], 1) is None,
            'splice: a far end that sums two sources is a mixing point, not a chain')

    # ... but a box fanning out from two DIFFERENT ports is carrying two signals, and
    # which of them the new box would sit in is a choice nobody made
    host = FakeHost()
    wide = host.add('wide', 'urn:test:stereo')
    left = host.add('left', 'urn:test:mono')
    right = host.add('right', 'urn:test:mono')
    host.connect(wide + '/out_l', left + '/in')
    host.connect(wide + '/out_r', right + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    r.check(mm.splice_plan(host, ids[wide], 1) is None,
            'splice: two ports going two ways is a choice, and is left alone')
    r.check(mm.splice_plan(host, ids[wide], 2) is None,
            'splice: whatever the new box has to offer')

    host = FakeHost()
    host.midiports = [('/graph/serial_midi_in', 'MIDI', '')]
    src = host.add('src', 'urn:test:cv')
    dst = host.add('dst', 'urn:test:cv')
    host.connect(src + '/out', dst + '/in')
    host.connect(src + '/cv_out', dst + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    r.check(mm.splice_plan(host, ids[src], 1) is None,
            'splice: a chain carrying more than audio is not rearranged unasked')

    r.check(mm.splice_plan(host, -1, 1) is None,
            'splice: nothing selected means nothing to splice into')
    r.check(mm.splice_plan(host, 31337, 1) is None,
            'splice: an id that is not there resolves to no plan')

    # the endpoints have to be exactly what Host.disconnect() takes, or the splice cuts
    # nothing and the new box is wired in alongside the cable it was meant to replace
    host = FakeHost()
    gain = host.add('gain', 'urn:test:mono')
    amp = host.add('amp', 'urn:test:mono')
    host.connect(gain + '/out', amp + '/in')

    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    plan = mm.splice_plan(host, ids[gain], 1)
    r.check(plan and all(link in host.connections for link in plan['cut']),
            'splice: the cables named are cables the host actually holds', plan)


def check_unsplice(r):
    """Closing the chain back over a box that has been removed.

    The inverse of check_splice, and the interesting part is that it really is the
    inverse: splicing a box into a chain and then removing it again has to leave the
    board exactly as it started, whichever of the three shapes the splice took.
    """
    mm = plugin_map.INSTANCE

    def board(kinds, cables):
        host = FakeHost()
        names = {}
        for name, uri in kinds:
            names[name] = host.add(name, uri)
        for a, b in cables:
            host.connect(names[a[0]] + '/' + a[1], names[b[0]] + '/' + b[1])
        ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
        return host, names, ids

    # -- the plain case: one cable in, one out, one cable back ------------------------
    host, names, ids = board(
        [('gain', 'urn:test:mono'), ('trem', 'urn:test:mono'), ('amp', 'urn:test:mono')],
        [(('gain', 'out'), ('trem', 'in')), (('trem', 'out'), ('amp', 'in'))])

    plan = mm.unsplice_plan(host, ids[names['trem']])
    r.check(plan and plan['links'] == [(names['gain'] + '/out', names['amp'] + '/in')],
            'unsplice: a box in a mono chain is closed over', plan)

    # -- stereo, paired by the removed box's own ports so nothing crosses --------------
    host, names, ids = board(
        [('a', 'urn:test:stereo'), ('mid', 'urn:test:stereo'), ('b', 'urn:test:stereo')],
        [(('a', 'out_r'), ('mid', 'in_r')), (('a', 'out_l'), ('mid', 'in_l')),
         (('mid', 'out_l'), ('b', 'in_l')), (('mid', 'out_r'), ('b', 'in_r'))])

    plan = mm.unsplice_plan(host, ids[names['mid']])
    r.check(plan and plan['links'] == [(names['a'] + '/out_l', names['b'] + '/in_l'),
                                       (names['a'] + '/out_r', names['b'] + '/in_r')],
            'unsplice: a stereo pair comes back left to left', plan)

    # -- a stereo box between two mono ends: both channels, one cable back -------------
    host, names, ids = board(
        [('gain', 'urn:test:mono'), ('wide', 'urn:test:stereo'), ('amp', 'urn:test:mono')],
        [(('gain', 'out'), ('wide', 'in_l')), (('gain', 'out'), ('wide', 'in_r')),
         (('wide', 'out_l'), ('amp', 'in')), (('wide', 'out_r'), ('amp', 'in'))])

    plan = mm.unsplice_plan(host, ids[names['wide']])
    r.check(plan and plan['links'] == [(names['gain'] + '/out', names['amp'] + '/in')],
            'unsplice: the split and the sum collapse back to the one cable', plan)

    # -- and the round trip, which is the whole point ----------------------------------
    MONO, STEREO_URI = 'urn:test:mono', 'urn:test:stereo'

    # label, what is being inserted, the two ends, the wiring between them
    for label, uri, ends, wiring in (
            ('mono', MONO, (MONO, MONO),
             [(('gain', 'out'), ('amp', 'in'))]),
            ('stereo', STEREO_URI, (STEREO_URI, STEREO_URI),
             [(('gain', 'out_l'), ('amp', 'in_l')), (('gain', 'out_r'), ('amp', 'in_r'))]),
            ('split', STEREO_URI, (MONO, MONO),
             [(('gain', 'out'), ('amp', 'in'))]),
            # one output feeding both inputs of a stereo box, with a mono plugin going in
            # front of the split: the shape the device was refusing to splice at all
            ('fanned', MONO, (MONO, STEREO_URI),
             [(('gain', 'out'), ('amp', 'in_l')), (('gain', 'out'), ('amp', 'in_r'))]),
            # a mono pedal in a stereo run: summed on the way in, split again on the way
            # out, and taking it back out has to leave the run stereo as it found it
            ('summed', MONO, (STEREO_URI, STEREO_URI),
             [(('gain', 'out_l'), ('amp', 'in_l')),
              (('gain', 'out_r'), ('amp', 'in_r'))])):

        host, names, ids = board([('gain', ends[0]), ('amp', ends[1])], wiring)
        before = sorted(host.connections)

        channels = 2 if uri == STEREO_URI else 1
        plan = mm.splice_plan(host, ids[names['gain']], channels)
        r.check(plan is not None, 'unsplice: the %s board splices at all' % label)
        if plan is None:
            continue

        # play the splice out on the fake board, the way Host._splice_plugin does
        mid = host.add('mid', uri)
        ins, outs = (['in_l', 'in_r'], ['out_l', 'out_r']) if channels == 2 \
                    else (['in'], ['out'])

        for link in plan['cut']:
            host.connections.remove(link)
        for source, channel in plan['feed']:
            host.connect(source, mid + '/' + ins[channel])
        for channel, target in plan['drain']:
            host.connect(mid + '/' + outs[channel], target)

        ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
        undo = mm.unsplice_plan(host, ids[mid])
        r.check(undo is not None, 'unsplice: the %s board closes again' % label)
        if undo is None:
            continue

        # remove the box the way Host.remove_plugin does, then lay what the plan named
        host.connections = [c for c in host.connections if not c[0].startswith(mid)
                            and not c[1].startswith(mid)]
        for link in undo['links']:
            host.connect(link[0], link[1])

        r.check(sorted(host.connections) == before,
                'unsplice: %s splices and closes back to the board it started from'
                % label, (sorted(host.connections), before))

    # -- what has to be left open ------------------------------------------------------
    host, names, ids = board(
        [('head', 'urn:test:mono'), ('one', 'urn:test:mono'), ('two', 'urn:test:mono')],
        [(('head', 'out'), ('one', 'in')), (('head', 'out'), ('two', 'in'))])
    r.check(mm.unsplice_plan(host, ids[names['head']]) is None,
            'unsplice: an end of the chain has nothing to join')
    r.check(mm.unsplice_plan(host, ids[names['one']]) is None,
            'unsplice: and neither has the other end')

    host, names, ids = board(
        [('a', 'urn:test:mono'), ('fan', 'urn:test:mono'),
         ('x', 'urn:test:mono'), ('y', 'urn:test:mono')],
        [(('a', 'out'), ('fan', 'in')),
         (('fan', 'out'), ('x', 'in')), (('fan', 'out'), ('y', 'in'))])
    # one cable in, one signal out to two places: closing over it puts the split back
    plan = mm.unsplice_plan(host, ids[names['fan']])
    r.check(plan and plan['links'] == [(names['a'] + '/out', names['x'] + '/in'),
                                       (names['a'] + '/out', names['y'] + '/in')],
            'unsplice: a fan out closes back to the same fan out', plan)

    # A box fed on one input and leaving from two ports is what made those two ends
    # differ; without it they carry the one signal that was feeding it, so both get it.
    host, names, ids = board(
        [('a', 'urn:test:mono'), ('wide', 'urn:test:stereo'),
         ('x', 'urn:test:mono'), ('y', 'urn:test:mono')],
        [(('a', 'out'), ('wide', 'in_l')),
         (('wide', 'out_l'), ('x', 'in')), (('wide', 'out_r'), ('y', 'in'))])
    plan = mm.unsplice_plan(host, ids[names['wide']])
    r.check(plan and plan['links'] == [(names['a'] + '/out', names['x'] + '/in'),
                                       (names['a'] + '/out', names['y'] + '/in')],
            'unsplice: what fed it reaches both ends it was feeding', plan)

    # what stays refused: several boxes feeding it, since joining each of them to each
    # end would wire together paths that never met
    host, names, ids = board(
        [('a', 'urn:test:mono'), ('b', 'urn:test:mono'),
         ('mid', 'urn:test:stereo'), ('z', 'urn:test:mono')],
        [(('a', 'out'), ('mid', 'in_l')), (('b', 'out'), ('mid', 'in_r')),
         (('mid', 'out_l'), ('z', 'in'))])
    r.check(mm.unsplice_plan(host, ids[names['mid']]) is None,
            'unsplice: two boxes feeding it is a mixing point, and is left open')

    host, names, ids = board(
        [('src', 'urn:test:cv'), ('mid', 'urn:test:cv'), ('dst', 'urn:test:cv')],
        [(('src', 'out'), ('mid', 'in')), (('src', 'cv_out'), ('mid', 'in')),
         (('mid', 'out'), ('dst', 'in')), (('mid', 'cv_out'), ('dst', 'in'))])
    r.check(mm.unsplice_plan(host, ids[names['mid']]) is None,
            'unsplice: a chain carrying more than audio is left alone')

    r.check(mm.unsplice_plan(host, -1) is None,
            'unsplice: nothing selected closes nothing')


def check_bindings(r):
    """The binding manager's two columns, and what DEL is offered on.

    Everything crosses the wire as a position, so what matters is that both sides derive
    the same order from the same data. The awkward part is that a knob is not one slot: the
    panel turns its knobs over in sub-pages, an addressing records which one it was made
    on, and the list has to say so without the device ever hearing the word.
    """
    from mod import builder_bindings as bindings

    class FakeAddressings(object):
        addressing_pages = 8
        has_hmi_subpages = True

        def __init__(self):
            # deliberately out of order, and with a Control Chain pedal in the middle
            self.hw_actuators = [
                {'uri': '/hmi/footswitch2', 'name': 'FSW C'},
                {'uri': '/hmi/knob2', 'name': 'Knob 2'},
                {'uri': '/cc/1/2', 'name': 'Some Pedal'},
                {'uri': '/hmi/knob1', 'name': 'Knob 1'},
                {'uri': '/hmi/footswitch1,2', 'name': 'FSW BC',
                 'actuator_group': ['/hmi/footswitch1', '/hmi/footswitch2']},
                {'uri': '/hmi/knob3', 'name': 'Knob 3'},
                {'uri': '/hmi/footswitch1', 'name': 'FSW B'},
            ]
            self.hmi_addressings = dict((a['uri'], {'addrs': [], 'idx': -1})
                                        for a in self.hw_actuators)

        def get_actuators(self):
            return list(self.hw_actuators)

    class FakeMapper(object):
        def __init__(self):
            self.id_map = {}

    class Board(object):
        def __init__(self):
            self.addressings = FakeAddressings()
            self.mapper = FakeMapper()
            self.plugins = {}

        def add(self, instance_id, instance, uri, bypassed=False):
            self.plugins[instance_id] = {
                'instance': instance, 'uri': uri, 'bypassed': bypassed,
                'ports': {'gain': 0.5}, 'ranges': {'gain': (-20.0, 20.0)},
                'addressings': {},
            }
            self.mapper.id_map[instance_id] = instance

    def essentials(uri):
        return {'controlInputs': [
            {'symbol': 'gain', 'name': 'Input Gain',
             'ranges': {'minimum': -30.0, 'maximum': 30.0, 'default': 0.0}},
            {'symbol': 'tone', 'name': 'Tone',
             'ranges': {'minimum': 0.0, 'maximum': 1.0, 'default': 0.5}},
        ]}

    bindings.set_info_provider(essentials)

    host = Board()
    host.add(1, '/graph/drive', 'urn:test:mono')

    # -- column two: every slot, not every actuator -------------------------------------
    listed = bindings.actuators(host)

    r.check([(a['uri'], a['subpage']) for a in listed] == [
                ('/hmi/knob1', 0), ('/hmi/knob2', 0), ('/hmi/knob3', 0),
                ('/hmi/knob1', 1), ('/hmi/knob2', 1), ('/hmi/knob3', 1),
                ('/hmi/knob1', 2), ('/hmi/knob2', 2), ('/hmi/knob3', 2),
                ('/hmi/footswitch1', 0), ('/hmi/footswitch2', 0),
                ('/hmi/footswitch1,2', 0)],
            'bindings: three knobs over three sub-pages, then the footswitches once each',
            [(a['uri'], a['subpage']) for a in listed])

    r.check([a['label'] for a in listed[:4]] ==
            ['KNOB_1_I', 'KNOB_2_I', 'KNOB_3_I', 'KNOB_1_II'],
            'bindings: and the sub-page is on the label, since the panel shows nine knobs',
            [a['label'] for a in listed[:4]])

    r.check(all(' ' not in a['label'] for a in listed),
            'bindings: actuator labels are wire safe', [a['label'] for a in listed])
    r.check([a['index'] for a in listed] == list(range(12)),
            'bindings: the index is the position the device is shown')

    # a Control Chain pedal is not something the panel can put a finger on
    r.check(not [a for a in listed if not a['uri'].startswith('/hmi/')],
            'bindings: only the panel is listed')

    # a panel without sub-pages lists each knob once, and records no sub-page at all
    host.addressings.has_hmi_subpages = False
    plain = bindings.actuators(host)
    r.check(len(plain) == 6 and all(a['subpage'] is None for a in plain),
            'bindings: a panel that does not turn over lists each actuator once',
            [(a['uri'], a['subpage']) for a in plain])
    r.check(plain[0]['label'] == 'KNOB_1',
            'bindings: and its labels carry no numeral', plain[0]['label'])
    host.addressings.has_hmi_subpages = True

    # -- column one ---------------------------------------------------------------------
    params = bindings.parameters(host, 1)
    r.check([p['symbol'] for p in params] == [':bypass', 'gain', 'tone'],
            'bindings: bypass first, then the ports the plugin declares',
            [p['symbol'] for p in params])

    r.check(params[1]['minimum'] == -20.0 and params[1]['maximum'] == 20.0,
            'bindings: a port that has been ranged keeps the range it was given', params[1])
    r.check(params[1]['value'] == 0.5,
            'bindings: and the value it is actually at', params[1])
    r.check(params[2]['value'] == 0.5 and params[2]['maximum'] == 1.0,
            'bindings: one never touched falls back to what the plugin declares', params[2])

    r.check(bindings.parameters(host, 31337) == [],
            'bindings: a box that is not there offers nothing')
    r.check(bindings.parameter_at(host, 1, 99) is None,
            'bindings: a position that is not there resolves to nothing')

    # -- what is spoken for, by page and by sub-page -------------------------------------
    r.check(bindings.taken(host, 0) == {},
            'bindings: an untouched board holds no slots')

    host.addressings.hmi_addressings['/hmi/knob2']['addrs'].append(
        {'instance_id': 1, 'port': 'gain', 'label': 'Input Gain', 'page': 3, 'subpage': 2})

    # knob 2 of sub-page III is row 7, and none of the other eight knob slots
    r.check(bindings.taken(host, 3) == {7: 'INPUT_GAIN'},
            'bindings: the slot marked is the one sub-page it was made on',
            bindings.taken(host, 3))
    r.check(bindings.taken(host, 0) == {},
            'bindings: and it is on no other page', bindings.taken(host, 0))

    held = bindings.slot(host, 3, 7)
    r.check(held and held['instance'] == '/graph/drive' and held['portsymbol'] == 'gain',
            'bindings: DEL resolves the slot back to the port holding it', held)
    r.check(held and held['subpage'] == 2,
            'bindings: carrying the sub-page it has to unaddress on', held)
    r.check(bindings.slot(host, 3, 1) is None,
            'bindings: the same knob on another sub-page is a different slot')
    r.check(bindings.slot(host, 3, 99) is None,
            'bindings: and a row that is not there resolves to nothing')

    # A parameter holds one addressing, so binding it elsewhere frees the slot it was on
    # and the device has to be told which mark to drop -- by row, not by actuator, since
    # the same knob is a different row on each sub-page.
    listed = bindings.actuators(host)
    r.check(bindings.index_of(listed, '/hmi/knob2', 2) == 7,
            'bindings: a slot is found by its actuator and its sub-page together',
            bindings.index_of(listed, '/hmi/knob2', 2))
    r.check(bindings.index_of(listed, '/hmi/knob2', 0) == 1,
            'bindings: the same knob on another sub-page is another row')
    r.check(bindings.index_of(listed, '/hmi/knob9', 0) == -1,
            'bindings: an actuator that is not there is no row at all')

    r.check(bindings.pages(host) == 8, 'bindings: the board has its pages')
    r.check(bindings.subpages(host) == 3, 'bindings: and its knobs turn over three times')

    bindings.set_info_provider(None)


def check_cable_clearance(r):
    """No cable may run through a box that is not one of its own ends.

    A cable skipping columns would otherwise be drawn straight from stub to stub,
    ploughing through everything in between. The renderer clears the inside of a
    box before drawing its border, so the cable disappears into one box and comes
    out of another -- which reads as a chain of connections that do not exist.
    """
    for name, factory in SCENARIOS:
        host = factory()
        mm = plugin_map.PluginMap()
        scene = mm.scene(host)

        through = []
        for edge in scene.edges:
            for node in scene.nodes:
                if node is edge.src or node is edge.dst:
                    continue
                x0, y0 = node.x, node.y
                x1, y1 = node.x + node.w - 1, node.y + node.h - 1
                for (ax, ay), (bx, by) in zip(edge.points, edge.points[1:]):
                    if ay == by and y0 <= ay <= y1 and min(ax, bx) < x1 and max(ax, bx) > x0:
                        through.append((edge.src.label, edge.dst.label, node.label))
                        break
                    if ax == bx and x0 <= ax <= x1 and min(ay, by) < y1 and max(ay, by) > y0:
                        through.append((edge.src.label, edge.dst.label, node.label))
                        break

        r.check(not through, 'clearance %s: no cable runs through a box' % name,
                through[:5])


def check_viewport_coverage(r):
    """Nothing drawn on the panel may be missing from the message.

    The device pans a viewport over the scene and draws whatever the display list
    holds. If a box falls inside the viewport but outside the window, the panel
    shows a gap where a plugin is -- which is what happened when the window was
    picked by graph distance: stepping to the box next door swapped the picture
    for a different neighbourhood and boxes on screen disappeared.

    Modelled on the firmware: plugin_map_select() centres the selection horizontally
    and clamps, but scrolls vertically only when the box would not fit whole on the
    panel. Where it is looking vertically therefore depends on how the user got
    there, so the check is made against every position that keeps the focus fully
    visible -- if any of them would draw a box the message does not carry, that is
    a gap waiting to happen.
    """
    view_w, view_h = PLUGIN_MAP_HMI_VIEW_WIDTH, PLUGIN_MAP_HMI_VIEW_HEIGHT

    for name, factory in SCENARIOS:
        host = factory()
        mm = plugin_map.PluginMap()
        scene = mm.scene(host)

        missing = []
        for node in scene.nodes:
            ids = set(n['nid'] for n in
                      parse_displaylist(mm.render(host, focus=node.key)[0])['N'])

            limit = max(0, scene.width - view_w)
            ox = max(0, min(node.x + node.w // 2 - view_w // 2, limit))

            # any vertical position that keeps this box whole on the panel
            top = node.y + node.h - view_h
            bottom = node.y + view_h

            for other in scene.nodes:
                on_screen = (other.x < ox + view_w and other.x + other.w > ox and
                             other.y < bottom and other.y + other.h > top)
                if on_screen and other.nid not in ids:
                    missing.append((node.label, other.label))

        r.check(not missing,
                'viewport %s: every box on screen is in the message' % name,
                missing[:5])


def check_connections(r):
    """The connection menu's two lookups: what to list, and what to drop for it.

    Listing groups by the box at the far end and the signal type, so a stereo pair
    is one entry. Deleting that entry has to find both cables behind it, which is
    what links_between() is for -- and its endpoints have to come back in the exact
    form Host.disconnect() takes, or the delete silently does nothing.
    """
    host = FakeHost()
    host.midiports = [('/graph/serial_midi_in', 'MIDI', '')]
    left = host.add('left', 'urn:test:stereo', 100, 100)
    right = host.add('right', 'urn:test:stereo', 300, 100)
    host.connect(left + '/out_l', right + '/in_l')
    host.connect(left + '/out_r', right + '/in_r')
    host.connect('/graph/capture_1', left + '/in_l')
    host.connect(right + '/out_l', '/graph/playback_1')

    mm = plugin_map.INSTANCE
    scene = mm.scene(host)
    ids = dict((n.key, n.nid) for n in scene.nodes)

    entries = mm.connections(host, ids[right])
    kinds = [(e['direction'], e['label']) for e in entries]
    r.check(kinds == [('i', 'LEFT'), ('o', 'OUT1')],
            'connections: one entry per far box, sources first', kinds)

    r.check(all(' ' not in e['label'] and ';' not in e['label'] and '"' not in e['label']
                for e in entries),
            'connections: labels are wire safe', [e['label'] for e in entries])

    # the stereo pair is one entry and two cables
    links = mm.links_between(host, ids[left], ids[right])
    r.check(sorted(links) == sorted([(left + '/out_l', right + '/in_l'),
                                     (left + '/out_r', right + '/in_r')]),
            'connections: a stereo line stands for both its cables', links)

    r.check(all(link in host.connections for link in links),
            'connections: endpoints match what the host actually holds', links)

    # The strip under the menu names the cables behind one line, and it is the compact
    # picture that collapsed them, so the names have to be dug back out of the model.
    incoming = entries[0]
    r.check(sorted(incoming['pairs']) == [('OUT_L', 'IN_L'), ('OUT_R', 'IN_R')],
            'connections: a collapsed line still carries both its cables', incoming['pairs'])

    r.check(all(pair[0].startswith('OUT') for pair in incoming['pairs']),
            'connections: the feeding end comes first however we face the cable',
            incoming['pairs'])

    outgoing = entries[1]
    r.check(outgoing['pairs'] == [('OUT_L', 'PLAYBACK_1')],
            'connections: hardware ends are named too', outgoing['pairs'])

    r.check(all(' ' not in name and ';' not in name and '"' not in name
                for e in entries for pair in e['pairs'] for name in pair),
            'connections: port names are wire safe')

    # the budget is what keeps the whole menu inside the device's receive buffer
    saved = plugin_map.PLUGIN_MAP_MAX_PAIRS
    try:
        plugin_map.PLUGIN_MAP_MAX_PAIRS = 1
        starved = mm.connections(host, ids[right])
        r.check([len(e['pairs']) for e in starved] == [1, 0],
                'connections: the pair budget runs out on the later lines, not the first',
                [len(e['pairs']) for e in starved])
    finally:
        plugin_map.PLUGIN_MAP_MAX_PAIRS = saved

    # asking for a type nothing uses must come back empty, not with everything
    midi_only = mm.connections(host, ids[right], 2)
    r.check(not midi_only, 'connections: the type filter really filters', midi_only)

    audio_only = mm.connections(host, ids[right], 1)
    r.check(len(audio_only) == len(entries),
            'connections: filtering on the only type present changes nothing')

    r.check(not mm.links_between(host, ids[right], ids[left]),
            'connections: direction is not symmetric')

    check_menu_wire_format(r)


def check_menu_wire_format(r):
    """The menu response as parse_connections() in the firmware reads it.

    Five tokens an entry and then two more per cable, so the stride is no longer
    fixed and the parser walks it with a cursor. Anything that puts a space in a
    name, or miscounts the pairs, slides every later entry along by one field --
    which shows up on the device as garbled rows rather than as an error. The
    whole thing also has to fit WEBGUI_COMM_RX_BUFF_SIZE, since a longer answer is
    truncated on arrival with nothing to say so.
    """
    WEBGUI_COMM_RX_BUFF_SIZE = 4096

    for name, factory in SCENARIOS:
        host = factory()
        mm = plugin_map.INSTANCE
        scene = mm.scene(host)

        worst = 0
        for node in scene.nodes:
            entries = mm.connections(host, node.nid)

            # exactly what Host.hmi_builder_connection_list builds
            fields = [str(len(entries))]
            for entry in entries:
                pairs = entry['pairs']
                fields += [entry['direction'], str(entry['nid']), str(entry['bits']),
                           entry['label'], str(len(pairs))]
                for source, sink in pairs:
                    fields += [source, sink]

            response = ' '.join(fields)
            worst = max(worst, len(response))

            # ... and now the firmware's side of it
            tokens = response.split(' ')
            at, read = 1, []
            for _ in range(int(tokens[0])):
                pairs = int(tokens[at + 4])
                read.append((tokens[at], int(tokens[at + 1]), tokens[at + 3],
                             [(tokens[at + 5 + 2 * p], tokens[at + 6 + 2 * p])
                              for p in range(pairs)]))
                at += 5 + 2 * pairs

            r.check(at == len(tokens),
                    'wire %s: the menu parses with nothing left over' % name,
                    (at, len(tokens)))
            r.check(read == [(e['direction'], e['nid'], e['label'], list(e['pairs']))
                             for e in entries],
                    'wire %s: every entry survives the round trip' % name)

        r.check(worst < WEBGUI_COMM_RX_BUFF_SIZE,
                'wire %s: the longest menu fits the receive buffer' % name, worst)

    # The wire format the firmware reads back: three tokens of header and then four per
    # entry, split on spaces like every other HMI message. A label with a space in it
    # would shift every field after it and the menu would fill with rubbish.
    response = str(len(entries))
    for entry in entries:
        response += ' %s %d %d %s' % (entry['direction'], entry['nid'],
                                      entry['bits'], entry['label'])
    tokens = ('r 1 ' + response).split(' ')
    r.check(len(tokens) == 3 + 4 * len(entries),
            'connections: the response splits into four tokens an entry',
            (len(tokens), 3 + 4 * len(entries)))
    r.check(int(tokens[2]) == len(entries),
            'connections: the count matches what follows it')
    for index, entry in enumerate(entries):
        field = tokens[3 + index * 4:7 + index * 4]
        r.check(field[0] in ('i', 'o') and int(field[1]) == entry['nid']
                and int(field[2]) == entry['bits'] and field[3] == entry['label'],
                'connections: entry %d survives the split' % index, field)


def check_new_connection(r):
    """Making a connection from the device, the way the four menus walk it.

    Our own port first, and it settles everything after: an input of ours wants somebody's
    output, an output wants somebody's input, and the type has to match too. The device
    names ports by position, so both sides have to derive the same ordering from the same
    data -- that, and the whole thing undoing cleanly, is what these check.
    """
    host = FakeHost()
    mono = host.add('mono', 'urn:test:mono', 100, 100)
    wide = host.add('wide', 'urn:test:stereo', 300, 100)
    host.connect('/graph/capture_1', mono + '/in')

    mm = plugin_map.INSTANCE
    ids = dict((n.key, n.nid) for n in mm.scene(host).nodes)
    before = sorted(host.connections)

    # step one: our own ports, both sides, inputs first
    ours = mm.ports(host, ids[wide], 1, None)
    r.check([p['label'] for p in ours] == ['IN_L', 'IN_R', 'OUT_L', 'OUT_R'],
            'new connection: our own ports come inputs first',
            [p['label'] for p in ours])
    r.check([p['direction'] for p in ours] == ['o', 'o', 'i', 'i'],
            'new connection: and the letter says which side each one is',
            [p['direction'] for p in ours])
    r.check([p['index'] for p in ours] == [0, 1, 0, 1],
            'new connection: and the index counts within its own side, not across both',
            [p['index'] for p in ours])

    # step two: what a port of ours could meet is the other kind, never the same
    outgoing = mm.candidates(host, ids[wide], 1, False)
    incoming = mm.candidates(host, ids[wide], 1, True)
    r.check(all(c['direction'] == 'o' for c in outgoing) and outgoing,
            'new connection: our output is offered boxes to feed',
            [c['direction'] for c in outgoing])
    r.check(all(c['direction'] == 'i' for c in incoming) and incoming,
            'new connection: our input is offered boxes that feed it',
            [c['direction'] for c in incoming])
    r.check(ids[wide] not in [c['nid'] for c in outgoing + incoming],
            'new connection: a box is never offered itself')

    # a box wired to nothing is still reachable both ways: the side is ours to choose
    lonely = FakeHost()
    alone = lonely.add('alone', 'urn:test:mono', 100, 100)
    lonely.add('other', 'urn:test:mono', 300, 100)
    lonely_ids = dict((n.key, n.nid) for n in mm.scene(lonely).nodes)
    r.check(mm.candidates(lonely, lonely_ids[alone], 1, True)
            and mm.candidates(lonely, lonely_ids[alone], 1, False),
            'new connection: a box wired to nothing can be wired either way')

    # both lists read alphabetically: ordering by where a box sits in the picture puts
    # the likely one on top, but twenty rows arranged by graph distance read as no order
    labels = [c['label'] for c in outgoing]
    r.check(labels == sorted(labels), 'new connection: the targets are alphabetical', labels)

    # step three: their compatible ports, which are the mirror of ours and always asked
    # about -- a target with one port is still a choice the user gets to see
    theirs = mm.ports(host, ids[mono], 1, False)
    r.check([p['label'] for p in theirs] == ['IN'],
            'new connection: the far box offers the side that can meet ours',
            [p['label'] for p in theirs])
    r.check(all(p['direction'] == 'o' for p in theirs),
            'new connection: and marks them as the side that is fed',
            [p['direction'] for p in theirs])

    laid = mm.connect_port(host, ids[wide], 0, ids[mono], 0, 1)
    r.check(laid == [(wide + '/out_l', mono + '/in')],
            'new connection: the picked indexes are the ports that get wired', laid)

    host.connections.extend(laid)
    r.check(not mm.connect_port(host, ids[wide], 0, ids[mono], 0, 1),
            'new connection: the same cable is refused the second time')

    second = mm.connect_port(host, ids[wide], 1, ids[mono], 0, 1)
    r.check(second == [(wide + '/out_r', mono + '/in')],
            'new connection: the other port of the pair wires too', second)
    host.connections.extend(second)

    for source, target in laid + second:
        r.check('/out' in source, 'new connection: the cable leaves an output', source)
        r.check('/in' in target, 'new connection: and arrives at an input', target)

    for link in mm.links_between(host, ids[wide], ids[mono], 1):
        host.connections.remove(link)
    r.check(sorted(host.connections) == before,
            'new connection: the board comes back as it was', host.connections)

    # neither menu may outrun the rows the device has to put them in
    big = sc_stress()
    node = [n for n in mm.scene(big).nodes if n.kind == plugin_map.KIND_PLUGIN][0]
    for name, entries in (('connections', mm.connections(big, node.nid, 1)),
                          ('targets', mm.candidates(big, node.nid, 1, True)),
                          ('ports', mm.ports(big, node.nid, 1, None))):
        r.check(len(entries) <= PLUGIN_MAP_MAX_MENU,
                'new connection: the %s menu fits the device' % name, len(entries))


def check_plugin_catalog(r):
    """The Add screen's catalogue: categories, windowing, and what a pick resolves to.

    The device carries no URIs -- it names a plugin by its position in the two lists it
    was shown -- so the whole thing rests on both sides deriving the same ordering from
    the same data. That is what these check, along with the window sliding correctly
    over a category too long for one screenful.
    """
    from mod import builder_plugins as catalog

    made = []
    for index in range(120):
        made.append({'uri': 'urn:test:p%03d' % index,
                     'name': 'Plug %03d' % index,
                     'label': 'Plug %03d' % index,
                     'category': ['Delay' if index % 2 else 'Reverb']})
    made.append({'uri': 'urn:test:midi', 'name': 'Midi Thing', 'label': 'Midi Thing',
                 'category': ['MIDI']})

    # the index answers with a hierarchy: the family first, the LV2 class after it
    made.append({'uri': 'urn:test:low', 'name': 'Low Thing', 'label': 'Low Thing',
                 'category': ['Filter', 'Lowpass']})
    made.append({'uri': 'urn:test:comp', 'name': 'Comp Thing', 'label': 'Comp Thing',
                 'category': ['Dynamics', 'Compressor']})
    made.append({'uri': 'urn:test:bare', 'name': 'Bare Thing', 'label': 'Bare Thing',
                 'category': []})

    def info(uri):
        midi = uri.endswith('midi')
        return {
            'brand': 'Test Brand',
            'comment': 'A plugin that does a thing, and does it well enough.',
            'category': ['Delay'],
            'ports': {
                'audio': {'input': [] if midi else [1], 'output': [] if midi else [1]},
                'midi': {'input': [1] if midi else [], 'output': []},
                'cv': {'input': [], 'output': []},
            }}

    catalog.set_catalog_provider(lambda: made)
    catalog.set_info_provider(info)

    names = [c['name'] for c in catalog.categories()]
    r.check(names[:2] == ['All', 'Favorites'] or names[0] in ('All', 'Favorites'),
            'catalog: the made-up categories come before the LV2 ones', names)
    r.check('Delay' in names and 'Reverb' in names and 'MIDI' in names,
            'catalog: every category with something in it is listed', names)

    counts = dict((c['name'], c['count']) for c in catalog.categories())
    r.check(counts['All'] == 124, 'catalog: All holds everything', counts.get('All'))

    # Only the head of the hierarchy, the way the browser reads it. A sub-class listed as
    # a category of its own would be a tab the user has never seen in the web UI, and the
    # plugin under it would also be counted a second time under its family.
    r.check('Lowpass' not in counts and 'Compressor' not in counts,
            'catalog: an LV2 sub-class is not a category of its own', sorted(counts))
    r.check(counts.get('Filter') == 1 and counts.get('Dynamics') == 1,
            'catalog: and its plugin is counted once, under its family',
            (counts.get('Filter'), counts.get('Dynamics')))

    filtered = [p['name'] for p in catalog.plugins(
        [c['index'] for c in catalog.categories() if c['name'] == 'Filter'][0])]
    r.check(filtered == ['Low Thing'],
            'catalog: and it is still reachable under that family', filtered)

    r.check(not [c for c in catalog.categories() if c['count'] == 0],
            'catalog: a plugin with no category of its own lands in All alone')

    audio = dict((c['name'], c['count']) for c in catalog.categories(1))
    r.check('MIDI' not in audio,
            'catalog: a category left empty by the filter drops out', sorted(audio))
    r.check(audio['All'] == 123, 'catalog: and the counts follow the filter', audio.get('All'))

    # the window slides, and the indexes stay absolute so a pick means the same entry
    all_index = [c['index'] for c in catalog.categories() if c['name'] == 'All'][0]
    total, first, page = catalog.window(all_index, 0, 0, 48)
    r.check(total == 124 and first == 0 and len(page) == 48,
            'catalog: the first window is a screenful of a long category',
            (total, first, len(page)))

    total, first, tail = catalog.window(all_index, 0, 96, 48)
    r.check(first == 96 and len(tail) == 28 and tail[0]['index'] == 96,
            'catalog: the last window is short and still absolutely indexed',
            (first, len(tail), tail[0]['index'] if tail else None))

    picked = catalog.plugin_at(all_index, 96, 0)
    r.check(picked is not None and picked['uri'] == tail[0]['uri'],
            'catalog: a pick resolves to the entry at that position', picked)

    r.check(catalog.plugin_at(all_index, 999, 0) is None,
            'catalog: a position that is not there resolves to nothing')

    # labels have to survive the space-delimited protocol like every other menu
    r.check(all(' ' not in p['label'] and ';' not in p['label'] and '"' not in p['label']
                for p in page),
            'catalog: labels are wire safe')

    # the info overlay, addressed by the same two positions as the pick itself
    details = catalog.details(all_index, 96, 0)
    r.check(details and details['name'] == plugin_map.sanitize_label(picked['name'], 120),
            'catalog: info resolves the same entry a pick would',
            (details or {}).get('name'))
    r.check(details and details['audio'] == (1, 1) and details['midi'] == (0, 0),
            'catalog: info counts the ports by kind', details)
    r.check(catalog.details(all_index, 999, 0) is None,
            'catalog: info about a position that is not there is nothing')

    # every word its own token, so the description needs no escaping to cross a
    # space-delimited protocol and the device is free to wrap it where it likes
    r.check(details['comment'] and all(' ' not in word for word in details['comment']),
            'catalog: the description crosses the wire one word to a token',
            details['comment'][:4])
    r.check(len(details['comment']) == 11,
            'catalog: and every word of it arrives', details['comment'])

    # a new instance never collides with one already on the board
    class Board(object):
        plugins = {1: {'instance': '/graph/plug_000'}, 2: {'instance': '/graph/plug_000_2'}}

    r.check(catalog.instance_name(Board(), 'Plug 000') == '/graph/plug_000_3',
            'catalog: a third copy gets the next free name',
            catalog.instance_name(Board(), 'Plug 000'))
    r.check(catalog.instance_name(Board(), 'Brand New') == '/graph/brand_new',
            'catalog: a first copy keeps the plain name')

    # scrubbing: the letters of a category, and where each one starts
    letters = catalog.initials(all_index, 0)
    r.check(len(letters) < 121,
            'catalog: scrubbing turns a long list into a short one', len(letters))
    r.check([l['letter'] for l in letters] == sorted(set(l['letter'] for l in letters)),
            'catalog: the letters come in order and only once each',
            [l['letter'] for l in letters])

    listed = catalog.plugins(all_index, 0)
    for entry in letters:
        first = listed[entry['index']]
        r.check(first['label'][0].upper() == entry['letter'],
                'catalog: a letter lands on the first plugin that starts with it',
                (entry['letter'], first['label']))
        r.check(entry['index'] == 0
                or listed[entry['index'] - 1]['label'][0].upper() != entry['letter'],
                'catalog: and on the first, not the middle of the run', entry)

    catalog.set_catalog_provider(None)
    catalog.set_info_provider(None)


def check_compact(r):
    """The compact picture must actually collapse, and stay uniform.

    Built with a stereo pair and a four-into-one mixer, which is exactly what
    the model holds as a bundle of parallel cables.
    """
    host = FakeHost()
    split = host.add('split', 'urn:test:stereo', 100, 100)
    # two names that a five-character box cannot tell apart, which is the whole
    # reason the title bar gets a label of its own
    a = host.add('chan_a', 'urn:test:mono', 300, 40, label='Compressor Stereo')
    b = host.add('chan_b', 'urn:test:mono', 300, 90, label='Compressor Mono')
    c = host.add('chan_c', 'urn:test:mono', 300, 140)
    mix = host.add('mixer', 'urn:test:stereo', 500, 100)
    host.connect('/graph/capture_1', split + '/in_l')
    host.connect('/graph/capture_2', split + '/in_r')
    for target in (a, b, c):
        host.connect(split + '/out_l', target + '/in')
        host.connect(split + '/out_r', target + '/in')
    for source in (a, b, c):
        host.connect(source + '/out', mix + '/in_l')
        host.connect(source + '/out', mix + '/in_r')
    host.connect(mix + '/out_l', '/graph/playback_1')
    host.connect(mix + '/out_r', '/graph/playback_2')

    mm = plugin_map.INSTANCE
    compact = parse_displaylist(mm.render(host)[0])

    # the un-collapsed truth the picture is a summary of, and what the connection menu
    # asks when it needs to know which port feeds which
    raw_edges = mm.model(host)[1]

    pairs = [(e['src'], e['dst'], e['type']) for e in compact['E']]
    r.check(len(pairs) == len(set(pairs)),
            'compact: one cable per pair of boxes and signal type', pairs)
    r.check(len(compact['E']) < len(raw_edges),
            'compact: fewer lines drawn than there are cables',
            (len(compact['E']), len(raw_edges)))

    sizes = set((n['w'], n['h']) for n in compact['N'])
    r.check(len(sizes) == 1, 'compact: every box the same size', sizes)

    # one stub per side per signal type, never one per port
    per_side = {}
    for port in compact['P']:
        per_side.setdefault((port['nid'], port['dir'], port['type']), 0)
        per_side[(port['nid'], port['dir'], port['type'])] += 1
    r.check(all(v == 1 for v in per_side.values()),
            'compact: one stub per side and signal type',
            [k for k, v in per_side.items() if v != 1])

    r.check(len(compact['N']) == len(mm.model(host)[0]),
            'compact: no box goes missing',
            (len(compact['N']), len(mm.model(host)[0])))

    # the box is too narrow to tell two similarly named plugins apart, so the title
    # bar gets a label cut to the width of the panel instead
    by_title = dict((n['title'], n['label']) for n in compact['N'])
    r.check(len(by_title) == len(compact['N']),
            'compact: titles tell the boxes apart', sorted(by_title))
    longer = [n for n in compact['N'] if len(n['title']) > len(n['label'])]
    r.check(longer, 'compact: at least one title outgrows its box label')


def check_wire_safe_labels(r):
    """No label may carry a character the protocol tokenizer would choke on.

    The firmware rebuilds the display list in place over the tokens protocol.c
    split it into, so a space, a record separator or a quotation mark inside a
    label does not merely look wrong -- it makes that rebuild lossy.
    """
    host = FakeHost()
    host.add('quoted', label='say "hi" there')
    host.add('spaced', label='two words')
    host.add('semi', label='a;b')
    host.add('mixed', label='"; ok')

    mm = plugin_map.PluginMap()
    text, _ = mm.render(host)

    # every record must split into the field count its reader expects: one stray
    # delimiter inside a label shifts every field after it
    for record in text.split(plugin_map.RECORD_SEP):
        parts = record.strip().split(' ')
        if parts[0] == 'N':
            r.check(len(parts) == 12, 'wire-safe: N record has 12 fields', record)

    labels = [n['label'] for n in parse_displaylist(text)['N']]
    r.check(labels, 'wire-safe: labels came through', labels)
    r.check(all(' ' not in l and ';' not in l and '"' not in l for l in labels),
            'wire-safe: labels carry no delimiter', labels)


def check_compat(r):
    """Audit the new modules for syntax that Python 3.4 would reject."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = [
        os.path.join(root, 'mod', 'plugin_map.py'),
        os.path.join(root, 'mod', 'plugin_map_font.py'),
        os.path.join(root, 'mod', 'plugin_map_render.py'),
        os.path.join(root, 'modtools', 'font2py.py'),
    ]
    banned_names = ('math.inf', 'textbbox', 'textlength', 'load_default(',
                    'Image.Resampling', 'import typing')

    for path in targets:
        if not os.path.exists(path):
            continue
        name = os.path.relpath(path, root)
        with open(path, 'r', errors='replace') as fh:
            source = fh.read()

        try:
            tree = ast.parse(source, filename=path)
        except SyntaxError as ex:
            r.check(False, 'compat %s: parses' % name, ex)
            continue

        offenders = []
        for node in ast.walk(tree):
            if node.__class__.__name__ == 'JoinedStr':
                offenders.append('f-string at line %d' % getattr(node, 'lineno', 0))
            elif node.__class__.__name__ == 'AnnAssign':
                offenders.append('variable annotation at line %d' % getattr(node, 'lineno', 0))
            elif node.__class__.__name__ == 'MatMult':
                offenders.append('matrix multiply operator')
        r.check(not offenders, 'compat %s: no post-3.4 syntax' % name, offenders[:5])

        hits = [n for n in banned_names if n in source]
        r.check(not hits, 'compat %s: no post-3.4 library calls' % name, hits)

        underscores = re.findall(r'\b\d+_\d+\b', source)
        r.check(not underscores, 'compat %s: no underscores in numeric literals' % name,
                underscores[:5])


# ---------------------------------------------------------------------------
# reference rendering
# ---------------------------------------------------------------------------

def write_preview(name, mm, host, out_dir):
    try:
        from mod import plugin_map_render
    except ImportError:
        return
    if not plugin_map_render.available():
        return

    scene = mm.scene(host)
    img = plugin_map_render.render(scene)
    if img is None:
        return
    try:
        os.makedirs(out_dir, exist_ok=True)
        img.save(os.path.join(out_dir, '%s.png' % name))
        view = plugin_map_render.render(scene, crop=(0, 0, 128, 64))
        view.save(os.path.join(out_dir, '%s-view.png' % name))
    except Exception as ex:
        sys.stderr.write('preview %s failed: %s\n' % (name, ex))


def show(name):
    factory = dict(SCENARIOS).get(name)
    if factory is None:
        print('unknown scenario %r; available: %s' % (name, ', '.join(n for n, _ in SCENARIOS)))
        return 1

    host = factory()
    mm = plugin_map.PluginMap()
    text, _ = mm.render(host)
    print(text)

    try:
        from mod import plugin_map_render
    except ImportError:
        return 0
    if not plugin_map_render.available():
        print('(PIL not available, skipping ASCII art)')
        return 0

    print(plugin_map_render.to_ascii(mm.scene(host)))
    return 0


def bench():
    print('== benchmark ==')
    for name, factory in (('linear', sc_linear), ('stress-40', sc_stress)):
        host = factory()
        mm = plugin_map.PluginMap()

        start = time.perf_counter()
        mm.render(host)
        cold = (time.perf_counter() - start) * 1000.0

        start = time.perf_counter()
        for _ in range(200):
            mm.render(host)
        warm = (time.perf_counter() - start) * 1000.0 / 200.0

        start = time.perf_counter()
        for _ in range(200):
            mm.fingerprint(host)
        fp = (time.perf_counter() - start) * 1000.0 / 200.0

        text, _ = mm.render(host)
        print('  %-10s cold %6.2f ms | cached %6.3f ms | fingerprint %6.3f ms | %5d bytes'
              % (name, cold, warm, fp, len(text)))


def main():
    parser = argparse.ArgumentParser(description='PluginMap checks')
    parser.add_argument('--out', help='directory for reference PNGs')
    parser.add_argument('--check-compat', action='store_true', help='only run the 3.4 audit')
    parser.add_argument('--show', help='print one scenario and exit')
    parser.add_argument('--no-font', action='store_true', help='skip the font proof sheet')
    args = parser.parse_args()

    if args.show:
        return show(args.show)

    r = Results()

    if args.check_compat:
        check_compat(r)
        return r.report()

    if not args.no_font:
        check_font(r)

    print('== scenarios ==')
    for name, factory in SCENARIOS:
        check_scenario(r, name, factory(), args.out)
        print('  %s' % name)

    print('')
    print('== invariants ==')
    check_wire_sufficiency(r)
    check_insertion_order(r)
    check_layers(r)
    check_windowing(r)
    check_caching(r)
    check_hmi_request(r)
    check_cable_clearance(r)
    check_viewport_coverage(r)
    check_connections(r)
    check_splice(r)
    check_unsplice(r)
    check_bindings(r)
    check_plugin_catalog(r)
    check_new_connection(r)
    check_compact(r)
    check_wire_safe_labels(r)
    check_compat(r)

    print('')
    bench()

    return r.report()


if __name__ == '__main__':
    sys.exit(main())
