#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Cross-check the firmware minimap renderer against the mod-ui reference one.

Both sides are fed the *same* display list and must produce the same 128x64
panel, pixel for pixel:

    mod/minimap.py  --display list-->  mod/minimap_render.py   (reference)
                                   \\->  app/src/minimap.c      (firmware)

Without this the two renderers can drift apart silently: test_minimap.py only
checks that the display list is well formed, and the firmware harness only
checks that it does not crash. Here the two pictures are diffed.

The firmware side runs through test/minimap_host_test.c, which reads a display
list on stdin and prints the panel as ASCII art. It only builds on Linux, so on
Windows everything past the display list is shipped into WSL in one go.

    python test/minimap_crosscheck.py               # build and compare
    python test/minimap_crosscheck.py --no-build    # reuse the built harness
    python test/minimap_crosscheck.py -s linear     # one scenario
    python test/minimap_crosscheck.py -v            # show both panels on failure
"""

import argparse
import base64
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# importing the test module installs the fake plugin info provider and gives us
# the very same scenarios the display list tests run against
import test_minimap
from mod import minimap
from mod import minimap_render
from mod.minimap import KIND_PLUGIN, RECORD_SEP
from mod.settings import MINIMAP_VIEW_WIDTH, MINIMAP_VIEW_HEIGHT, MINIMAP_WIN_PLUGINS

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FIRMWARE = os.path.normpath(os.path.join(REPO, '..', 'mod-dwarf-controller'))

# test/minimap_host_test.c reads into a fixed buffer; a longer display list
# would be silently truncated and the diff would be meaningless
HARNESS_BUFFER = 8192

HARNESS_BIN = '/tmp/minimap_test'

BUILD = r'''
set -e
cd %(fw)s
[ -e app/inc/config.h ] || cp app/inc/config-moddwarf.h app/inc/config.h
gcc -std=gnu99 -Wall -Wextra -Inxp-lpc -Iapp/inc -Idrivers/inc -Ifreertos/inc \
    -Imod-controller-proto -Inxp-lpc/CMSISv2p00_LPC177x_8xLib/inc \
    -Inxp-lpc/LPC177x_8xLib/inc \
    test/minimap_host_test.c app/src/minimap.c app/src/glcd_clip.c \
    -o %(bin)s
'''


# ---------------------------------------------------------------------------
# running the firmware renderer
# ---------------------------------------------------------------------------

def to_posix_path(path):
    """A Windows path to the way WSL sees it; left alone on a real posix host."""
    path = path.replace('\\', '/')
    if len(path) > 1 and path[1] == ':':
        return '/mnt/' + path[0].lower() + path[2:]
    return path


# ---------------------------------------------------------------------------
# what the firmware can hold
# ---------------------------------------------------------------------------

def read_limits(firmware):
    """The MINIMAP_MAX_* caps, read out of app/inc/minimap.h.

    A display list that overflows the firmware's fixed arrays is truncated on
    arrival, so the two renderers legitimately draw different pictures. Reading
    the numbers instead of hardcoding them keeps this honest when they change.
    """
    limits = {'NODES': 24, 'PORTS': 72, 'EDGES': 48, 'POINTS': 8}
    header = os.path.join(firmware, 'app', 'inc', 'minimap.h')
    if not os.path.exists(header):
        return limits

    with open(header, 'r', errors='replace') as fh:
        for line in fh:
            fields = line.split()
            if len(fields) >= 3 and fields[0] == '#define' and fields[1].startswith('MINIMAP_MAX_'):
                try:
                    limits[fields[1][len('MINIMAP_MAX_'):]] = int(fields[2])
                except ValueError:
                    pass
    return limits


def capacity_reason(text, limits):
    """Why the firmware could not hold this display list, or None if it can."""
    if len(text) + 1 > HARNESS_BUFFER:
        return 'display list is %d bytes, over the harness %d byte buffer' % (
            len(text), HARNESS_BUFFER)

    counts = {'N': 0, 'P': 0, 'E': 0}
    longest = 0
    for record in text.split(RECORD_SEP):
        record = record.strip()
        if not record:
            continue
        kind = record[0]
        if kind in counts:
            counts[kind] += 1
        if kind == 'E':
            # only the polyline tokens carry a comma
            longest = max(longest, len([t for t in record.split() if ',' in t]))

    for kind, key, label in (('N', 'NODES', 'nodes'), ('P', 'PORTS', 'ports'),
                             ('E', 'EDGES', 'edges')):
        if counts[kind] > limits[key]:
            return '%d %s, over MINIMAP_MAX_%s (%d)' % (counts[kind], label, key, limits[key])
    if longest > limits['POINTS']:
        return 'a cable has %d points, over MINIMAP_MAX_POINTS (%d)' % (longest, limits['POINTS'])
    return None


class Runner(object):
    """Runs the harness, in WSL when we are on Windows."""

    def __init__(self, distro, firmware):
        self.distro = distro
        self.firmware = firmware
        self.native = (os.name != 'nt')

    def _shell(self, script):
        if self.native:
            argv = ['bash', '-s']
        else:
            # the script travels on stdin: passing it as an argument lets the
            # Git Bash path conversion rewrite anything that looks like a path
            argv = ['wsl.exe', '-d', self.distro, '--', 'bash', '-s']
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = proc.communicate(script.encode('utf-8'))
        return proc.returncode, out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')

    def build(self):
        script = BUILD % {'fw': to_posix_path(self.firmware), 'bin': HARNESS_BIN}
        code, _, err = self._shell(script)
        if code != 0:
            raise RuntimeError('harness build failed:\n' + err)
        return err.strip()

    def run(self, cases):
        """cases: list of (tag, display list text, argv). One shell round trip.

        The display lists travel base64 encoded: they are one long line full of
        ';' record separators, which no amount of shell quoting makes pleasant.
        """
        parts = ['set -u\n']
        for tag, text, argv in cases:
            blob = base64.b64encode(text.encode('utf-8')).decode('ascii')
            args = ' '.join(str(a) for a in argv)
            parts.append('echo "<<<OUT %s"\n' % tag)
            parts.append('echo %s | base64 -d | %s %s 2>/tmp/mm_err; echo "rc=$?" >>/tmp/mm_err\n'
                         % (blob, HARNESS_BIN, args))
            parts.append('echo "<<<ERR %s"\n' % tag)
            parts.append('cat /tmp/mm_err\n')
        parts.append('echo "<<<DONE"\n')

        code, out, err = self._shell(''.join(parts))
        if code != 0 and '<<<DONE' not in out:
            raise RuntimeError('harness run failed:\n' + err)
        return self._split(out)

    @staticmethod
    def _split(out):
        results = {}
        tag = None
        where = None
        for line in out.replace('\r\n', '\n').split('\n'):
            if line.startswith('<<<OUT '):
                tag = line[7:].strip()
                where = 'out'
                results[tag] = {'out': [], 'err': []}
                continue
            if line.startswith('<<<ERR '):
                where = 'err'
                continue
            if line.startswith('<<<DONE'):
                tag = None
                continue
            if tag is not None:
                results[tag][where].append(line)
        return results


# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

def pan_offsets(width, height):
    """Every corner of the pannable area plus its middle, deduplicated.

    Clipping only misbehaves at the edges, so the corners are where the two
    renderers are most likely to disagree.
    """
    max_x = max(0, width - MINIMAP_VIEW_WIDTH)
    max_y = max(0, height - MINIMAP_VIEW_HEIGHT)
    candidates = [(0, 0), (max_x, 0), (0, max_y), (max_x, max_y), (max_x // 2, max_y // 2)]
    out = []
    for offset in candidates:
        if offset not in out:
            out.append(offset)
    return out


def focus_keys(scene):
    """First, middle and last plugin of the scene, in a stable order."""
    keys = sorted(n.key for n in scene.nodes if n.kind == KIND_PLUGIN)
    if not keys:
        return []
    picks = [keys[0], keys[len(keys) // 2], keys[-1]]
    out = []
    for key in picks:
        if key not in out:
            out.append(key)
    return out


def add_case(cases, tag, text, scene, offsets):
    for offset_x, offset_y in offsets:
        argv = [0, 0, MINIMAP_VIEW_WIDTH, MINIMAP_VIEW_HEIGHT, 0, offset_x, offset_y]
        cases.append(('%s@%d,%d' % (tag, offset_x, offset_y), text, argv, scene))


def build_cases(names, limits):
    """Display lists for every scenario, one harness case per pan offset.

    Two flavours, because the device sees both: the whole scene, which is what
    the browser debug view renders, and the window around a focused plugin,
    which is what the HMI actually asks for once a pedalboard is bigger than
    the firmware's arrays.
    """
    cases = []
    skipped = []
    for name, factory in test_minimap.SCENARIOS:
        if names and name not in names:
            continue

        host = factory()
        mm = minimap.Minimap()

        text, _ = mm.render(host)
        scene = minimap_render.parse_displaylist(text)
        offsets = pan_offsets(scene.width, scene.height)

        reason = capacity_reason(text, limits)
        if reason is None:
            add_case(cases, 'full ' + name, text, scene, offsets)
        else:
            skipped.append(('full ' + name, reason))

        for key in focus_keys(mm.scene(host)):
            focused, _ = mm.render(host, focus=key, budget=MINIMAP_WIN_PLUGINS)
            reason = capacity_reason(focused, limits)
            if reason is not None:
                skipped.append(('focus %s/%s' % (name, key), reason))
                continue
            windowed = minimap_render.parse_displaylist(focused)
            # a window keeps the full scene bounds, so it pans over the same area
            add_case(cases, 'focus %s/%s' % (name, key), focused, windowed, offsets)

    return cases, skipped


# ---------------------------------------------------------------------------
# comparison
# ---------------------------------------------------------------------------

def side_by_side(left, right, title_left, title_right):
    out = ['%-*s   %s' % (MINIMAP_VIEW_WIDTH, title_left, title_right)]
    for index in range(max(len(left), len(right))):
        a = left[index] if index < len(left) else ''
        b = right[index] if index < len(right) else ''
        mark = ' ' if a == b else '!'
        out.append('%-*s %s %s' % (MINIMAP_VIEW_WIDTH, a, mark, b))
    return '\n'.join(out)


def compare(reference, actual, verbose):
    """True when the panels match; a description of the divergence otherwise."""
    if reference == actual:
        return True, ''

    detail = []
    if len(reference) != len(actual):
        detail.append('panel is %d rows, reference is %d' % (len(actual), len(reference)))

    diff_pixels = 0
    first = None
    for y in range(min(len(reference), len(actual))):
        for x in range(min(len(reference[y]), len(actual[y]))):
            if reference[y][x] != actual[y][x]:
                diff_pixels += 1
                if first is None:
                    first = (x, y)
    if first is not None:
        detail.append('%d pixels differ, first at x=%d y=%d' % (diff_pixels, first[0], first[1]))

    if verbose:
        detail.append(side_by_side(reference, actual, 'reference (mod-ui)', 'firmware'))

    return False, '\n      '.join(detail)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--firmware', default=DEFAULT_FIRMWARE,
                        help='mod-dwarf-controller checkout (default: %s)' % DEFAULT_FIRMWARE)
    parser.add_argument('--distro', default='Debian', help='WSL distro to build and run in')
    parser.add_argument('--no-build', action='store_true', help='reuse the harness already built')
    parser.add_argument('-s', '--scenario', action='append',
                        help='only this scenario, repeatable')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='print both panels side by side on a mismatch')
    args = parser.parse_args()

    if not minimap_render.available():
        print('Pillow is missing: the reference renderer cannot rasterise anything.')
        return 2

    if not os.path.isdir(args.firmware):
        print('firmware checkout not found at %s (use --firmware)' % args.firmware)
        return 2

    runner = Runner(args.distro, args.firmware)

    limits = read_limits(args.firmware)
    cases, skipped = build_cases(set(args.scenario) if args.scenario else None, limits)
    for tag, reason in skipped:
        print('SKIP %-28s %s' % (tag, reason))
    if not cases:
        print('nothing to compare')
        return 1

    if not args.no_build:
        warnings = runner.build()
        if warnings:
            print('build warnings:\n%s' % warnings)

    results = runner.run([(tag, text, argv) for tag, text, argv, _ in cases])

    passed = 0
    failed = []
    for tag, _text, argv, scene in cases:
        got = results.get(tag)
        if got is None:
            failed.append((tag, 'the harness produced no output'))
            continue

        if 'rc=0' not in got['err']:
            failed.append((tag, 'harness exited non-zero:\n      ' + '\n      '.join(got['err'])))
            continue

        # the harness zeroes the offset and scrolls by exactly what we asked;
        # minimap_scroll() clamps to [0, scene - view] and pan_offsets() never
        # leaves that range, so the pan it lands on is the pan we requested.
        # (The offset the harness prints on stderr is the pre-scroll one.)
        crop = (argv[5], argv[6], MINIMAP_VIEW_WIDTH, MINIMAP_VIEW_HEIGHT)
        reference = minimap_render.to_ascii(scene, crop=crop, layers='all').split('\n')
        actual = [line for line in got['out'] if line]

        ok, detail = compare(reference, actual, args.verbose)
        if ok:
            passed += 1
        else:
            failed.append((tag, detail))

    for tag, detail in failed:
        print('FAIL %-28s %s' % (tag, detail))

    print('')
    print('%d/%d panels identical' % (passed, passed + len(failed)))
    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
