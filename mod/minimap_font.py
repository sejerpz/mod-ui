#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

# GENERATED FILE - do not edit by hand.
# Produced by modtools/font2py.py from the HMI firmware's fonts.h.
# Regenerate with:
#     python3 -m modtools.font2py <fonts.h> Terminal3x5 -o mod/minimap_font.py
#
# Font Terminal3x5: 3x5, monospaced, 95 glyphs from 0x20.
# Each glyph is a tuple of column bitmasks; bit N of a column means row N is lit.

NAME = 'Terminal3x5'
WIDTH = 3
HEIGHT = 5
FIRST_CHAR = 32
CHAR_COUNT = 95
MONOSPACED = True
# FONT_INTERCHAR_SPACE in the firmware's fonts.h
INTERCHAR = 1

GLYPHS = (
    (0x00, 0x00, 0x00),                  # space
    (0x00, 0x17, 0x00),                  # '!'
    (0x03, 0x00, 0x03),                  # '"'
    (0x1F, 0x0A, 0x1F),                  # '#'
    (0x0A, 0x1F, 0x05),                  # '$'
    (0x09, 0x04, 0x12),                  # '%'
    (0x0A, 0x15, 0x1A),                  # '&'
    (0x03, 0x01, 0x00),                  # "'"
    (0x00, 0x0E, 0x11),                  # '('
    (0x11, 0x0E, 0x00),                  # ')'
    (0x15, 0x0E, 0x15),                  # '*'
    (0x04, 0x0E, 0x04),                  # '+'
    (0x10, 0x08, 0x00),                  # ','
    (0x04, 0x04, 0x04),                  # '-'
    (0x00, 0x10, 0x00),                  # '.'
    (0x18, 0x04, 0x03),                  # '/'
    (0x1F, 0x11, 0x1F),                  # '0'
    (0x00, 0x1F, 0x00),                  # '1'
    (0x1D, 0x15, 0x17),                  # '2'
    (0x15, 0x15, 0x1F),                  # '3'
    (0x07, 0x04, 0x1F),                  # '4'
    (0x17, 0x15, 0x1D),                  # '5'
    (0x1F, 0x15, 0x1D),                  # '6'
    (0x01, 0x01, 0x1F),                  # '7'
    (0x1F, 0x15, 0x1F),                  # '8'
    (0x17, 0x15, 0x1F),                  # '9'
    (0x00, 0x0A, 0x00),                  # ':'
    (0x10, 0x0A, 0x00),                  # ';'
    (0x04, 0x0A, 0x11),                  # '<'
    (0x14, 0x14, 0x14),                  # '='
    (0x11, 0x0A, 0x04),                  # '>'
    (0x01, 0x15, 0x02),                  # '?'
    (0x1F, 0x11, 0x17),                  # '@'
    (0x1E, 0x05, 0x1E),                  # 'A'
    (0x1F, 0x15, 0x0A),                  # 'B'
    (0x0E, 0x11, 0x11),                  # 'C'
    (0x1F, 0x11, 0x0E),                  # 'D'
    (0x1F, 0x15, 0x11),                  # 'E'
    (0x1F, 0x05, 0x01),                  # 'F'
    (0x0E, 0x11, 0x1D),                  # 'G'
    (0x1F, 0x04, 0x1F),                  # 'H'
    (0x11, 0x1F, 0x11),                  # 'I'
    (0x08, 0x10, 0x0F),                  # 'J'
    (0x1F, 0x04, 0x1B),                  # 'K'
    (0x1F, 0x10, 0x10),                  # 'L'
    (0x1F, 0x06, 0x1F),                  # 'M'
    (0x1F, 0x02, 0x1F),                  # 'N'
    (0x0E, 0x11, 0x0E),                  # 'O'
    (0x1F, 0x05, 0x02),                  # 'P'
    (0x0E, 0x19, 0x1E),                  # 'Q'
    (0x1F, 0x05, 0x1A),                  # 'R'
    (0x16, 0x15, 0x0D),                  # 'S'
    (0x01, 0x1F, 0x01),                  # 'T'
    (0x1F, 0x10, 0x1F),                  # 'U'
    (0x0F, 0x10, 0x0F),                  # 'V'
    (0x1F, 0x0C, 0x1F),                  # 'W'
    (0x1B, 0x04, 0x1B),                  # 'X'
    (0x03, 0x1C, 0x03),                  # 'Y'
    (0x19, 0x15, 0x13),                  # 'Z'
    (0x1F, 0x11, 0x00),                  # '['
    (0x03, 0x04, 0x18),                  # '\\'
    (0x11, 0x1F, 0x00),                  # ']'
    (0x02, 0x01, 0x02),                  # '^'
    (0x10, 0x10, 0x10),                  # '_'
    (0x01, 0x03, 0x00),                  # '`'
    (0x1E, 0x05, 0x1E),                  # 'a'
    (0x1F, 0x15, 0x0A),                  # 'b'
    (0x0E, 0x11, 0x11),                  # 'c'
    (0x1F, 0x11, 0x0E),                  # 'd'
    (0x1F, 0x15, 0x11),                  # 'e'
    (0x1F, 0x05, 0x01),                  # 'f'
    (0x0E, 0x11, 0x1D),                  # 'g'
    (0x1F, 0x04, 0x1F),                  # 'h'
    (0x11, 0x1F, 0x11),                  # 'i'
    (0x08, 0x10, 0x0F),                  # 'j'
    (0x1F, 0x04, 0x1B),                  # 'k'
    (0x1F, 0x10, 0x10),                  # 'l'
    (0x1F, 0x06, 0x1F),                  # 'm'
    (0x1F, 0x02, 0x1F),                  # 'n'
    (0x0E, 0x11, 0x0E),                  # 'o'
    (0x1F, 0x05, 0x02),                  # 'p'
    (0x0E, 0x19, 0x1E),                  # 'q'
    (0x1F, 0x05, 0x1A),                  # 'r'
    (0x16, 0x15, 0x0D),                  # 's'
    (0x01, 0x1F, 0x01),                  # 't'
    (0x1F, 0x10, 0x1F),                  # 'u'
    (0x0F, 0x10, 0x0F),                  # 'v'
    (0x1F, 0x0C, 0x1F),                  # 'w'
    (0x1B, 0x04, 0x1B),                  # 'x'
    (0x03, 0x1C, 0x03),                  # 'y'
    (0x19, 0x15, 0x13),                  # 'z'
    (0x04, 0x1F, 0x11),                  # '{'
    (0x00, 0x1F, 0x00),                  # '|'
    (0x11, 0x1F, 0x04),                  # '}'
    (0x04, 0x06, 0x02),                  # '~'
)


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

    The firmware font has no ellipsis glyph, so an over-long label is cut and
    marked with a trailing '.' when there is room for one.
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

    while out:
        marked = ''.join(out[:-1]) + '.'
        if text_width(marked) <= max_width:
            return marked
        out.pop()

    return ''


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
