// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Display dialog: which plugin widget each area of the HMI display shows, page by page and subpage by subpage.
// It starts from the widgets of the pedalboard. The widget picked is placed at once by tapping the cells of a drawing
// of the display, or its background for the full screen, and its suggested ports are bound by tapping the controls;
// Assign automatically proposes a page, an area and controls to accept or discard. Nothing changes until Save: the
// bindings go first, through the same path as the addressing dialog, then the layout.
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
    var draft = null    // cells of the selected widget that make no area yet: {key, page, subpage, cells}
    var proposal = null // Assign automatically, until accepted: {key, page, subpage, area, targets, unbound}

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
            } else if ((act.subpages && act.subpages.length) || (act.modes || '').indexOf(':float:') >= 0) {
                // a control with subpages, or one that takes a continuous value: a device without subpages, like
                // the Duo X, still has knobs
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

    // where a port is bound, as a slot {uri, page, subpage}, or null
    function boundSlot(instance, symbol) {
        var manager = hm(), key = instance + '/' + symbol
        var uri = manager ? manager.addressingsByPortSymbol[key] : null
        if (uri) {
            var data = manager.addressingsData[key] || {}
            return { uri: uri, page: toInt(data.page, 0),
                     subpage: isKnob(uri) ? knobSubpage(toInt(data.subpage, 0)) : null }
        }
        for (var i = 0; i < pending.length; i++) {
            if (pending[i].instance === instance && pending[i].symbol === symbol) {
                return { uri: pending[i].uri, page: pending[i].page, subpage: pending[i].subpage }
            }
        }
        return null
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
            displays: state.displays,
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

    // ---------------------------------------------------------------------------------------------------------------
    // the displays: one on the Dwarf, side by side on the Duo X

    function displays() {
        return state.displays
    }

    function multi() {
        return state.displays.length > 1
    }

    function displayById(id) {
        for (var i = 0; i < state.displays.length; i++) {
            if (state.displays[i].id === id) {
                return state.displays[i]
            }
        }
        return null
    }

    // the display an area is on, by name, for the texts of a device with more displays; '' with one
    function displayText(area) {
        var display = area && multi() ? displayById(area.display) : null
        return display ? display.name + ' · ' : ''
    }

    // how wide each display is drawn: one display as before, more side by side in the width of the page
    var MAIN_WIDTH = 632, SCREENS_GAP = 24

    function drawWidth() {
        var n = state.displays.length
        return n > 1 ? Math.min(DRAW_WIDTH, Math.floor((MAIN_WIDTH - SCREENS_GAP * (n - 1)) / n)) : DRAW_WIDTH
    }

    function whereText(entry) {
        var area = areaOf(entry)
        var text = 'Page ' + (entry.page + 1)
        if (entry.subpage !== undefined && entry.subpage !== null && state.subpages > 1) {
            text += ' · Subpage ' + (entry.subpage + 1)
        }
        return text + ' · ' + displayText(area) + (area ? area.name : entry.area)
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
    // placing: the widget picked in the list is placed straight away, on the page and subpage in view

    var TRASH_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" ' +
        'd="M6 1h4l1 1h3v2H2V2h3zM3 5h10l-1 10H4zm3 2v6h1V7zm3 0v6h1V7z"/></svg>'

    function selectedWidget() {
        return view.selected ? widgetByKey(view.selected) : null
    }

    function unboundPorts(widget) {
        return suggestedPorts(widget).filter(function (p) { return !p.bound })
    }

    // whether a placement is on the page and subpage in view
    function inView(entry) {
        return entry.page === view.page && (entry.subpage === undefined || entry.subpage === view.subpage)
    }

    // the placement of a widget on a display, on the page and subpage in view: the one its cells edit there
    function currentEntry(widget, display) {
        var placements = placementsOf(widget)
        for (var i = 0; i < placements.length; i++) {
            var area = areaOf(placements[i])
            if (inView(placements[i]) && area && area.display === display) {
                return placements[i]
            }
        }
        return null
    }

    // the model with a placement left out, to see what the cells of that placement could become
    function modelWithout(entry) {
        var m = model()
        m.layout = layout.filter(function (e) { return e !== entry })
        return m
    }

    // the area covering a whole display, picked by tapping the background of its drawing
    function fullArea(display) {
        var rect = displayById(display).rect, best = null
        state.areas.forEach(function (a) {
            if (a.display === display && a.rect[0] === 0 && a.rect[1] === 0 && a.rect[2] === rect[2] && a.rect[3] === rect[3]) {
                best = best || a
            }
        })
        return best
    }

    // the cells the selected widget holds in view on a display: those of a selection that is not an area yet, else
    // of its placement there
    function selectionCells(widget, display) {
        if (!widget) {
            return []
        }
        if (draft && draft.key === widgetKey(widget) && draft.display === display && draft.page === view.page &&
            draft.subpage === view.subpage) {
            return draft.cells
        }
        var entry = currentEntry(widget, display)
        var area = entry ? areaOf(entry) : null
        return area ? Plan.drawnCellsOf(state, area) : []
    }

    // why a selection of cells cannot be the widget's area, or '' when it can
    function cellsProblem(widget, cells, m) {
        var area = Plan.areaForCells(state, cells)
        if (!area) {
            return 'Not an area of ' + (multi() ? 'the ' + displayById(Plan.displayOfCell(state, cells[0])).name : 'this display')
        }
        if (!Plan.fits(widget, area)) {
            return 'Too small for ' + widget.name + ': needs ' + (widget.minWidth || 1) + ' × ' + (widget.minHeight || 1) + ' px'
        }
        var other = Plan.overlapping(m, area, view.page, view.subpage)
        if (other) {
            var w = widgetByKey(widgetKey(other))
            return 'Taken by ' + (w ? w.name : other.symbol)
        }
        return ''
    }

    // the widget's area in view on a display becomes the one these cells make: placed at once, removed when none
    // are left. Its placements on the other displays stay as they are.
    function setCells(widget, cells, display) {
        var entry = currentEntry(widget, display)
        if (entry) {
            layout.splice(layout.indexOf(entry), 1)
        }
        draft = null
        view.screen = display
        if (!cells.length) {
            render()
            return
        }
        if (cellsProblem(widget, cells, model())) {
            // kept as it is, so the next tap can still make an area of it
            draft = { key: widgetKey(widget), display: display, page: view.page, subpage: view.subpage, cells: cells.slice() }
            render()
            return
        }
        var area = Plan.areaForCells(state, cells)
        var placed = { page: view.page, area: area.id, instance: widget.instance, symbol: widget.symbol }
        if (area.subpages) {
            placed.subpage = view.subpage
        }
        layout.push(placed)
        render()
    }

    // a cell belongs to one display: the selection of that display takes it or gives it back, the others stay
    function toggleCell(widget, cell) {
        var display = Plan.displayOfCell(state, cell)
        var cells = selectionCells(widget, display).slice()
        var i = cells.indexOf(cell)
        if (i >= 0) {
            cells.splice(i, 1)
        } else {
            cells.push(cell)
        }
        setCells(widget, cells, display)
    }

    // the background of a drawing: the whole display, or nothing when the widget already takes it
    function toggleFull(widget, display) {
        var full = fullArea(display)
        if (!widget || !full) {
            return
        }
        var cells = Plan.drawnCellsOf(state, full)
        var current = selectionCells(widget, display)
        var same = current.length === cells.length && cells.every(function (c) { return current.indexOf(c) >= 0 })
        setCells(widget, same ? [] : cells, display)
    }

    function removeEntry(entry) {
        layout.splice(layout.indexOf(entry), 1)
        draft = null
        render()
    }

    // every placement of a widget; the bindings stay
    function removeWidget(widget) {
        layout = layout.filter(function (e) { return !(e.instance === widget.instance && e.symbol === widget.symbol) })
        draft = null
        render()
    }

    function select(widget) {
        view.selected = widget ? widgetKey(widget) : null
        // a widget already placed brings the view to where it is, unless one of its placements is in view already
        var placements = widget ? placementsOf(widget) : []
        if (placements.length && !placements.some(inView)) {
            view.page = placements[0].page
            if (placements[0].subpage !== undefined && placements[0].subpage !== null) {
                view.subpage = placements[0].subpage
            }
        }
        // and the display it is on, for a device with more displays
        var shown = placements.filter(inView)
        var area = shown.length ? areaOf(shown[0]) : null
        if (area) {
            view.screen = area.display
        }
        draft = null
        proposal = null
        closePopup()
        render()
    }

    // Assign automatically: a widget not on the display yet gets a page, an area and controls; one already placed
    // only gets controls for its ports left unbound, from the page of its first placement on. Nothing is applied
    // until the proposal is accepted.
    function startAuto(widget) {
        var ports = unboundPorts(widget)
        var placements = placementsOf(widget)
        var result
        if (placements.length) {
            var first = placements[0]
            var firstArea = areaOf(first)
            var plan = Plan.planPorts(model(), ports, first.page, first.subpage || 0, false, firstArea ? firstArea.display : undefined)
            result = { page: first.page, subpage: first.subpage === undefined ? null : first.subpage, area: null,
                       targets: plan.targets, unbound: plan.unbound }
        } else {
            result = Plan.autoAssign(model(), widget, ports)
            if (!result) {
                new Notification('info', "There is no free area for " + widget.name + " on any page")
                return
            }
        }
        proposal = { key: widgetKey(widget), page: result.page, subpage: result.subpage, area: result.area,
                     targets: result.targets, unbound: result.unbound }
        view.page = result.page
        if (result.subpage !== null && result.subpage !== undefined) {
            view.subpage = result.subpage
        }
        if (result.area) {
            view.screen = result.area.display
        }
        draft = null
        render()
    }

    function acceptProposal() {
        var widget = widgetByKey(proposal.key)
        if (proposal.area) {
            var placed = { page: proposal.page, area: proposal.area.id, instance: widget.instance, symbol: widget.symbol }
            if (proposal.area.subpages) {
                placed.subpage = proposal.subpage
            }
            layout.push(placed)
        }
        unboundPorts(widget).forEach(function (port) {
            var target = proposal.targets[port.symbol]
            if (target) {
                addPending(widget, port, target)
            }
        })
        proposal = null
        render()
    }

    // ---------------------------------------------------------------------------------------------------------------
    // binding the suggested ports by tapping the controls

    function addPending(widget, port, slot) {
        pending.push({
            instance: widget.instance,
            symbol: port.symbol,
            uri: slot.uri,
            page: slot.page,
            subpage: slot.subpage,
            label: port.name,
        })
    }

    function pendingAt(key) {
        for (var i = 0; i < pending.length; i++) {
            var b = pending[i]
            if (Plan.slotKey(b.uri, b.page, b.subpage) === key) {
                return b
            }
        }
        return null
    }

    function bindPort(widget, port, slot) {
        pending = pending.filter(function (b) { return !(b.instance === widget.instance && b.symbol === port.symbol) })
        addPending(widget, port, slot)
        closePopup()
        render()
    }

    function unbindPending(b) {
        pending.splice(pending.indexOf(b), 1)
        closePopup()
        render()
    }

    function closePopup() {
        win.find('.js-popup').remove()
    }

    // a menu under a control: the ports it can take, and for one the dialog bound, a way to leave it free again
    function openPopup(anchor, title, items) {
        closePopup()
        var main = win.find('.hmi-widgets-main')
        var popup = $('<div class="hmi-widgets-popup js-popup" role="menu">').append($('<b>').text(title))
        items.forEach(function (item) {
            $('<button type="button" role="menuitem">').text(item.text).toggleClass('danger', !!item.danger)
                .click(function (e) {
                    e.stopPropagation()
                    item.action()
                }).appendTo(popup)
        })
        var a = anchor.offset(), m = main.offset()
        popup.css({ left: Math.round(a.left - m.left) + 'px', top: Math.round(a.top - m.top + anchor.outerHeight() + 4) + 'px' })
        main.append(popup)
        popup.find('button').first().focus()
    }

    // ---------------------------------------------------------------------------------------------------------------
    // rendering

    function render() {
        var m = model()
        win.find('.js-submit').prop('disabled', !!proposal)
        renderList(m)
        renderBand(m)
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
            select(view.selected === widgetKey(widget) ? null : widget)
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

    // the band above the page: the widget being placed, its ports, Assign automatically and the trash
    function renderBand(m) {
        var band = win.find('.js-band').empty()
        var widget = selectedWidget()
        band.toggleClass('active', !!widget).toggleClass('proposal', !!proposal)

        if (!widget) {
            band.append($('<span class="hmi-widgets-band-note">').text('Pick a widget on the left to place it on the display.'))
            return
        }

        var head = $('<div class="hmi-widgets-band-head">').appendTo(band)
        var title = $('<div class="hmi-widgets-band-title">').appendTo(head)

        if (proposal) {
            title.append($('<strong>').text('Proposal: ' + widget.name))
            var where = proposal.area
                ? 'Page ' + (proposal.page + 1) + (proposal.subpage !== null && state.subpages > 1 ? ' · Subpage ' + (proposal.subpage + 1) : '') +
                  ' · ' + displayText(proposal.area) + proposal.area.name
                : 'Only its ports, from page ' + (proposal.page + 1)
            title.append($('<small>').text(where + ' · nothing is applied until you accept it'))
            var actions = $('<div class="hmi-widgets-band-actions">').appendTo(head)
            $('<button type="button" class="btn hmi-widgets-primary">').text('Accept').click(acceptProposal).appendTo(actions)
            $('<button type="button" class="btn">').text('Discard').click(function () {
                proposal = null
                render()
            }).appendTo(actions)
        } else {
            title.append($('<strong>').text('Place: ' + widget.name))
            title.append($('<small>').text(widget.plugin + ' · ' + sizeText(widget)))
            var buttons = $('<div class="hmi-widgets-band-actions">').appendTo(head)
            var ports = unboundPorts(widget)
            $('<button type="button" class="btn">').text('Assign automatically')
                .prop('disabled', !isPlaceable(widget, m) && !(placementsOf(widget).length && ports.length))
                .click(function () { startAuto(widget) }).appendTo(buttons)
            if (placementsOf(widget).length) {
                $('<button type="button" class="hmi-widgets-trash">').html(TRASH_SVG)
                    .attr({ title: 'Remove ' + widget.name + ' from the display', 'aria-label': 'Remove ' + widget.name + ' from the display' })
                    .click(function () { removeWidget(widget) }).appendTo(buttons)
            }
        }

        // the suggested ports, where each one is or would be bound
        var list = suggestedPorts(widget)
        if (list.length) {
            var chips = $('<div class="hmi-widgets-chips">').appendTo(band)
            list.forEach(function (port) {
                var slot = boundSlot(widget.instance, port.symbol)
                var planned = proposal && !port.bound ? proposal.targets[port.symbol] : null
                var chip = $('<span class="hmi-widgets-chip">').append($('<b>').text(port.name))
                if (slot) {
                    chip.addClass('bound').append(document.createTextNode(' ' + slotText(slot)))
                } else if (planned) {
                    chip.addClass('planned').append(document.createTextNode(' ' + slotText(planned)))
                } else {
                    chip.append(document.createTextNode(' ' + (port.kind === 'switch' ? 'switch' : 'knob') + ', not bound'))
                }
                chips.append(chip)
            })
        }
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
    }

    // With the app bar, a choice opens a sheet from the bottom of the screen, as a long
    // press on a control does, see touchControlSheet in js/modgui.js, rather than the
    // browser's own list, which is drawn as zoomed as the page, see --touch-zoom in
    // js/appbar.js. The select stays what holds the choice
    win.on('mousedown touchstart', 'select', function (e) {
        if (! $('body').hasClass('app-bar-mode')) {
            return
        }
        e.preventDefault()
        var select = $(this)
        $('.mod-touch-sheet').remove()
        var sheet = $('<div class="mod-touch-sheet hmi-widgets-sheet">')
        var panel = $('<div class="panel">').appendTo(sheet)
        var title = select.closest('.hmi-widgets-column').children('h5').text() || 'Page'
        $('<div class="title">').text(title).appendTo(panel)
        var add = function (option) {
            $('<div class="item">').toggleClass('selected', option.value === select.val())
                .append($('<span>').text(option.text))
                .click(function () {
                    sheet.remove()
                    if (select.val() !== option.value) {
                        select.val(option.value).change()
                    }
                    return false
                }).appendTo(panel)
        }
        select.children().each(function () {
            if (this.tagName === 'OPTGROUP') {
                $('<div class="title">').text(this.label).appendTo(panel)
                $(this).children().each(function () {
                    add(this)
                })
            } else {
                add(this)
            }
        })
        sheet.click(function (e) {
            if (e.target === sheet[0]) {
                sheet.remove()
            }
        }).appendTo('body')
        return false
    })

    function setWhere(page, subpage) {
        view.page = page
        view.subpage = subpage
        draft = null
        closePopup()
        render()
    }

    function box(rect, scale) {
        return {
            left: Math.round(rect[0] * scale) + 'px',
            top: Math.round(rect[1] * scale) + 'px',
            width: Math.round(rect[2] * scale) + 'px',
            height: Math.round(rect[3] * scale) + 'px',
        }
    }

    function trashButton(label, action) {
        return $('<button type="button" class="hmi-widgets-trash small">').html(TRASH_SVG)
            .attr({ title: label, 'aria-label': label })
            .click(function (e) {
                e.stopPropagation()
                action()
            })
    }

    // the drawings of the displays, side by side, and the status of the display in view
    function renderDisplay(m) {
        var screens = win.find('.js-screens').empty().toggleClass('multi', multi()).css('gap', SCREENS_GAP + 'px')
        var widget = selectedWidget()
        var notes = {}
        displays().forEach(function (display) {
            var block = $('<div class="hmi-widgets-screen">').attr('data-display', display.id)
                .toggleClass('other', view.screen !== display.id).appendTo(screens)
            if (multi()) {
                $('<div class="hmi-widgets-screen-name">').text(display.name)
                    .toggleClass('current', view.screen === display.id).appendTo(block)
            }
            var drawing = $('<div class="hmi-widgets-display">').appendTo(block)
            notes[display.id] = renderDrawing(m, display, drawing, widget)
        })
        renderScreenSwitch()
        var note = notes[view.screen] || { text: '' }
        win.find('.js-status').text(note.text).toggleClass('problem', !!note.problem)
    }

    // on a narrow screen one display at a time: a switch, counting the widgets each one shows on the page in view
    function renderScreenSwitch() {
        var switcher = win.find('.js-screen-switch').empty().toggleClass('multi', multi())
        if (!multi()) {
            return
        }
        displays().forEach(function (display) {
            var count = layout.filter(function (e) {
                var area = areaOf(e)
                return inView(e) && area && area.display === display.id
            }).length
            $('<button type="button" class="hmi-widgets-subpage">').text(display.name)
                .append($('<span class="hmi-widgets-screen-count">').text(count))
                .toggleClass('selected', view.screen === display.id)
                .attr('aria-pressed', view.screen === display.id ? 'true' : 'false')
                .click(function () {
                    view.screen = display.id
                    draft = null
                    closePopup()
                    render()
                })
                .appendTo(switcher)
        })
    }

    // one display: its areas, the widgets in view and the cells to tap. Returns what the status says about it.
    function renderDrawing(m, display, drawing, widget) {
        var width = drawWidth()
        var scale = width / display.rect[2]
        drawing.css({ width: width + 'px', height: Math.round(display.rect[3] * scale) + 'px' })

        var mine = widget && !proposal ? currentEntry(widget, display.id) : null
        var full = fullArea(display.id)
        var onThis = function (area) { return !!area && area.display === display.id }

        // the selection: a proposal, or the cells of the selected widget in view
        var selected = proposal && proposal.area && onThis(proposal.area) && proposal.page === view.page &&
                       (proposal.subpage === null || proposal.subpage === view.subpage)
            ? Plan.drawnCellsOf(state, proposal.area) : (proposal ? [] : selectionCells(widget, display.id))

        // the other placements in view, each with its trash; tapping one picks its widget
        var covered = [], fullTaken = false
        layout.forEach(function (entry) {
            if (entry === mine || !inView(entry)) {
                return
            }
            var area = areaOf(entry)
            if (!onThis(area)) {
                return
            }
            var w = widgetByKey(widgetKey(entry))
            covered = covered.concat(area.cells)
            fullTaken = fullTaken || area === full
            $('<div class="hmi-widgets-area taken">').css(box(area.rect, scale))
                .attr('title', area.name)
                .append($('<span>').text(w ? w.name : entry.symbol))
                .append(trashButton('Remove ' + (w ? w.name : entry.symbol) + ' from ' + area.name,
                                    function () { removeEntry(entry) }))
                .click(function () {
                    if (w && !proposal) {
                        select(w)
                    }
                })
                .appendTo(drawing)
        })

        // the full screen is the background: its label sits on the band no other area has
        var fullFree = false
        if (full && widget && !proposal) {
            var without = modelWithout(mine)
            fullFree = Plan.fits(widget, full) && Plan.isFree(without, full, view.page, view.subpage)
        }
        var allFull = full && selected.length && Plan.drawnCellsOf(state, full).every(function (c) { return selected.indexOf(c) >= 0 })
        drawing.toggleClass('full-selected', !!allFull).toggleClass('full-pickable', fullFree)
        if (full && !fullTaken) {
            $('<button type="button" class="hmi-widgets-full-label">').text(full.name)
                .prop('disabled', !fullFree)
                .click(function (e) {
                    e.stopPropagation()
                    toggleFull(widget, display.id)
                }).appendTo(drawing)
        }
        drawing.off('click').on('click', function (e) {
            if (e.target === this && fullFree) {
                toggleFull(widget, display.id)
            }
        })

        var cells = Plan.drawableCells(state, display.id).filter(function (c) { return covered.indexOf(c) < 0 })

        if (!widget || proposal) {
            cells.forEach(function (cell) {
                var area = Plan.areaForCells(state, [cell])
                $('<div class="hmi-widgets-area">').css(box(Plan.cellRect(state, cell), scale))
                    .toggleClass('selected', selected.indexOf(cell) >= 0)
                    .text(area ? area.name : cell).appendTo(drawing)
            })
            return { text: '' }
        }

        // the cells of the free areas the widget fits in can be tapped, its own ones too
        var lit = []
        Plan.freeAreas(modelWithout(mine), widget, view.page, view.subpage).forEach(function (area) {
            if (onThis(area)) {
                lit = lit.concat(Plan.drawnCellsOf(state, area))
            }
        })

        var own = []
        cells.forEach(function (cell) {
            var area = Plan.areaForCells(state, [cell])
            var isSelected = selected.indexOf(cell) >= 0
            var button = $('<button type="button" class="hmi-widgets-area cell">').css(box(Plan.cellRect(state, cell), scale))
                .text(area ? area.name : cell)
                .toggleClass('lit', lit.indexOf(cell) >= 0)
                .toggleClass('selected', isSelected)
                .attr('aria-pressed', isSelected ? 'true' : 'false')
                .prop('disabled', lit.indexOf(cell) < 0 && !isSelected)
                .click(function (e) {
                    e.stopPropagation()
                    toggleCell(widget, cell)
                })
                .appendTo(drawing)
            if (isSelected) {
                own.push(button)
            }
        })

        // the area the widget takes, with the trash in its corner; on a desktop it shows while the area is hovered
        if (mine && areaOf(mine)) {
            var area = areaOf(mine)
            var outline = $('<div class="hmi-widgets-outline">').css(box(area.rect, scale))
                .append(trashButton('Remove ' + widget.name + ' from ' + area.name, function () { removeEntry(mine) }))
                .appendTo(drawing)
            own.concat([outline.find('.hmi-widgets-trash')]).forEach(function (el) {
                el.on('mouseenter', function () { outline.addClass('hover') })
                  .on('mouseleave', function () { outline.removeClass('hover') })
            })
            return { text: widget.name + ' · ' + displayText(area) + area.name + ' · ' + area.rect[2] + ' × ' + area.rect[3] + ' px' }
        }
        if (selected.length) {
            return { text: cellsProblem(widget, selected, modelWithout(null)), problem: true }
        }
        if (!lit.length && !fullFree) {
            return { problem: true, text: multi()
                ? 'No free area of the ' + display.name + ' fits ' + widget.name + ': pick another display or page, or Assign automatically'
                : 'No free area of this page fits ' + widget.name + ': pick another page or subpage, or Assign automatically' }
        }
        return { text: multi()
            ? 'Tap a display to place ' + widget.name + (fullFree ? ', or its background for its full screen' : '')
            : 'Tap the display to place ' + widget.name + (fullFree ? ', or its background for the full screen' : '') }
    }

    // the controls of the page in view: in a row on a device with one display, under each display on one with more,
    // in the rows its descriptor gives
    function renderControls() {
        var strip = win.find('.js-controls').empty().toggleClass('multi', multi()).css('gap', multi() ? SCREENS_GAP + 'px' : '')
        var taken = takenSlots()
        var title = 'Controls · Page ' + (view.page + 1) + (state.subpages > 1 ? ' · Subpage ' + (view.subpage + 1) : '')
        win.find('.js-controls-title').text(title)

        var widget = proposal ? null : selectedWidget()
        var ports = widget ? unboundPorts(widget) : []

        // what a proposal would add
        var planned = {}
        if (proposal) {
            var pw = widgetByKey(proposal.key)
            for (var symbol in proposal.targets) {
                var t = proposal.targets[symbol]
                var port = portOf(pw.instance, symbol)
                planned[Plan.slotKey(t.uri, t.page, t.subpage)] = port ? port.name : symbol
            }
        }

        var cellFor = function (control, subpage) {
            var slot = { uri: control.uri, page: view.page, subpage: subpage }
            var key = Plan.slotKey(control.uri, view.page, subpage)
            var cell = $('<button type="button" class="hmi-widgets-control">').append($('<b>').text(control.name))
            var b = pendingAt(key)
            var ownPending = b && widget && b.instance === widget.instance &&
                             suggestedPorts(widget).some(function (p) { return p.symbol === b.symbol })

            if (planned[key]) {
                cell.addClass('planned').prop('disabled', true)
                    .append($('<span>').text(planned[key])).append($('<em>').text('proposed'))
            } else if (ownPending) {
                // bound by the dialog to a port of this widget: no replacing, it is unassigned first
                cell.addClass('planned').append($('<span>').text(b.label)).append($('<em>').text('on Save'))
                cell.click(function () {
                    openPopup(cell, control.name, [
                        { text: 'Unassign', danger: true, action: function () { unbindPending(b) } },
                    ])
                })
            } else if (taken[key]) {
                cell.addClass('busy').prop('disabled', true).append($('<span>').text(taken[key].label))
                if (taken[key].pending) {
                    cell.append($('<em>').text('on Save'))
                }
            } else {
                var fit = ports.filter(function (p) { return compatible(p, control.uri) })
                cell.addClass('free').append($('<span>').text('Free'))
                if (!fit.length) {
                    cell.prop('disabled', true)
                } else {
                    cell.addClass('pickable').attr('title', 'Bind a port of ' + widget.name + ' here')
                    cell.click(function () {
                        if (fit.length === 1) {
                            bindPort(widget, fit[0], slot)
                            return
                        }
                        openPopup(cell, control.name, fit.map(function (p) {
                            return { text: p.name + ' · ' + (p.kind === 'switch' ? 'switch' : 'knob'),
                                     action: function () { bindPort(widget, p, slot) } }
                        }))
                    })
                }
            }
            // where a row has no room for the state ("on Save", "proposed"), the tooltip says it
            var note = cell.find('em').text()
            if (note && !cell.attr('title')) {
                cell.attr('title', control.name + ' · ' + cell.find('span').text() + ' · ' + note)
            }
            return cell
        }

        if (!multi()) {
            actuators.knobs.forEach(function (k) { strip.append(cellFor(k, knobSubpage(view.subpage))) })
            actuators.switches.forEach(function (s) { strip.append(cellFor(s, null)) })
            return
        }

        displays().forEach(function (display) {
            var group = $('<div class="hmi-widgets-control-group">').attr('data-display', display.id)
                .toggleClass('other', view.screen !== display.id).css('width', drawWidth() + 'px').appendTo(strip)
            var rows = display.controls.length ? display.controls
                : [actuators.knobs.concat(actuators.switches).map(function (c) { return c.uri })]
            rows.forEach(function (row) {
                var line = $('<div class="hmi-widgets-control-row">').appendTo(group)
                row.forEach(function (uri) {
                    var act = actuators.byUri[uri]
                    if (act && !act.actuator_group) {
                        line.append(cellFor({ uri: uri, name: act.name }, isKnob(uri) ? knobSubpage(view.subpage) : null))
                    }
                })
            })
        })
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
        if (proposal) {
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

    // a tap anywhere else closes the menu of a control
    win.on('mousedown', function (e) {
        if (!$(e.target).closest('.js-popup, .hmi-widgets-control').length) {
            closePopup()
        }
    }).on('keydown', function (e) {
        if (e.key === 'Escape' && win.find('.js-popup').length) {
            closePopup()
            e.stopPropagation()
        }
    })

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
        draft = null
        proposal = null
        closePopup()
        pending = []
        win.hide()
        return false
    })

    win.find('.js-submit').click(function () {
        save()
        return false
    })

    // a server that names no displays has one, as big as its areas, with every area on it
    function withDisplays(data) {
        if (data.displays && data.displays.length) {
            return data
        }
        var w = 1, h = 1
        data.areas.forEach(function (a) {
            w = Math.max(w, a.rect[0] + a.rect[2])
            h = Math.max(h, a.rect[1] + a.rect[3])
            a.display = 'display'
        })
        data.displays = [{ id: 'display', name: 'Display', rect: [0, 0, w, h], controls: [] }]
        return data
    }

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
                state = withDisplays(data)
                layout = JSON.parse(JSON.stringify(data.layout))
                pending = []
                draft = null
                proposal = null
                view = { page: 0, subpage: 0, search: '', placeableOnly: true, grouped: true, selected: null,
                         screen: state.displays[0].id }
                win.toggleClass('multi', multi())

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
