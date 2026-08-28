#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Standalone checks for the pedalboard minimap.

Runs without JACK, LV2 or mod-host: a FakeHost mirrors the real Host attributes
and get_plugin_info is stubbed, so this works on a plain desktop checkout.

    python test/test_minimap.py                 # run everything
    python test/test_minimap.py --out DIR       # also write reference PNGs
    python test/test_minimap.py --check-compat  # Python 3.4 syntax audit
    python test/test_minimap.py --show NAME     # ASCII art for one scenario
"""

import argparse
import ast
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mod import minimap
from mod import minimap_font as font
from mod.settings import MINIMAP_MAX_MSG, MINIMAP_WIN_PLUGINS


# ---------------------------------------------------------------------------
# fakes
# ---------------------------------------------------------------------------

class FakeHost(object):
    """Mirrors the attributes mod/minimap.py reads off the real Host."""

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


minimap.set_plugin_info_provider(fake_plugin_info)


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
    for line in text.splitlines():
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
                'nid': int(parts[1]), 'up': int(parts[2]), 'down': int(parts[3]),
                'left': int(parts[4]), 'right': int(parts[5]),
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
    mm = minimap.Minimap()
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

    r.check(m['w'] >= 128 and m['h'] >= 64,
            '%s: scene is never smaller than the 128x64 viewport' % prefix,
            '%dx%d' % (m['w'], m['h']))
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

    # adjacency: only known ids, no self references
    ids = set(nodes_by_id)
    bad_adj = []
    for a in dl['A']:
        for direction in ('up', 'down', 'left', 'right'):
            target = a[direction]
            if target != -1 and (target not in ids or target == a['nid']):
                bad_adj.append((a['nid'], direction, target))
    r.check(not bad_adj, '%s: adjacency points only at drawn nodes' % prefix, bad_adj[:3])
    r.check(len(dl['A']) == len(dl['N']),
            '%s: every node has an adjacency record' % prefix)

    # labels are wire-safe: the format is space delimited
    spacey = [n['label'] for n in dl['N'] if ' ' in n['label']]
    r.check(not spacey, '%s: labels carry no spaces' % prefix, spacey[:3])

    # every plugin in host.plugins made it into the scene
    expected = len([p for k, p in host.plugins.items()])
    r.check(scene.plugin_count == expected,
            '%s: all %d plugins are present' % (prefix, expected),
            'got %d' % scene.plugin_count)

    # determinism: same graph, rebuilt from scratch
    mm2 = minimap.Minimap()
    text2, _ = mm2.render(host)
    r.check(strip_version(text) == strip_version(text2),
            '%s: render is deterministic' % prefix)

    if out_dir:
        write_preview(name, mm, host, out_dir)


def strip_version(text):
    return re.sub(r'^M (\d+) (\d+) \d+ ', r'M \1 \2 V ', text, flags=re.M)


def check_wire_sufficiency(r):
    """The display list alone must be enough to draw the picture.

    Rasterising from the emitted text and from the in-memory scene must produce
    identical pixels. This is the property Plan B rests on: if the wire format
    were missing something, the firmware could not draw it either, and we would
    only discover that once the firmware existed.
    """
    try:
        from mod import minimap_render
    except ImportError:
        return
    if not minimap_render.available():
        return

    for name, factory in SCENARIOS:
        host = factory()
        mm = minimap.Minimap()
        text, _ = mm.render(host)

        from_scene = minimap_render.render(mm.scene(host))
        from_wire = minimap_render.render_displaylist(text)

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

    a, _ = minimap.Minimap().render(build(['aa', 'bb', 'cc']))
    b, _ = minimap.Minimap().render(build(['cc', 'bb', 'aa']))
    r.check(strip_version(a) == strip_version(b),
            'insertion order does not change the picture',
            'differs:\n%s\n---\n%s' % (a[:300], b[:300]))


def check_layers(r):
    """Layer masks must hide cables without ever moving a box."""
    host = sc_mixed_types()
    mm = minimap.Minimap()

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
        mm = minimap.Minimap()
        scene = mm.scene(host)
        plugins = [n for n in scene.nodes if n.kind == minimap.KIND_PLUGIN]
        if not plugins:
            continue

        focus = plugins[0].key
        text, _ = mm.render(host, focus=focus)
        dl = parse_displaylist(text)

        r.check(len(text) <= MINIMAP_MAX_MSG,
                'window %s: message fits the firmware 4K buffer' % name,
                '%d bytes' % len(text))

        win_plugins = [n for n in dl['N'] if n['kind'] == minimap.KIND_PLUGIN]
        r.check(len(win_plugins) <= MINIMAP_WIN_PLUGINS,
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

        # coverage: walk adjacency and outgoing cables, fetching a new window
        # whenever we reach something outside, and expect to see every plugin
        all_plugin_ids = set(n.nid for n in plugins)
        reached = set()
        frontier = [focus]
        visited_focus = set()

        while frontier:
            key = frontier.pop(0)
            if key in visited_focus:
                continue
            visited_focus.add(key)
            wtext, _ = mm.render(host, focus=key)
            wdl = parse_displaylist(wtext)
            local = set()
            for n in wdl['N']:
                if n['kind'] == minimap.KIND_PLUGIN:
                    reached.add(n['nid'])
                    local.add(n['nid'])
            for e in wdl['E']:
                for nid in (e['src'], e['dst']):
                    if nid in all_plugin_ids and nid not in reached:
                        frontier.append(scene.nodes[nid].key)
            for a in wdl['A']:
                for direction in ('up', 'down', 'left', 'right'):
                    nid = a[direction]
                    if nid in all_plugin_ids and nid not in reached:
                        frontier.append(scene.nodes[nid].key)
            for nid in sorted(local):
                if nid in all_plugin_ids and scene.nodes[nid].key not in visited_focus:
                    frontier.append(scene.nodes[nid].key)

        r.check(reached == all_plugin_ids,
                'window %s: every plugin reachable by navigation' % name,
                'unreached: %s' % sorted(all_plugin_ids - reached)[:5])

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
    mm = minimap.Minimap()

    _, v1 = mm.render(host)
    _, v2 = mm.render(host)
    r.check(v1 == v2, 'cache: identical state does not bump the version')

    host.plugins[1]['bypassed'] = True
    _, v3 = mm.render(host)
    r.check(v3 > v2, 'cache: a bypass change bumps the version')

    host.plugins[1]['x'] = 999
    _, v4 = mm.render(host)
    r.check(v4 > v3, 'cache: a move bumps the version (it emits no message at all)')

    node = host.add('extra', 'urn:test:mono', 900, 100)
    host.connect(node + '/out', '/graph/playback_2')
    _, v5 = mm.render(host)
    r.check(v5 > v4, 'cache: adding a plugin bumps the version')

    host.connections.pop()
    _, v6 = mm.render(host)
    r.check(v6 > v5, 'cache: a silent connection removal is still noticed')


def check_compat(r):
    """Audit the new modules for syntax that Python 3.4 would reject."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = [
        os.path.join(root, 'mod', 'minimap.py'),
        os.path.join(root, 'mod', 'minimap_font.py'),
        os.path.join(root, 'mod', 'minimap_render.py'),
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
        from mod import minimap_render
    except ImportError:
        return
    if not minimap_render.available():
        return

    scene = mm.scene(host)
    img = minimap_render.render(scene)
    if img is None:
        return
    try:
        os.makedirs(out_dir, exist_ok=True)
        img.save(os.path.join(out_dir, '%s.png' % name))
        view = minimap_render.render(scene, crop=(0, 0, 128, 64))
        view.save(os.path.join(out_dir, '%s-view.png' % name))
    except Exception as ex:
        sys.stderr.write('preview %s failed: %s\n' % (name, ex))


def show(name):
    factory = dict(SCENARIOS).get(name)
    if factory is None:
        print('unknown scenario %r; available: %s' % (name, ', '.join(n for n, _ in SCENARIOS)))
        return 1

    host = factory()
    mm = minimap.Minimap()
    text, _ = mm.render(host)
    print(text)

    try:
        from mod import minimap_render
    except ImportError:
        return 0
    if not minimap_render.available():
        print('(PIL not available, skipping ASCII art)')
        return 0

    print(minimap_render.to_ascii(mm.scene(host)))
    return 0


def bench():
    print('== benchmark ==')
    for name, factory in (('linear', sc_linear), ('stress-40', sc_stress)):
        host = factory()
        mm = minimap.Minimap()

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
    parser = argparse.ArgumentParser(description='Minimap checks')
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
    check_compat(r)

    print('')
    bench()

    return r.report()


if __name__ == '__main__':
    sys.exit(main())
