#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Reference rasteriser for the pedalboard minimap.

This is *not* the product: the HMI draws the scene itself from the display list
emitted by mod/minimap.py. This module rasterises the very same scene so the
result can be inspected on a desktop or in a browser while developing, and so
the firmware has something concrete to match. If the two ever disagree, the
display list is the arbiter.

PIL is imported defensively, mirroring mod/host.py -- a missing Pillow must
degrade this debug view, never break the webserver.

Targets Python 3.4, and only PIL APIs old enough for the Pillow that ships
alongside it: Image.new/paste/crop/save and ImageDraw.point/line/rectangle.
"""

from mod import minimap_font as font
from mod.minimap import KIND_PLUGIN, TYPE_MIDI, TYPE_CV, RECORD_SEP, parse_layers

try:
    from PIL import Image, ImageDraw
    _have_pil = True
except ImportError:
    _have_pil = False


def available():
    return _have_pil


# dash patterns keyed by signal type: audio is solid, MIDI dashed, CV dotted,
# which is about as much differentiation as 1-bit allows
_PATTERNS = {
    TYPE_MIDI: (2, 2),
    TYPE_CV: (1, 2),
}


def _walk(points):
    """Yield every pixel along an orthogonal polyline, in order."""
    out = []
    for index in range(len(points) - 1):
        x0, y0 = points[index]
        x1, y1 = points[index + 1]
        if x0 == x1:
            step = 1 if y1 >= y0 else -1
            for y in range(y0, y1 + step, step):
                out.append((x0, y))
        elif y0 == y1:
            step = 1 if x1 >= x0 else -1
            for x in range(x0, x1 + step, step):
                out.append((x, y0))
        else:
            # the router only emits axis-aligned segments; fall back to a
            # straight interpolation rather than dropping the segment
            span = max(abs(x1 - x0), abs(y1 - y0))
            for i in range(span + 1):
                out.append((x0 + (x1 - x0) * i // span, y0 + (y1 - y0) * i // span))
    return out


def _dashed(pixels, pattern):
    on, off = pattern
    period = on + off
    return [p for index, p in enumerate(pixels) if index % period < on]


def render(scene, crop=None, invert=False, layers=None, selected=None):
    """Rasterise `scene` into a 1-bit PIL image, or None without Pillow."""
    if not _have_pil:
        return None

    mask = parse_layers(layers)
    img = Image.new('1', (scene.width, scene.height), 0)
    draw = ImageDraw.Draw(img)

    # cables first, so boxes paint over them
    for edge in scene.edges:
        if edge.etype not in mask:
            continue
        pixels = _walk(edge.points)
        pattern = _PATTERNS.get(edge.etype)
        if pattern is not None:
            pixels = _dashed(pixels, pattern)
        pixels = [(x, y) for x, y in pixels
                  if 0 <= x < scene.width and 0 <= y < scene.height]
        if pixels:
            draw.point(pixels, fill=1)

    for node in scene.nodes:
        x0, y0 = node.x, node.y
        x1, y1 = node.x + node.w - 1, node.y + node.h - 1

        # clear the interior so cables do not run through the label
        draw.rectangle([x0, y0, x1, y1], fill=0)

        if node.bypassed:
            # dashed border, the one visual difference a 1-bit panel can carry
            for x in range(x0, x1 + 1):
                if (x - x0) % 2 == 0:
                    draw.point([(x, y0), (x, y1)], fill=1)
            for y in range(y0, y1 + 1):
                if (y - y0) % 2 == 0:
                    draw.point([(x0, y), (x1, y)], fill=1)
        else:
            draw.rectangle([x0, y0, x1, y1], outline=1)

        if node.label and node.label != '-':
            tw = font.text_width(node.label)
            tx = x0 + max(1, (node.w - tw) // 2)
            ty = y0 + max(1, (node.h - font.HEIGHT) // 2)
            points = [(px, py) for px, py in font.text_points(node.label, tx, ty)
                      if x0 < px < x1 and y0 < py < y1]
            if points:
                draw.point(points, fill=1)

        for pool in (node.inputs, node.outputs):
            for port in pool:
                if port.ptype not in mask:
                    continue
                if 0 <= port.x < scene.width and 0 <= port.y < scene.height:
                    draw.point([(port.x, port.y)], fill=1)

    if selected is not None:
        node = scene.by_key.get(selected)
        if node is not None:
            # what glcd_rect_invert does on the device
            box = img.crop((node.x, node.y, node.x + node.w, node.y + node.h))
            box = box.point(lambda v: 0 if v else 255)
            img.paste(box, (node.x, node.y))

    del draw

    if crop is not None:
        x, y, w, h = crop
        img = img.crop((x, y, x + w, y + h))

    if invert:
        img = img.point(lambda v: 0 if v else 255)

    return img


class _Wire(object):
    """The scene as reconstructed from the wire format alone."""
    __slots__ = ('width', 'height', 'nodes', 'edges', 'by_key')

    def __init__(self):
        self.width = 0
        self.height = 0
        self.nodes = []
        self.edges = []
        self.by_key = {}


class _WireNode(object):
    __slots__ = ('key', 'kind', 'x', 'y', 'w', 'h', 'bypassed', 'label',
                 'inputs', 'outputs')

    def __init__(self):
        self.inputs = []
        self.outputs = []
        self.bypassed = False
        self.label = ''


class _WirePort(object):
    __slots__ = ('x', 'y', 'ptype')


class _WireEdge(object):
    __slots__ = ('etype', 'points')


def parse_displaylist(text):
    """Rebuild a drawable scene from the emitted records.

    Deliberately independent of the in-memory model: if this can draw the whole
    picture from the text alone, so can the firmware. It is the check that the
    wire format is actually sufficient, rather than quietly leaning on state
    only the server has.
    """
    wire = _Wire()
    nodes = {}

    # records are separated by RECORD_SEP, not by newlines: the HMI protocol splits a message
    # on spaces only, so a newline would be glued onto the neighbouring token
    for line in text.split(RECORD_SEP):
        line = line.strip()
        if not line:
            continue
        parts = line.split(' ')
        kind = parts[0]

        if kind == 'M':
            wire.width = int(parts[1])
            wire.height = int(parts[2])

        elif kind == 'N':
            node = _WireNode()
            node.key = int(parts[1])
            node.kind = parts[2]
            node.x = int(parts[3])
            node.y = int(parts[4])
            node.w = int(parts[5])
            node.h = int(parts[6])
            node.bypassed = parts[7] == '1'
            node.label = parts[10] if len(parts) > 10 else ''
            nodes[node.key] = node
            wire.nodes.append(node)

        elif kind == 'P':
            node = nodes.get(int(parts[1]))
            if node is None:
                continue
            port = _WirePort()
            port.ptype = parts[4]
            port.x = int(parts[5])
            port.y = int(parts[6])
            (node.inputs if parts[3] == 'i' else node.outputs).append(port)

        elif kind == 'E':
            edge = _WireEdge()
            edge.etype = parts[4]
            edge.points = []
            for token in parts[7:]:
                xy = token.split(',')
                edge.points.append((int(xy[0]), int(xy[1])))
            if len(edge.points) >= 2:
                wire.edges.append(edge)

    wire.by_key = nodes
    return wire


def render_displaylist(text, crop=None, invert=False, layers=None):
    """Rasterise straight from the wire format -- what the firmware will see."""
    return render(parse_displaylist(text), crop=crop, invert=invert, layers=layers)


def to_ascii(scene, crop=None, layers=None, lit='#', dark='.'):
    """The scene as text, for eyeballing it in a terminal."""
    img = render(scene, crop=crop, layers=layers)
    if img is None:
        return '(PIL not available)'

    width, height = img.size
    pixels = img.load()
    rows = []
    for y in range(height):
        rows.append(''.join(lit if pixels[x, y] else dark for x in range(width)))
    return '\n'.join(rows)


def to_png_bytes(scene, crop=None, invert=False, layers=None):
    """PNG bytes for the HTTP debug view; compress_level=1 keeps it cheap."""
    if not _have_pil:
        return None

    from io import BytesIO
    img = render(scene, crop=crop, invert=invert, layers=layers)
    if img is None:
        return None

    buf = BytesIO()
    img.save(buf, format='PNG', compress_level=1)
    return buf.getvalue()
