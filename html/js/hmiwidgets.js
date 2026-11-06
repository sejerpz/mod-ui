// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Display dialog: which plugin widget each area of the HMI display shows, page by page and subpage by subpage.
// It starts from the widgets of the pedalboard. Place picks an area by tapping the cells of a drawing of the
// display; Assign automatically proposes a page, an area and controls for the suggested ports. Nothing changes
// until Save: the bindings go first, through the same path as the addressing dialog, then the layout.
// The plan itself is in utils/hmiwidgetsplan.js.
function HMIWidgetsWindow(options) {
    var self = this

    options = $.extend({
        window: $('<div>'),
        hardwareManager: function () { return null },
        getGui: function (instance) { return null },
        modified: function () {},
    }, options)

    var win = options.window
    var Plan = HMIWidgetsPlan

    // the drawing of the display is this wide, whatever the display
    var DRAW_WIDTH = 384

    var state = null    // what the server said: areas, pages, subpages, layout, available
    var layout = []     // the placements being edited
    var pending = []    // bindings made by the dialog, applied on Save: {instance, symbol, uri, page, subpage}
    var view = null     // page, subpage, search, placeableOnly, grouped, selected
    var placing = null  // while placing a widget: {key, page, subpage, cells, targets, auto, firstPlacement}

    // ---------------------------------------------------------------------------------------------------------------
    // the controls of the device and what holds them

    var actuators = { byUri: {}, knobs: [], switches: [], groups: [] }

    function readActuators() {
        actuators = { byUri: {}, knobs: [], switches: [], groups: [] }
        var list = (typeof HARDWARE_PROFILE !== 'undefined' ? HARDWARE_PROFILE : []).filter(function (a) {
            return a.uri && a.uri.indexOf('/hmi/') === 0
        }).sort(function (a, b) { return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0 })

        for (var i = 0; i < list.length; i++) {
            var act = list[i]
            actuators.byUri[act.uri] = act
            if (act.actuator_group) {
                actuators.groups.push(act)
            } else if (act.subpages && act.subpages.length) {
                actuators.knobs.push({ uri: act.uri, name: act.name })
            } else {
                actuators.switches.push({ uri: act.uri, name: act.name })
            }
        }
    }

    function isKnob(uri) {
        return actuators.knobs.some(function (k) { return k.uri === uri })
    }

    function toInt(value, fallback) {
        var n = parseInt(value)
        return isNaN(n) ? fallback : n
    }

    function knobSubpage(subpage) {
        return state.subpages > 1 ? (subpage || 0) : null
    }

    function hm() {
        return options.hardwareManager()
    }

    function portOf(instance, symbol) {
        var gui = options.getGui(instance)
        return gui && gui.controls ? gui.controls[symbol] || null : null
    }

    function isBound(instance, symbol) {
        var manager = hm()
        if (manager && manager.addressingsByPortSymbol[instance + '/' + symbol]) {
            return true
        }
        return pending.some(function (b) { return b.instance === instance && b.symbol === symbol })
    }

    // the slots holding a binding, with what they show: {key: {label, pending}}
    function takenSlots() {
        var taken = {}
        var manager = hm()

        var mark = function (uri, page, subpage, label, isPending) {
            taken[Plan.slotKey(uri, page, subpage)] = { label: label, pending: !!isPending }
        }

        if (manager) {
            for (var key in manager.addressingsByPortSymbol) {
                var uri = manager.addressingsByPortSymbol[key]
                var act = actuators.byUri[uri]
                if (!act) {
                    continue
                }
                var data = manager.addressingsData[key] || {}
                var page = toInt(data.page, 0)
                var label = data.label || key.split('/').pop()

                if (act.actuator_group) {
                    // a group holds the footswitches it is made of
                    mark(uri, page, null, label)
                    for (var m = 0; m < act.actuator_group.length; m++) {
                        mark(act.actuator_group[m], page, null, label)
                    }
                } else if (isKnob(uri)) {
                    mark(uri, page, knobSubpage(toInt(data.subpage, 0)), label)
                } else {
                    mark(uri, page, null, label)
                }
            }
        }

        for (var i = 0; i < pending.length; i++) {
            var b = pending[i]
            mark(b.uri, b.page, b.subpage, b.label, true)
        }
        return taken
    }

    function compatible(port, uri) {
        var manager = hm(), act = actuators.byUri[uri]
        if (!manager || !act || !port.port) {
            return false
        }
        var types = manager.availableAddressingTypes(port.port)
        return !!manager.availableActuatorsWithModes([act], types)[uri]
    }

    function model() {
        var taken = takenSlots(), flat = {}
        for (var key in taken) {
            flat[key] = true
        }
        return {
            areas: state.areas,
            pages: state.pages,
            subpages: state.subpages,
            layout: layout,
            knobs: actuators.knobs,
            switches: actuators.switches,
            taken: flat,
            compatible: compatible,
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // widgets

    function widgetKey(w) {
        return w.instance + '|' + w.symbol
    }

    function widgetByKey(key) {
        for (var i = 0; i < state.available.length; i++) {
            if (widgetKey(state.available[i]) === key) {
                return state.available[i]
            }
        }
        return null
    }

    function placementsOf(widget) {
        return layout.filter(function (e) { return e.instance === widget.instance && e.symbol === widget.symbol })
    }

    // the suggested ports the plugin really has, with whether each is bound already
    function suggestedPorts(widget) {
        var ports = []
        for (var i = 0; i < widget.suggestedPorts.length; i++) {
            var symbol = widget.suggestedPorts[i]
            var port = portOf(widget.instance, symbol)
            if (!port) {
                continue
            }
            ports.push({
                symbol: symbol,
                name: port.name || symbol,
                kind: Plan.portKind(port),
                port: port,
                bound: isBound(widget.instance, symbol),
            })
        }
        return ports
    }

    function isPlaceable(widget, m) {
        for (var page = 0; page < state.pages; page++) {
            for (var sub = 0; sub < state.subpages; sub++) {
                if (Plan.freeAreas(m, widget, page, sub).length) {
                    return true
                }
            }
        }
        return false
    }

    function sizeText(widget) {
        var min = widget.minWidth || widget.minHeight
            ? 'At least ' + (widget.minWidth || 1) + ' × ' + (widget.minHeight || 1) + ' px' : 'Any size'
        if (!widget.naturalWidth && !widget.naturalHeight) {
            return min
        }
        return min + ' · looks best at ' + (widget.naturalWidth || widget.minWidth || 1) + ' × ' +
               (widget.naturalHeight || widget.minHeight || 1) + ' px'
    }

    function areaOf(entry) {
        return Plan.areaById(state, entry.area)
    }

    function whereText(entry) {
        var area = areaOf(entry)
        var text = 'Page ' + (entry.page + 1)
        if (entry.subpage !== undefined && entry.subpage !== null && state.subpages > 1) {
            text += ' · Subpage ' + (entry.subpage + 1)
        }
        return text + ' · ' + (area ? area.name : entry.area)
    }

    function slotText(target) {
        var act = actuators.byUri[target.uri]
        var text = 'Page ' + (target.page + 1)
        if (target.subpage !== null && target.subpage !== undefined) {
            text += ' · Subpage ' + (target.subpage + 1)
        }
        return text + ' · ' + (act ? act.name : target.uri)
    }

    // ---------------------------------------------------------------------------------------------------------------
    // placing

    function placingWidget() {
        return placing ? widgetByKey(placing.key) : null
    }

    function placingArea() {
        return placing ? Plan.areaForCells(state, placing.cells) : null
    }

    // why the cells picked cannot be confirmed, or '' when they can
    function placingProblem(m) {
        var widget = placingWidget(), area = placingArea()
        if (!placing.cells.length) {
            return 'Tap a cell to start'
        }
        if (!area) {
            return 'Not an area of this display'
        }
        if (!Plan.fits(widget, area)) {
            return 'Too small: needs ' + (widget.minWidth || 1) + ' × ' + (widget.minHeight || 1) + ' px'
        }
        var other = Plan.overlapping(m, area, placing.page, placing.subpage)
        if (other) {
            var w = widgetByKey(widgetKey(other))
            return 'Taken by ' + (w ? w.name : other.symbol)
        }
        return ''
    }

    function unboundPorts(widget) {
        return suggestedPorts(widget).filter(function (p) { return !p.bound })
    }

    // the controls the plan gives the suggested ports, from the page of the widget on
    function planTargets() {
        var widget = placingWidget(), area = placingArea()
        placing.targets = {}
        if (!placing.firstPlacement || !area) {
            return
        }
        var sub = area.subpages ? placing.subpage : 0
        var plan = Plan.planPorts(model(), unboundPorts(widget), placing.page, sub, false)
        for (var symbol in plan.targets) {
            placing.targets[symbol] = plan.targets[symbol]
        }
    }

    // the cells of the area closest to the widget's natural size, among the free ones of the page in view
    function preselect() {
        var areas = Plan.freeAreas(model(), placingWidget(), placing.page, placing.subpage)
        placing.cells = areas.length ? Plan.drawnCellsOf(state, areas[0]) : []
        planTargets()
    }

    function startPlacing(widget) {
        placing = {
            key: widgetKey(widget),
            page: view.page,
            subpage: view.subpage,
            cells: [],
            targets: {},
            auto: false,
            firstPlacement: placementsOf(widget).length === 0,
        }
        preselect()
        render()
    }

    function startAuto(widget) {
        var firstPlacement = placementsOf(widget).length === 0
        var ports = firstPlacement ? unboundPorts(widget) : []
        var result = Plan.autoAssign(model(), widget, ports)
        if (!result) {
            new Notification('info', "There is no free area for " + widget.name + " on any page")
            return
        }
        view.page = result.page
        view.subpage = result.subpage === null ? view.subpage : result.subpage
        placing = {
            key: widgetKey(widget),
            page: result.page,
            subpage: view.subpage,
            cells: Plan.drawnCellsOf(state, result.area),
            targets: result.targets,
            auto: true,
            firstPlacement: firstPlacement,
        }
        render()
    }

    function finishPlacing() {
        var widget = placingWidget(), area = placingArea()
        if (!widget || !area || placingProblem(model())) {
            return
        }
        var entry = { page: placing.page, area: area.id, instance: widget.instance, symbol: widget.symbol }
        if (area.subpages) {
            entry.subpage = placing.subpage
        }
        layout.push(entry)

        var ports = suggestedPorts(widget)
        for (var i = 0; i < ports.length; i++) {
            var target = placing.targets[ports[i].symbol]
            if (target && !ports[i].bound) {
                pending.push({
                    instance: widget.instance,
                    symbol: ports[i].symbol,
                    uri: target.uri,
                    page: target.page,
                    subpage: target.subpage,
                    label: ports[i].name,
                })
            }
        }
        placing = null
        render()
    }

    // the free compatible slots a port can take, page by page, for its select
    function slotOptions(port) {
        var taken = model().taken
        var chosen = {}
        for (var symbol in placing.targets) {
            var t = placing.targets[symbol]
            if (symbol !== port.symbol && t) {
                chosen[Plan.slotKey(t.uri, t.page, t.subpage)] = true
            }
        }
        var pages = []
        for (var page = 0; page < state.pages; page++) {
            var slots = []
            var add = function (uri, subpage) {
                var key = Plan.slotKey(uri, page, subpage)
                if (!taken[key] && !chosen[key] && compatible(port, uri)) {
                    slots.push({ uri: uri, page: page, subpage: subpage })
                }
            }
            for (var s = 0; s < state.subpages; s++) {
                for (var k = 0; k < actuators.knobs.length; k++) {
                    add(actuators.knobs[k].uri, knobSubpage(s))
                }
                if (state.subpages <= 1) {
                    break
                }
            }
            for (var w = 0; w < actuators.switches.length; w++) {
                add(actuators.switches[w].uri, null)
            }
            if (slots.length) {
                pages.push({ page: page, slots: slots })
            }
        }
        return pages
    }

    // ---------------------------------------------------------------------------------------------------------------
    // rendering

    function render() {
        var m = model()
        // a placement in progress is confirmed or dropped first
        win.find('.js-submit').prop('disabled', !!placing)
        renderList(m)
        renderSide(m)
        renderWhere()
        renderDisplay(m)
        renderControls()
    }

    function matches(widget) {
        var q = view.search.trim().toLowerCase()
        return !q || widget.name.toLowerCase().indexOf(q) >= 0 || widget.plugin.toLowerCase().indexOf(q) >= 0
    }

    function widgetRow(widget, showPlugin) {
        var placements = placementsOf(widget)
        var status = placements.length
            ? whereText(placements[0]) + (placements.length > 1 ? ' +' + (placements.length - 1) : '')
            : 'Not on the display'
        var ports = suggestedPorts(widget)
        if (ports.length) {
            var bound = ports.filter(function (p) { return p.bound }).length
            status += ' · ' + bound + '/' + ports.length + ' ports bound'
        }

        var row = $('<button type="button" class="hmi-widgets-row">')
            .toggleClass('selected', view.selected === widgetKey(widget))
            .append($('<strong>').text(widget.name))
        if (showPlugin) {
            row.append($('<small>').text(widget.plugin))
        }
        row.append($('<small>').toggleClass('placed', placements.length > 0).text(status))
        row.click(function () {
            if (placing) {
                return
            }
            view.selected = widgetKey(widget)
            render()
        })
        return row
    }

    function renderList(m) {
        var list = win.find('.js-list').empty()
        var all = state.available
        var shown = all.filter(function (w) {
            return matches(w) && (!view.placeableOnly || placementsOf(w).length || isPlaceable(w, m))
        })

        win.find('.js-count').text(shown.length + ' of ' + all.length + ' widgets')

        if (!all.length) {
            list.append($('<p class="hmi-widgets-empty">').text('No plugin in this pedalboard offers display widgets.'))
            return
        }
        if (!shown.length) {
            list.append($('<p class="hmi-widgets-empty">').text('No widget matches.'))
            return
        }

        if (!view.grouped) {
            shown.slice().sort(function (a, b) {
                return a.name.localeCompare(b.name) || a.plugin.localeCompare(b.plugin)
            }).forEach(function (w) { list.append(widgetRow(w, true)) })
            return
        }

        // by plugin instance; two instances of the same plugin tell themselves apart by their instance name
        var groups = [], byInstance = {}, names = {}
        shown.forEach(function (w) {
            if (!byInstance[w.instance]) {
                byInstance[w.instance] = { instance: w.instance, plugin: w.plugin, widgets: [] }
                groups.push(byInstance[w.instance])
                names[w.plugin] = (names[w.plugin] || 0) + 1
            }
            byInstance[w.instance].widgets.push(w)
        })
        groups.sort(function (a, b) { return a.plugin.localeCompare(b.plugin) || a.instance.localeCompare(b.instance) })
        groups.forEach(function (g) {
            var title = names[g.plugin] > 1 ? g.plugin + ' (' + g.instance.replace(/^\/graph\//, '') + ')' : g.plugin
            list.append($('<div class="hmi-widgets-group">')
                .append($('<span>').text(title))
                .append($('<span class="hmi-widgets-group-count">').text(g.widgets.length)))
            g.widgets.sort(function (a, b) { return a.name.localeCompare(b.name) })
                     .forEach(function (w) { list.append(widgetRow(w, false)) })
        })
    }

    function renderSide(m) {
        var side = win.find('.js-detail').empty()
        if (placing) {
            renderPlacingPanel(side, m)
            return
        }
        var widget = view.selected ? widgetByKey(view.selected) : null
        if (!widget) {
            side.append($('<p class="hmi-widgets-note">').text('Pick a widget to place it on the display.'))
            return
        }

        side.append($('<div class="hmi-widgets-title">').append($('<strong>').text(widget.name))
                                                       .append(document.createTextNode(' · ' + widget.plugin)))
        side.append($('<div class="hmi-widgets-note">').text(sizeText(widget)))

        var ports = suggestedPorts(widget)
        if (ports.length) {
            side.append($('<div class="hmi-widgets-note">').text('Suggested ports: ' + ports.map(function (p) {
                return p.name + ' (' + (p.kind === 'switch' ? 'switch' : 'knob') + ')'
            }).join(', ')))
        }

        var placements = placementsOf(widget)
        if (placements.length) {
            var where = $('<ul class="hmi-widgets-placements">').appendTo(side)
            placements.forEach(function (entry) {
                $('<li>').append($('<span>').text(whereText(entry)))
                         .append($('<button type="button" class="btn btn-mini">').text('Remove').click(function () {
                             layout.splice(layout.indexOf(entry), 1)
                             render()
                         }))
                         .appendTo(where)
            })
        }

        var placeable = isPlaceable(widget, m)
        var buttons = $('<div class="hmi-widgets-buttons">').appendTo(side)
        $('<button type="button" class="btn hmi-widgets-primary">').text('Place…').prop('disabled', !placeable)
            .click(function () { startPlacing(widget) }).appendTo(buttons)
        $('<button type="button" class="btn">').text('Assign automatically').prop('disabled', !placeable)
            .click(function () { startAuto(widget) }).appendTo(buttons)
        if (!placeable) {
            side.append($('<div class="hmi-widgets-note">').text('No free area on any page fits this widget.'))
        }
    }

    function renderPlacingPanel(side, m) {
        var widget = placingWidget()
        var problem = placingProblem(m)

        side.append($('<div class="hmi-widgets-title">').append($('<strong>')
            .text(placing.auto ? 'Proposal' : 'Place ' + widget.name))
            .append(document.createTextNode(placing.auto ? ' · ' + widget.name + ' · nothing is saved yet' : '')))

        var ports = suggestedPorts(widget)
        if (ports.length && !placing.firstPlacement) {
            side.append($('<div class="hmi-widgets-note">')
                .text('Its suggested ports were offered at its first placement: a port takes one binding.'))
        } else if (ports.length) {
            side.append($('<div class="hmi-widgets-subtitle">').text('Suggested ports'))
            ports.forEach(function (port) {
                var field = $('<div class="hmi-widgets-port">').appendTo(side)
                var label = $('<label>').text(port.name + ' · ' + (port.kind === 'switch' ? 'switch' : 'knob'))
                field.append(label)
                if (port.bound) {
                    field.append($('<div class="hmi-widgets-note">').text('Already bound, left as it is'))
                    return
                }
                var id = 'hmi-widgets-port-' + port.symbol.replace(/[^A-Za-z0-9_]/g, '_')
                label.attr('for', id)
                var select = $('<select>').attr('id', id).appendTo(field)
                select.append($('<option value="">').text('Leave unbound'))
                slotOptions(port).forEach(function (group) {
                    var optgroup = $('<optgroup>').attr('label', 'Page ' + (group.page + 1)).appendTo(select)
                    group.slots.forEach(function (slot) {
                        optgroup.append($('<option>').val(JSON.stringify(slot)).text(slotText(slot)))
                    })
                })
                var target = placing.targets[port.symbol]
                select.val(target ? JSON.stringify({ uri: target.uri, page: target.page, subpage: target.subpage }) : '')
                select.change(function () {
                    var value = $(this).val()
                    placing.targets[port.symbol] = value ? JSON.parse(value) : null
                    render()
                })
                if (!placingArea()) {
                    select.prop('disabled', true)
                }
            })
            side.append($('<div class="hmi-widgets-note">')
                .text('Bound on Save, as normal bindings: they stay if the widget is removed.'))
        }

        var buttons = $('<div class="hmi-widgets-buttons">').appendTo(side)
        $('<button type="button" class="btn hmi-widgets-primary">').text(placing.auto ? 'Accept' : 'Done')
            .prop('disabled', !!problem).click(finishPlacing).appendTo(buttons)
        $('<button type="button" class="btn">').text(placing.auto ? 'Discard' : 'Back').click(function () {
            placing = null
            render()
        }).appendTo(buttons)
    }

    function renderWhere() {
        var pageSelect = win.find('.js-page')
        if (pageSelect.children().length !== state.pages) {
            pageSelect.empty()
            for (var i = 0; i < state.pages; i++) {
                pageSelect.append($('<option>').val(i).text('Page ' + (i + 1)))
            }
        }
        pageSelect.val(view.page)

        var switcher = win.find('.js-subpages').empty().toggle(state.subpages > 1)
        for (var s = 0; s < state.subpages; s++) {
            $('<button type="button" class="hmi-widgets-subpage">')
                .text('Subpage ' + (s + 1))
                .attr('data-subpage', s)
                .toggleClass('selected', s === view.subpage)
                .click(function () {
                    setWhere(view.page, parseInt($(this).attr('data-subpage')))
                })
                .appendTo(switcher)
        }

        win.find('.js-hint').toggle(!!placing).text(placing
            ? 'Tap the lit cells to pick an area for ' + placingWidget().name + '. Only cells of free areas it fits in are lit.'
            : '')
    }

    function setWhere(page, subpage) {
        view.page = page
        view.subpage = subpage
        if (placing) {
            placing.page = page
            placing.subpage = subpage
            preselect()
        }
        render()
    }

    function displaySize() {
        var w = 1, h = 1
        state.areas.forEach(function (a) {
            w = Math.max(w, a.rect[0] + a.rect[2])
            h = Math.max(h, a.rect[1] + a.rect[3])
        })
        return { width: w, height: h }
    }

    function box(rect, scale) {
        return {
            left: Math.round(rect[0] * scale) + 'px',
            top: Math.round(rect[1] * scale) + 'px',
            width: Math.round(rect[2] * scale) + 'px',
            height: Math.round(rect[3] * scale) + 'px',
        }
    }

    function renderDisplay(m) {
        var size = displaySize()
        var scale = DRAW_WIDTH / size.width
        var drawing = win.find('.js-display').empty()
            .css({ width: DRAW_WIDTH + 'px', height: Math.round(size.height * scale) + 'px' })

        // what the page in view already shows
        var shown = layout.filter(function (e) {
            return e.page === view.page && (e.subpage === undefined || e.subpage === view.subpage)
        })
        var covered = []
        shown.forEach(function (entry) {
            var area = areaOf(entry)
            if (!area) {
                return
            }
            var w = widgetByKey(widgetKey(entry))
            covered = covered.concat(area.cells)
            $('<div class="hmi-widgets-area taken">').css(box(area.rect, scale))
                .text(w ? w.name : entry.symbol).attr('title', area.name).appendTo(drawing)
        })

        var cells = Plan.drawableCells(state).filter(function (c) { return covered.indexOf(c) < 0 })

        if (!placing) {
            cells.forEach(function (cell) {
                var area = Plan.areaForCells(state, [cell])
                $('<div class="hmi-widgets-area">').css(box(Plan.cellRect(state, cell), scale))
                    .text(area ? area.name : cell).appendTo(drawing)
            })
            win.find('.js-status').text('').removeClass('problem')
            return
        }

        // the cells of the free areas the widget fits in can be picked
        var widget = placingWidget(), lit = []
        Plan.freeAreas(m, widget, placing.page, placing.subpage).forEach(function (area) {
            lit = lit.concat(Plan.drawnCellsOf(state, area))
        })

        cells.forEach(function (cell) {
            var area = Plan.areaForCells(state, [cell])
            var selected = placing.cells.indexOf(cell) >= 0
            $('<button type="button" class="hmi-widgets-area cell">').css(box(Plan.cellRect(state, cell), scale))
                .text(area ? area.name : cell)
                .toggleClass('lit', lit.indexOf(cell) >= 0)
                .toggleClass('selected', selected)
                .attr('aria-pressed', selected ? 'true' : 'false')
                .prop('disabled', lit.indexOf(cell) < 0 && !selected)
                .click(function () {
                    var i = placing.cells.indexOf(cell)
                    if (i >= 0) {
                        placing.cells.splice(i, 1)
                    } else {
                        placing.cells.push(cell)
                    }
                    planTargets()
                    render()
                })
                .appendTo(drawing)
        })

        var area = placingArea()
        if (area) {
            $('<div class="hmi-widgets-outline">').css(box(area.rect, scale)).appendTo(drawing)
        }

        var problem = placingProblem(m)
        win.find('.js-status').toggleClass('problem', !!problem)
            .text(problem || area.name + ' · ' + area.rect[2] + ' × ' + area.rect[3] + ' px')
    }

    function renderControls() {
        var strip = win.find('.js-controls').empty()
        var taken = takenSlots()
        var title = 'Controls · Page ' + (view.page + 1) + (state.subpages > 1 ? ' · Subpage ' + (view.subpage + 1) : '')
        win.find('.js-controls-title').text(title)

        // what the plan in progress would add
        var planned = {}
        if (placing) {
            for (var symbol in placing.targets) {
                var t = placing.targets[symbol]
                if (t) {
                    var port = portOf(placingWidget().instance, symbol)
                    planned[Plan.slotKey(t.uri, t.page, t.subpage)] = port ? port.name : symbol
                }
            }
        }

        var add = function (control, subpage) {
            var key = Plan.slotKey(control.uri, view.page, subpage)
            var cell = $('<div class="hmi-widgets-control">').append($('<b>').text(control.name))
            if (planned[key]) {
                cell.addClass('planned').append($('<span>').text(planned[key]))
                    .append($('<em>').text('on Save'))
            } else if (taken[key]) {
                cell.toggleClass('planned', taken[key].pending).append($('<span>').text(taken[key].label))
                if (taken[key].pending) {
                    cell.append($('<em>').text('on Save'))
                }
            } else {
                cell.addClass('free').append($('<span>').text('Free'))
            }
            strip.append(cell)
        }
        actuators.knobs.forEach(function (k) { add(k, knobSubpage(view.subpage)) })
        actuators.switches.forEach(function (s) { add(s, null) })
    }

    // ---------------------------------------------------------------------------------------------------------------
    // saving

    // the steps the addressing dialog would pick by default, see HardwareManager.buildSensitivityOptions
    function defaultSteps(port, act) {
        var props = port.properties || []
        if (props.indexOf('enumeration') >= 0) {
            return port.scalePoints.length - 1
        }
        if (props.indexOf('integer') >= 0) {
            return port.ranges.maximum - port.ranges.minimum
        }
        if (props.indexOf('toggled') >= 0 || props.indexOf('trigger') >= 0) {
            return 1
        }
        if (port.rangeSteps) {
            return port.rangeSteps
        }
        var steps = act.steps || []
        return steps.length === 1 ? steps[0] : steps.length === 2 ? steps[0] : steps.length === 3 ? steps[1] : 33
    }

    // one binding, as the addressing dialog makes it: the same request, then the same bookkeeping the page does for
    // a binding the server reports (HardwareManager.addHardwareMapping). Calls back with whether it worked.
    function bind(b, port, act, callback) {
        var label = port.name || b.symbol
        var steps = defaultSteps(port, act)
        var feedback = act.feedback !== false
        $.ajax({
            url: '/effect/parameter/address/' + b.instance + '/' + b.symbol,
            type: 'POST',
            data: JSON.stringify({
                uri: act.uri,
                label: label,
                minimum: port.ranges.minimum,
                maximum: port.ranges.maximum,
                value: port.value,
                steps: steps,
                tempo: false,
                dividers: null,
                feedback: feedback,
                page: b.page,
                subpage: b.subpage,
                coloured: false,
                momentary: 0,
                operationalMode: null,
            }),
            success: function (ok) {
                if (ok) {
                    hm().addHardwareMapping(b.instance, b.symbol, act.uri, label, port.ranges.minimum,
                                            port.ranges.maximum, steps, false, null, b.page, b.subpage, null,
                                            feedback, false, 0)
                    options.modified()
                }
                callback(!!ok)
            },
            error: function () { callback(false) },
            cache: false,
            dataType: 'json',
        })
    }

    function applyBindings(list, done) {
        var manager = hm()
        var next = function (i) {
            if (i >= list.length) {
                done()
                return
            }
            var b = list[i]
            var port = portOf(b.instance, b.symbol)
            var act = actuators.byUri[b.uri]
            // gone meanwhile, or bound somewhere else since the dialog opened
            if (!manager || !port || !act || manager.addressingsByPortSymbol[b.instance + '/' + b.symbol]) {
                next(i + 1)
                return
            }
            bind(b, port, act, function (ok) {
                if (!ok) {
                    new Notification('error', "Could not bind " + (port.name || b.symbol) + " to " + act.name)
                }
                next(i + 1)
            })
        }
        next(0)
    }

    function save() {
        if (placing) {
            return
        }
        var bindings = pending.slice()
        applyBindings(bindings, function () {
            pending = []
            $.ajax({
                url: '/pedalboard/hmi-widgets',
                type: 'POST',
                data: { widgets: JSON.stringify(layout) },
                success: function () { win.hide() },
                error: function () { new Notification('error', "Could not save the display widgets") },
                cache: false,
                dataType: 'json',
            })
        })
    }

    // ---------------------------------------------------------------------------------------------------------------
    // wiring

    win.find('.js-page').change(function () {
        setWhere(parseInt($(this).val()), view.subpage)
    })

    win.find('.js-search').on('input', function () {
        view.search = $(this).val()
        renderList(model())
    })

    win.find('.js-placeable').change(function () {
        view.placeableOnly = $(this).prop('checked')
        renderList(model())
    })

    win.find('.js-view').click(function () {
        view.grouped = $(this).attr('data-view') === 'plugin'
        win.find('.js-view').each(function () {
            $(this).toggleClass('selected', ($(this).attr('data-view') === 'plugin') === view.grouped)
        })
        renderList(model())
    })

    win.find('.js-cancel').click(function () {
        placing = null
        pending = []
        win.hide()
        return false
    })

    win.find('.js-submit').click(function () {
        save()
        return false
    })

    this.start = function () {
        $.ajax({
            url: '/pedalboard/hmi-widgets',
            type: 'GET',
            success: function (data) {
                if (!data.areas || !data.areas.length) {
                    new Notification('info', "This device has no display areas for widgets")
                    return
                }
                readActuators()
                state = data
                layout = JSON.parse(JSON.stringify(data.layout))
                pending = []
                placing = null
                view = { page: 0, subpage: 0, search: '', placeableOnly: true, grouped: true, selected: null }

                win.find('.js-search').val('')
                win.find('.js-placeable').prop('checked', true)
                win.find('.js-view').each(function () {
                    $(this).toggleClass('selected', $(this).attr('data-view') === 'plugin')
                })

                render()
                win.show()
            },
            error: function () {
                new Notification('error', "Could not get the display widgets")
            },
            cache: false,
            dataType: 'json',
        })
    }
}
