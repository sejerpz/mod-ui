#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Convert a GLCD font from the HMI firmware's fonts.h into a Python module.

The firmware stores fonts as flat uint8_t arrays with this layout:

    uint16 size            // 0x0000 marks a monospaced font (no width table)
    uint8  fixed_width
    uint8  height
    uint8  first_char
    uint8  char_count
    uint8  char_widths[char_count]   // only when proportional
    uint8  data[]                    // page-major: for each page, all columns

A pixel (x, y) of a glyph is bit (y % 8) of data[(y // 8) * glyph_width + x].

Run at development time; the generated module is committed so the runtime never
parses the header.

    python3 -m modtools.font2py <fonts.h> Terminal3x5 -o mod/plugin_map_font.py
"""

import argparse
import re
import sys

# the header wraps unused fonts in block comments; those must not be picked up
BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.DOTALL)
LINE_COMMENT = re.compile(r'//[^\n]*')
ARRAY = re.compile(r'static\s+const\s+uint8_t\s+(\w+)\s*\[\s*\]\s*=\s*\{([^}]*)\}', re.DOTALL)
BYTE = re.compile(r'0[xX][0-9a-fA-F]+|\d+')


def strip_comments(text):
    text = BLOCK_COMMENT.sub(' ', text)
    text = LINE_COMMENT.sub(' ', text)
    return text


def find_arrays(text):
    """Return {name: [int, ...]} for every uncommented uint8_t array."""
    out = {}
    for match in ARRAY.finditer(text):
        name = match.group(1)
        body = match.group(2)
        out[name] = [int(tok, 0) for tok in BYTE.findall(body)]
    return out


class Font(object):
    def __init__(self, name, raw):
        if len(raw) < 6:
            raise ValueError("font '%s' is too short to hold a header" % name)

        self.name = name
        self.size = (raw[0] << 8) | raw[1]
        self.fixed_width = raw[2]
        self.height = raw[3]
        self.first_char = raw[4]
        self.char_count = raw[5]
        # FONT_IS_MONO_SPACED(font) == (font[0] == 0 && font[1] == 0)
        self.monospaced = (raw[0] == 0 and raw[1] == 0)

        pos = 6
        if self.monospaced:
            self.widths = [self.fixed_width] * self.char_count
        else:
            self.widths = raw[pos:pos + self.char_count]
            if len(self.widths) != self.char_count:
                raise ValueError("font '%s' has a truncated width table" % name)
            pos += self.char_count

        self.pages = (self.height + 7) // 8
        self.glyphs = self._decode(raw[pos:])

    def _decode(self, data):
        """Split the byte stream into one column-list per glyph.

        Each glyph occupies width*pages bytes, stored page-major. We collapse
        the pages into a single integer per column so a glyph becomes a plain
        tuple of column bitmasks, bit N meaning "row N is lit".
        """
        glyphs = []
        pos = 0

        for index in range(self.char_count):
            width = self.widths[index]
            need = width * self.pages

            if pos + need > len(data):
                # some fonts in the header stop early (e.g. a trailing char is
                # omitted); pad with blanks rather than failing the whole run
                sys.stderr.write(
                    "warning: %s: glyph %d (%r) truncated, padding blank\n"
                    % (self.name, index, chr(self.first_char + index)))
                glyphs.append(tuple([0] * width))
                pos = len(data)
                continue

            columns = []
            for x in range(width):
                value = 0
                for page in range(self.pages):
                    value |= data[pos + page * width + x] << (page * 8)
                # mask off padding bits above the declared height
                columns.append(value & ((1 << self.height) - 1))
            glyphs.append(tuple(columns))
            pos += need

        return glyphs

    def render_ascii(self, text, lit='#', dark='.'):
        """Rows of characters, for eyeballing the decode in a terminal."""
        rows = []
        for y in range(self.height):
            row = []
            for ch in text:
                index = ord(ch) - self.first_char
                if index < 0 or index >= len(self.glyphs):
                    continue
                for column in self.glyphs[index]:
                    row.append(lit if (column >> y) & 1 else dark)
                row.append(dark)
            rows.append(''.join(row))
        return rows


HEADER = '''#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

# GENERATED FILE - do not edit by hand.
# Produced by modtools/font2py.py from the HMI firmware's fonts.h.
# Regenerate with:
#     python3 -m modtools.font2py <fonts.h> %(name)s -o mod/plugin_map_font.py
#
# Font %(name)s: %(width)dx%(height)d, %(spacing)s, %(count)d glyphs from 0x%(first)02X.
# Each glyph is a tuple of column bitmasks; bit N of a column means row N is lit.

NAME = %(name)r
WIDTH = %(width)d
HEIGHT = %(height)d
FIRST_CHAR = %(first)d
CHAR_COUNT = %(count)d
MONOSPACED = %(mono)r
# FONT_INTERCHAR_SPACE in the firmware's fonts.h
INTERCHAR = 1

'''

FOOTER = '''

# glyph used when a character falls outside the table
_FALLBACK = GLYPHS[ord('?') - FIRST_CHAR] if ord('?') - FIRST_CHAR < CHAR_COUNT else ()


def glyph(ch):
    """Column bitmasks for `ch`, falling back to '?' for anything unmapped."""
    index = ord(ch) - FIRST_CHAR
    if index < 0 or index >= CHAR_COUNT:
        return _FALLBACK
    return GLYPHS[index]


def char_width(ch):
    return len(glyph(ch))


def text_width(text):
    """Pixel width of `text`, including the gap between glyphs but not after."""
    if not text:
        return 0
    total = 0
    for ch in text:
        total += len(glyph(ch)) + INTERCHAR
    return total - INTERCHAR


def truncate(text, max_width):
    """Longest prefix of `text` fitting `max_width` pixels.

    Cut, not marked. A trailing '.' costs a whole character, and on a label
    24 pixels wide that is a fifth of everything there is to read; the box
    being full to its edge is signal enough that the name goes on.
    """
    if text_width(text) <= max_width:
        return text

    out = []
    used = 0
    for ch in text:
        step = len(glyph(ch)) + (INTERCHAR if out else 0)
        if used + step > max_width:
            break
        out.append(ch)
        used += step

    return ''.join(out)


def text_points(text, ox, oy):
    """Lit pixels for `text` drawn with its top-left corner at (ox, oy).

    Returns a flat list of (x, y) so a caller can hand the whole string to a
    single ImageDraw.point() call instead of one call per pixel.
    """
    points = []
    x = ox
    for ch in text:
        columns = glyph(ch)
        for column in columns:
            if column:
                y = oy
                bits = column
                while bits:
                    if bits & 1:
                        points.append((x, y))
                    bits >>= 1
                    y += 1
            x += 1
        x += INTERCHAR
    return points
'''


def generate(font):
    parts = [HEADER % {
        'name': font.name,
        'width': font.fixed_width,
        'height': font.height,
        'first': font.first_char,
        'count': font.char_count,
        'mono': font.monospaced,
        'spacing': 'monospaced' if font.monospaced else 'proportional',
    }]

    parts.append('GLYPHS = (\n')
    for index, columns in enumerate(font.glyphs):
        ch = chr(font.first_char + index)
        label = repr(ch) if ch.isprintable() and ch != ' ' else 'space' if ch == ' ' else hex(font.first_char + index)
        body = ', '.join('0x%02X' % c for c in columns)
        parts.append('    (%s),%s# %s\n' % (body, ' ' * max(1, 34 - len(body)), label))
    parts.append(')\n')

    parts.append(FOOTER)
    return ''.join(parts)


def main():
    parser = argparse.ArgumentParser(description='Convert a GLCD font header into a Python module')
    parser.add_argument('header', help='path to the firmware fonts.h')
    parser.add_argument('font', nargs='?', default='Terminal3x5', help='font array name (default: Terminal3x5)')
    parser.add_argument('-o', '--output', help='write the module here (default: stdout)')
    parser.add_argument('-l', '--list', action='store_true', help='list the fonts found and exit')
    parser.add_argument('-p', '--proof', metavar='TEXT', help='print TEXT as ASCII art and exit')
    args = parser.parse_args()

    with open(args.header, 'r', errors='replace') as fh:
        text = strip_comments(fh.read())

    arrays = find_arrays(text)
    if not arrays:
        sys.stderr.write('error: no uncommented uint8_t arrays found in %s\n' % args.header)
        return 1

    if args.list:
        for name in sorted(arrays):
            try:
                font = Font(name, arrays[name])
            except ValueError as ex:
                print('%-20s <invalid: %s>' % (name, ex))
                continue
            print('%-20s %dx%d %-13s %d glyphs from 0x%02X' % (
                name, font.fixed_width, font.height,
                'monospaced' if font.monospaced else 'proportional',
                font.char_count, font.first_char))
        return 0

    if args.font not in arrays:
        sys.stderr.write("error: font '%s' not found; available: %s\n"
                         % (args.font, ', '.join(sorted(arrays))))
        return 1

    font = Font(args.font, arrays[args.font])

    if args.proof is not None:
        for row in font.render_ascii(args.proof):
            print(row)
        return 0

    out = generate(font)

    if args.output:
        with open(args.output, 'w', newline='\n') as fh:
            fh.write(out)
        sys.stderr.write('wrote %s (%s %dx%d, %d glyphs)\n'
                         % (args.output, font.name, font.fixed_width, font.height, font.char_count))
    else:
        sys.stdout.write(out)

    return 0


if __name__ == '__main__':
    sys.exit(main())
