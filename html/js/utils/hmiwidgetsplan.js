// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where a plugin widget goes on the HMI display, and which controls its suggested ports get: the plan the Display
// dialog proposes, worked out in the browser. Plain functions over plain data, no DOM, so node can test them.
//
// The model:
//   areas    : the areas of the display, as the server gives them: {id, name, rect: [x, y, w, h], cells, subpages}
//   pages    : how many pages, subpages: how many subpages
//   layout   : the placements so far: {page, subpage (only for areas that follow the subpage), area, instance, symbol}
//   knobs    : the controls with subpages, in device order: [{uri, name}]
//   switches : the controls without, in device order: [{uri, name}]
//   taken    : the slots already holding a binding, keyed by slotKey(uri, page, subpage)
//   compatible(port, uri): whether a port can be bound to a control
//
// A port given to the planner is {symbol, kind: 'switch' | 'knob', ...}: toggled and trigger ports are switch ports.
// Rules: https://github.com/sejerpz/alabs-hmi-widgets, "Suggested ports and bindings" and the mod-ui reference.

var HMIWidgetsPlan = (function () {

    function areaWidth(area)  { return area.rect[2] }
    function areaHeight(area) { return area.rect[3] }

    // a missing minimum counts as 1 pixel: the widget fits any area
    function fits(widget, area) {
        return areaWidth(area)  >= Math.max(1, widget.minWidth  || 0) &&
               areaHeight(area) >= Math.max(1, widget.minHeight || 0)
    }

    // how far an area is from the size a widget looks best at; a missing natural size is the minimum
    function distance(widget, area) {
        var nw = widget.naturalWidth  || widget.minWidth  || 1
        var nh = widget.naturalHeight || widget.minHeight || 1
        return Math.abs(areaWidth(area) - nw) + Math.abs(areaHeight(area) - nh)
    }

    function areaById(model, id) {
        for (var i = 0; i < model.areas.length; i++) {
            if (model.areas[i].id === id) {
                return model.areas[i]
            }
        }
        return null
    }

    function sharesCell(a, b) {
        for (var i = 0; i < a.cells.length; i++) {
            if (b.cells.indexOf(a.cells[i]) >= 0) {
                return true
            }
        }
        return false
    }

    // the subpage a placement on `area` keeps: null for an area on every subpage of its page
    function placementSubpage(area, subpage) {
        return area.subpages ? subpage : null
    }

    // the placement of the layout that `area` on page/subpage would overlap, or null
    function overlapping(model, area, page, subpage, ignore) {
        var sub = placementSubpage(area, subpage)
        for (var i = 0; i < model.layout.length; i++) {
            var entry = model.layout[i]
            if (entry === ignore || entry.page !== page) {
                continue
            }
            var other = areaById(model, entry.area)
            if (!other || !sharesCell(area, other)) {
                continue
            }
            var otherSub = entry.subpage === undefined ? null : entry.subpage
            if (sub === null || otherSub === null || sub === otherSub) {
                return entry
            }
        }
        return null
    }

    function isFree(model, area, page, subpage) {
        return overlapping(model, area, page, subpage) === null
    }

    // the free areas of a page and subpage the widget fits in, closest to its natural size first, ties in the
    // order the device lists them
    function freeAreas(model, widget, page, subpage) {
        var found = []
        for (var i = 0; i < model.areas.length; i++) {
            var area = model.areas[i]
            if (fits(widget, area) && isFree(model, area, page, subpage)) {
                found.push({ area: area, index: i, distance: distance(widget, area) })
            }
        }
        found.sort(function (a, b) { return a.distance - b.distance || a.index - b.index })
        return found.map(function (f) { return f.area })
    }

    // the cells the dialog draws as buttons: those with an area of their own. A cell only some bigger area takes
    // (the title band on the Dwarf, under the full screen one) is not drawn and cannot be picked by itself.
    function drawableCells(model) {
        var cells = []
        for (var i = 0; i < model.areas.length; i++) {
            var area = model.areas[i]
            if (area.cells.length === 1 && cells.indexOf(area.cells[0]) < 0) {
                cells.push(area.cells[0])
            }
        }
        return cells
    }

    function cellRect(model, cell) {
        for (var i = 0; i < model.areas.length; i++) {
            var area = model.areas[i]
            if (area.cells.length === 1 && area.cells[0] === cell) {
                return area.rect
            }
        }
        return null
    }

    // the area picked by a selection of drawn cells: the first area whose drawn cells are exactly those
    function areaForCells(model, cells) {
        if (!cells.length) {
            return null
        }
        var drawable = drawableCells(model)
        var wanted = cells.slice().sort().join(' ')
        for (var i = 0; i < model.areas.length; i++) {
            var own = model.areas[i].cells.filter(function (c) { return drawable.indexOf(c) >= 0 })
            if (own.slice().sort().join(' ') === wanted) {
                return model.areas[i]
            }
        }
        return null
    }

    function drawnCellsOf(model, area) {
        var drawable = drawableCells(model)
        return area.cells.filter(function (c) { return drawable.indexOf(c) >= 0 })
    }

    // ---------------------------------------------------------------------------------------------------------------
    // ports

    function slotKey(uri, page, subpage) {
        return uri + '|' + page + '|' + (subpage === null || subpage === undefined ? '-' : subpage)
    }

    function portKind(port) {
        var properties = port.properties || []
        return properties.indexOf('toggled') >= 0 || properties.indexOf('trigger') >= 0 ? 'switch' : 'knob'
    }

    // the rows of controls from `fromPage` on (or that page alone), in the order the plan takes them: the knobs of
    // the widget's subpage before the other subpages of a page
    function rows(model, kind, fromPage, widgetSubpage, onlyPage) {
        var result = [], last = onlyPage ? fromPage : model.pages - 1
        for (var page = fromPage; page <= last; page++) {
            if (kind === 'switch') {
                if (model.switches.length) {
                    result.push({ page: page, subpage: null, controls: model.switches })
                }
                continue
            }
            if (!model.knobs.length) {
                continue
            }
            var order = [widgetSubpage]
            for (var s = 0; s < model.subpages; s++) {
                if (s !== widgetSubpage) {
                    order.push(s)
                }
            }
            for (var j = 0; j < order.length; j++) {
                result.push({ page: page, subpage: model.subpages > 1 ? order[j] : null, controls: model.knobs })
            }
        }
        return result
    }

    // binds `ports` in order to contiguous free compatible controls of one row at a time; a group longer than a
    // row fills whole rows. What finds no contiguous run is retried in shorter runs, so the plan binds what it can.
    // Returns the ports left over.
    function placeGroup(model, ports, rowList, used, targets) {
        var remaining = ports.slice()
        var free = function (uri, page, subpage) {
            var key = slotKey(uri, page, subpage)
            return !model.taken[key] && !used[key]
        }
        for (var run = 0; remaining.length; run++) {
            var placedAny = false
            for (var r = 0; r < rowList.length && remaining.length; r++) {
                var row = rowList[r]
                var need = Math.max(1, Math.min(remaining.length, row.controls.length) - run)
                for (var start = 0; start + need <= row.controls.length; start++) {
                    var ok = true
                    for (var k = 0; k < need && ok; k++) {
                        var uri = row.controls[start + k].uri
                        ok = free(uri, row.page, row.subpage) && model.compatible(remaining[k], uri)
                    }
                    if (!ok) {
                        continue
                    }
                    for (k = 0; k < need; k++) {
                        var target = { uri: row.controls[start + k].uri, page: row.page, subpage: row.subpage }
                        used[slotKey(target.uri, target.page, target.subpage)] = true
                        targets[remaining[k].symbol] = target
                    }
                    remaining = remaining.slice(need)
                    placedAny = true
                    // the same row may still have room for the rest, nearer than the next one
                    r--
                    break
                }
            }
            // nothing left to shorten: the rest has no room
            if (!placedAny && Math.min(remaining.length, maxRow(rowList)) - run <= 1) {
                break
            }
        }
        return remaining
    }

    function maxRow(rowList) {
        var n = 0
        for (var i = 0; i < rowList.length; i++) {
            n = Math.max(n, rowList[i].controls.length)
        }
        return n
    }

    // whether a switch one of `ports` could take is free on a page from `fromPage` on
    function anySwitchFree(model, ports, fromPage, used) {
        for (var page = fromPage; page < model.pages; page++) {
            for (var i = 0; i < model.switches.length; i++) {
                var uri = model.switches[i].uri, key = slotKey(uri, page, null)
                if (model.taken[key] || used[key]) {
                    continue
                }
                for (var p = 0; p < ports.length; p++) {
                    if (model.compatible(ports[p], uri)) {
                        return true
                    }
                }
            }
        }
        return false
    }

    // the controls for `ports` (not bound yet), nearest to the widget first: page `fromPage` and the widget's
    // subpage, then the following pages unless `onlyPage`. Switch ports go to knobs only when no switch is free.
    function planPorts(model, ports, fromPage, widgetSubpage, onlyPage) {
        var used = {}, targets = {}
        var switchPorts = ports.filter(function (p) { return p.kind === 'switch' })
        var knobPorts   = ports.filter(function (p) { return p.kind !== 'switch' })
        var sub = widgetSubpage || 0

        var switchLeft = placeGroup(model, switchPorts, rows(model, 'switch', fromPage, sub, onlyPage), used, targets)
        var knobLeft   = placeGroup(model, knobPorts,   rows(model, 'knob',   fromPage, sub, onlyPage), used, targets)
        // on the page alone, switch ports still go to its knobs when no switch is free on any page from it on
        if (switchLeft.length && (!onlyPage || !anySwitchFree(model, switchLeft, fromPage, used))) {
            switchLeft = placeGroup(model, switchLeft, rows(model, 'knob', fromPage, sub, onlyPage), used, targets)
        }

        var unbound = ports.filter(function (p) { return !targets[p.symbol] }).map(function (p) { return p.symbol })
        return { targets: targets, unbound: unbound }
    }

    // the best free area of a page for a widget, over its subpages: closest first, then device order, then subpage
    function bestOnPage(model, widget, page) {
        var best = null
        for (var s = 0; s < model.subpages; s++) {
            var areas = freeAreas(model, widget, page, s)
            for (var i = 0; i < areas.length; i++) {
                var area = areas[i]
                var candidate = {
                    area: area,
                    subpage: area.subpages ? s : null,
                    distance: distance(widget, area),
                    index: model.areas.indexOf(area),
                    sub: s,
                }
                if (!best || candidate.distance < best.distance ||
                    (candidate.distance === best.distance && candidate.index < best.index)) {
                    best = candidate
                }
            }
        }
        return best
    }

    // Assign automatically: the first page with a free area the widget fits in where all its ports find room too;
    // failing that, the first page with a free area, the ports taking controls from that page on.
    // Returns {page, subpage, area, targets, unbound}, or null when no page has a free area for the widget.
    function autoAssign(model, widget, ports) {
        var first = null
        for (var page = 0; page < model.pages; page++) {
            var best = bestOnPage(model, widget, page)
            if (!best) {
                continue
            }
            var plan = planPorts(model, ports, page, best.sub, true)
            if (!plan.unbound.length) {
                return { page: page, subpage: best.subpage, area: best.area, targets: plan.targets, unbound: [] }
            }
            if (!first) {
                first = { page: page, best: best }
            }
        }
        if (!first) {
            return null
        }
        var spread = planPorts(model, ports, first.page, first.best.sub, false)
        return { page: first.page, subpage: first.best.subpage, area: first.best.area,
                 targets: spread.targets, unbound: spread.unbound }
    }

    return {
        fits: fits,
        distance: distance,
        areaById: areaById,
        overlapping: overlapping,
        isFree: isFree,
        freeAreas: freeAreas,
        drawableCells: drawableCells,
        cellRect: cellRect,
        areaForCells: areaForCells,
        drawnCellsOf: drawnCellsOf,
        placementSubpage: placementSubpage,
        slotKey: slotKey,
        portKind: portKind,
        planPorts: planPorts,
        autoAssign: autoAssign,
    }
})()
