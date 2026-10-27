// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

$.ui.intersect = function(draggable, droppable, toleranceMode) {
    if (!droppable.offset) {
        return false;
    }

    var draggableLeft, draggableTop,
        x1 = (draggable.positionAbs || draggable.position.absolute).left,
        y1 = (draggable.positionAbs || draggable.position.absolute).top,
        x2 = x1 + draggable.helperProportions.width,
        y2 = y1 + draggable.helperProportions.height,
        l = droppable.offset.left,
        t = droppable.offset.top,
        r = l + droppable.proportions.width,
        b = t + droppable.proportions.height;

    switch (toleranceMode) {
    case "custom":
        return (l < x1 + (draggable.helperProportions.width / 2) && // Right Half
                x2 - (draggable.helperProportions.width / 2) < r && // Left Half
                t < y1 + (draggable.helperProportions.height / 2.5) && // Bottom Half
                y2 - (draggable.helperProportions.height / 2.5) < b ); // Top Half
    case "custom-replace":
        {
            var scale = draggable.helper.data('scale');
            if (!scale) {
                return false;
            }

            x1 = draggable.helper.offset().left;
            y1 = draggable.helper.offset().top;
            x2 = x1 + draggable.helper.children().width() * scale;
            y2 = y1 + draggable.helper.children().height() * scale;
            r = l + droppable.proportions.width * scale;
            b = t + droppable.proportions.height * scale;

            /* helper code for display drag and drop areas
            $('#dropable-area').css({ left: l, width: r - l, top: t, height: b - t, })
            $('#draggable-area').css({ left: x1, top: y1, width: x2 - x1, height: y2 - y1, })
            */

            // touch
            return (
                (y1 >= t && y1 <= b) ||	// Top edge touching
                (y2 >= t && y2 <= b) ||	// Bottom edge touching
                (y1 < t && y2 > b)		// Surrounded vertically
            ) && (
                (x1 >= l && x1 <= r) ||	// Left edge touching
                (x2 >= l && x2 <= r) ||	// Right edge touching
                (x1 < l && x2 > r)		// Surrounded horizontally
            );
        }
    case "fit":
        return (l <= x1 && x2 <= r && t <= y1 && y2 <= b);
    case "intersect":
        return (l < x1 + (draggable.helperProportions.width / 2) && // Right Half
            x2 - (draggable.helperProportions.width / 2) < r && // Left Half
            t < y1 + (draggable.helperProportions.height / 2) && // Bottom Half
            y2 - (draggable.helperProportions.height / 2) < b ); // Top Half
    case "pointer":
        draggableLeft = ((draggable.positionAbs || draggable.position.absolute).left + (draggable.clickOffset || draggable.offset.click).left);
        draggableTop = ((draggable.positionAbs || draggable.position.absolute).top + (draggable.clickOffset || draggable.offset.click).top);
        return isOverAxis( draggableTop, t, droppable.proportions().height ) && isOverAxis( draggableLeft, l, droppable.proportions().width );
    case "touch":
        return (
            (y1 >= t && y1 <= b) ||	// Top edge touching
            (y2 >= t && y2 <= b) ||	// Bottom edge touching
            (y1 < t && y2 > b)		// Surrounded vertically
        ) && (
            (x1 >= l && x1 <= r) ||	// Left edge touching
            (x2 >= l && x2 <= r) ||	// Right edge touching
            (x1 < l && x2 > r)		// Surrounded horizontally
        );
    default:
        return false;
    }
};

// Size of a grid mode cell, in canvas units. Room for a typical pedal and its cables:
// real plugins run from 90x155 to 780x480, and most are under 400 wide. A plugin
// bigger than a cell is scaled down to keep PLACEMENT_PAD clear of the cell's edges.
// Plugins are saved where they would be in cells of this size, drawn at
// PLACEMENT_SAVED_ICON_SCALE, whatever size they are drawn in, so a board opens with
// every plugin in the same cell on any screen
var PLACEMENT_SAVED_CELL = { width: 420, height: 620 }
var PLACEMENT_SAVED_ICON_SCALE = 0.75
// The size they are drawn in, see fitCellToScreen: PLACEMENT_NARROW_CELL, or tighter
// from PLACEMENT_WIDE_SCREEN wide up, where there is room to show the plugins bigger
// with less space around them. Both leave the gaps between the plugins wide enough for
// the cables to run along, see gridCableCorners
var PLACEMENT_CELL = { width: 460, height: 660 }
var PLACEMENT_NARROW_CELL = { width: 460, height: 660 }
var PLACEMENT_WIDE_SCREEN = 1280
var PLACEMENT_WIDE_CELL = { width: 360, height: 520 }
var PLACEMENT_PAD = 20
// How big a plugin is drawn in a cell, against the biggest that fits it
var PLACEMENT_ICON_SCALE = 0.68
// How much of a cell grid mode's zoom leaves past the cells in use, to the right and
// below: room to grow the board into, without a whole empty row and column
var PLACEMENT_SPARE = 0.3
// The box the plugin waiting to be placed is drawn in, in the dock, see showPlacementGrid
var PLACEMENT_PREVIEW = { width: 64, height: 40 }

JqueryClass('pedalboard', {
    init: function (options) {
        var self = $(this)
        options = $.extend({
            // baseScale is the initial scale (zoom level) of the pedalboard
            // The scale is the transform scale() css property that the pedalboard has
            baseScale: 0.5,
            // maxScale is the maximum zoom.
            maxScale: 1,
            // wherever to skip zoom animations
            skipAnimations: false,

            // WindowManager instance
            windowManager: new WindowManager(),
            // HardwareManager instance, must be specified
            hardwareManager: null,

            // Wait object, used to show waiting message to user
            wait: new WaitMessage(self),

            // current z index (last plugin added or moved around)
            z_index: 30,

            // This is a margin, in pixels, that will be disconsidered from pedalboard height when calculating
            // hardware ports positioning
            bottomMargin: 0,

            cvAddressing: false,

            // Below are functions that application uses to integrate functionality to pedalboard.
            // They all receive a callback as last parameter, which must be called with a true value
            // to indicate that operation was successfully executed.
            // In case of error, application is expected to communicate error to user and then call the
            // callback with false value. The pedalboard will silently try to keep consistency, with
            // no garantees. (TODO: do something if consistency can't be achieved)

            // Loads a plugin with given plugin uri and instance
            // Application MUST use this instance. Overriding this is mandatory.
            pluginLoad: function (uri, instance, x, y, callback, errorCallback) {
                callback(true)
            },

            // Removes the plugin given by instance
            pluginRemove: function (instance, callback) {
                callback(true)
            },

            // Loads a preset
            pluginPresetLoad: function (instance, uri, callback) {
                callback(true)
            },

            // Save a new preset
            pluginPresetSaveNew: function (instance, name, callback) {
                callback({ok:false})
            },

            // Save a preset, replacing an existing one
            pluginPresetSaveReplace: function (instance, uri, bundlepath, name, callback) {
                callback({ok:false})
            },

            // Delete a preset
            pluginPresetDelete: function (instance, uri, bundlepath, callback) {
                callback(true)
            },

            // Changes the parameter of a plugin's control port
            pluginParameterChange: function (port, value) {},

            // Get value of a plugin parameter
            pluginPatchGet: function (instance, uri) {},

            // Set value of a plugin parameter
            pluginPatchSet: function (instance, uri, valuetype, value) {},

            // Connects two ports
            portConnect: function (fromPort, toPort, callback) {
                callback(true)
            },

            // Disconnect two ports
            portDisconnect: function (fromPort, toPort, callback) {
                callback(true)
            },

            // Removes all plugins
            reset: function (callback) {
                callback(true)
            },

            // Marks the position of a plugin
            pluginMove: function (instance, x, y) {},

            // Takes a list of plugin URIs and gets a dictionary containing all those plugins's data,
            // indexed by URI
            getPluginsData: function (uris, callback) {
                callback({})
            },

            // Show dialog with plugin info, same as clicking on the bottom plugin bar
            showPluginInfo: function (pluginData) {
            },

            // Show the plugin's native UI, in an external desktop window
            showExternalUI: function (instance) {
            },

            // Sets the size of the pedalboard
            windowSize: function (width, height) {},

            // inform dekstop instance that pedalboard has finished loading
            pedalboardFinishedLoading: function (callback) {
                callback()
            },

            // Add new plugin cv output port to available addressable cv ports
            // or update existing cv port's name
            addCVAddressingPluginPort: function (uri, label, callback) {
              callback(true)
            },

            // Remove plugin cv output port from available addressable cv ports
            removeCVAddressingPluginPort: function (uri, callback) {
              callback(true)
            },

            // Show notification that we are using a demo plugin
            notifyDemoPluginLoaded: function () {
            },

            compareSnapshotSwitch: function (slot) {
                console.log("pedalboard compareSnapshotSwitch", slot)
            },
            compareSnapshotTake: function () {
                console.log("pedalboard compareSnapshotTake")
            },
            pluginSettingsWindowOpen: function (pluginGui) {
                console.log("pluginSettingsWindowOpen", pluginGui)
            },
            pluginSettingsWindowClose: function (pluginGui) {
                console.log("pluginSettingsWindowClose", pluginGui)
            },
            getHelpModeActive: function () {
                console.log("pedalboard: getHelpModeActive called")
                return false
            },
            /*
             * Enable, disable or toggle monitoring of a port. 
             * port: The port to change monitoring state. eg. /graph/eq/Ouput
             * mode: can be 'enable', 'disable' or 'toggle'.
             * callback: function to be called when operation is done. 
             *           It will receive a boolean indicating the current 
             *           monitoring state for the port.
             */
            changePortMonitoring: function (port, mode, callback) {
                const urlParam = port + ',' + mode

                $.ajax({
                    url: '/effect/port-audio-monitor' + urlParam,
                    success: function (resp) {
                        if (callback) {
                            callback(resp)
                        }
                    },
                    error: function (xhr, status, error) {
                        if (callback) {
                            callback(false)
                        }
                    },
                    cache: false,
                    dataType: 'json'
                })

            },

            /*
             * Check if a port is being monitored.
             *
             * port: The port to check. eg. /graph/eq/Ouput
             * 
             * Returns: true if the port is being monitored, false otherwise.
             */
            isPortMonitored: function (port) {
                const vumeters = self.data('vumeters')
                const isMonitored = Object.keys(vumeters).includes(port)

                return isMonitored
            },

            // Whether plugins live in a grid of cells, see gridMode
            gridMode: function () {
                return false
            }
        }, options)

        self.pedalboard('wrapApplicationFunctions', options, [
            'pluginLoad', 'pluginRemove',
            'pluginPresetLoad', 'pluginPresetSaveNew', 'pluginPresetSaveReplace', 'pluginPresetDelete',
            'pluginParameterChange', 'pluginPatchGet', 'pluginPatchSet', 'pluginMove',
            'portConnect', 'portDisconnect', 'reset', 'getPluginsData'
        ])

        self.data(options)

        // When bypassApplication is set to true, the applicationFunctions provided by options will be bypassed
        self.data('bypassApplication', false)

        // minScale holds the minimum scale of the pedalboard. It's initialized as being the base scale
        // and gets smaller as pedalboard size grows
        self.data('minScale', options.baseScale)

        self.data('instanceCounter', -1)
        self.data('overCount', 0)

        // Holds all plugins loaded, indexed by instance
        self.data('plugins', {})

        // Instances currently selected by shift-drag or shift-click, indexed by instance
        self.data('selected', {})

        // Grid cells that plugins added into one are waiting to be fitted in, indexed by
        // instance. See addToCell
        self.data('pendingPlacements', {})
        // how a plugin added into a cell is to be cabled, see addToCell
        self.data('pendingWirings', {})
        self.data('placementGrid', null)

        // Hardware inputs and outputs, which have an instance of -1 and symbol as given by application
        self.data('hwInputs', [])
        self.data('hwOutputs', [])

        // all active vumeters
        self.data('vumeters', {})

        // connectionManager keeps track of all connections
        self.data('connectionManager', new ConnectionManager())

        // pending scheduleAdapt debounce, and since when it has been waiting
        self.data('adaptTimer', null)
        self.data('adaptWaitingSince', 0)

        // widgets on the arrive list
        self.data('callbacksToArrive', {})

        // replacement plugin, used for recreating connections
        self.data('replacementPlugin', null)

        // teleported cables: names spoken for, and the boxes currently drawn for them
        self.data('teleportNames', {})
        self.data('teleportBoxes', {})

        // What each output was last called, so toggling a teleport back on restores your
        // label. Never counts as in use -- uniqueness reads teleportNames only -- and is
        // not serialised.
        self.data('teleportNamesRemembered', {})

        // teleported cables named by a map that arrived before their connection existed
        // (applyTeleports, during a bundle load), keyed "from -> to" same as the saved
        // form -- consumed by connect() once the cable actually shows up
        self.data('pendingTeleports', {})

        // true while resetData is tearing a pedalboard down, so teleportsChanged prunes
        // in memory but does not POST the shrinking map to the server -- see resetData
        self.data('teleportsTeardown', false)

        // the label size is a preference, so it has to be applied before any box is drawn
        self.pedalboard('applyTeleportScale')

        // t3k integration
        self.data('T3KIntegration', new T3KIntegration(self, T3K_API_KEY))

        // Pedalboard itself will get big dimensions and will have it's scale and position changed dinamically
        // often. So, let's wrap it inside an element with same original dimensions and positioning, with overflow
        // hidden, so that the visible part of the pedalboard is always occupying the area that was initially determined
        // by the css.
        var parent = $('<div>')
        parent.css({
            width: self.width(),
            height: self.height(),
            position: self.css('position'),
            top: self.css('top'),
            left: self.css('left'),
            overflow: 'hidden'
        })
        parent.insertAfter(self)
        self.appendTo(parent)

        self.pedalboard('resetSize')

        // Pedalboard is expected to be the main element in screen. So, the original margins relative to window will be
        // stored, so that when window is resized, pedalboard is resized too, keeping that margins
        self.data('offset', self.offset())
        self.data('hmargins', $(window).width() - self.parent().width())
        self.data('vmargins', $(window).height() - self.parent().height())
        self.data('topmargin', self.offset().top)

        if (! options.skipAnimations) {
            var resizeTimeout;

            function resizeThrottler() {
                if (resizeTimeout) {
                    clearTimeout(resizeTimeout);
                }
                resizeTimeout = setTimeout(function() {
                    resizeTimeout = null;
                    self.pedalboard('fitToWindow');
                }, 250);
            }

            window.addEventListener("resize", resizeThrottler, false);
            //$(window).resize(resizeThrottler)
        }

        // Create background element to catch dropped jacks
        // Must be much bigger than screen, so that nothing can be
        // dropped outside it even if mouse goes outside window
        var bg = $('<div>')
        bg.addClass('ignore-arrive')
        bg.css({
            width: '300%',
            height: '300%',
            position: 'absolute',
            top: '-100%',
            left: '-100%'
        })
        self.append(bg)
        bg.droppable({
            accept: '[mod-role=output-jack]',
            greedy: true,
            drop: function (event, ui) {
                var jack = ui.draggable
                self.pedalboard('disconnect', jack)
            },
        })
        self.data('background', bg)

        // Create a blank SVG containing some fancy f/x for later use
        self.svg({ onLoad: function (svg) {
            var _svg = svg._svg;
            _svg.setAttribute("id", "styleSVG");
            var defs = svg.defs();
            for (var i = 1; i <= 20; i+=1) {
                var filter = document.createElementNS("http://www.w3.org/2000/svg", 'filter');
                filter.setAttribute("id", "blur_" + i);
                filter.setAttribute("x", "0");
                filter.setAttribute("y", "0");
                var blur = document.createElementNS("http://www.w3.org/2000/svg", 'feGaussianBlur');
                blur.setAttribute("stdDeviation", i / 10);
                filter.appendChild(blur);
                defs.appendChild(filter);
            }
        }});

        // Hovering a port traces every cable touching it. Delegated rather than bound per
        // jack: jacks come and go with every connection, and a port is what knows all of
        // its cables. Hardware ports carry mod-port too, so they trace as well.
        self.on('mouseenter', '[mod-port]', function () {
            self.pedalboard('traceFrom', $(this))
        })
        self.on('mouseleave', '[mod-port]', function () {
            self.pedalboard('clearTracing')
        })

        // What the teleport key will act on. Tracked separately from the tracing hover above, which
        // deliberately ignores ports with nothing connected.
        self.on('mouseenter', '[mod-port]', function () {
            self.data('hoverPort', $(this))
        })
        self.on('mouseleave', '[mod-port]', function () {
            self.data('hoverPort', null)
        })
        self.on('mouseenter', '[mod-role=output-jack]', function () {
            self.data('hoverJack', $(this))
        })

        // A teleported cable is a stub barely long enough to hover, so its label has to be
        // a trace target too -- that is the part of it you can actually put a pointer on.
        self.on('mouseenter', '.mod-teleport', function () {
            var source = $(this).data('sourcePort')
            if (source) {
                self.pedalboard('traceFrom', source)
            }
        })
        self.on('mouseleave', '.mod-teleport', function () {
            self.pedalboard('clearTracing')
        })
        self.on('mouseleave', '[mod-role=output-jack]', function () {
            self.data('hoverJack', null)
        })

        // Dragging the pedalboard moves the view area, shift-dragging selects plugins.
        // preventDrag is already set here if the mousedown landed on a plugin or a jack,
        // as their own handlers fire first on the way up
        self.mousedown(function (e) {
            if (self.data('preventDrag')) {
                return
            }
            if (e.shiftKey) {
                self.pedalboard('marquee', e)
            } else {
                self.pedalboard('setSelection', {})
                self.pedalboard('drag', e)
            }
        })

        // Delete removes the selection. Bound on the document because the pedalboard is
        // not focusable, and ignored while typing so the plugin settings windows, the
        // save dialog and the plugin search all keep working. Backspace counts too, for
        // keyboards whose only delete key is that one
        $(document).keydown(function (e) {
            if (e.which != 46 && e.which != 8) {
                return
            }
            var tag = (e.target.tagName || '').toLowerCase()
            if (tag == 'input' || tag == 'textarea' || tag == 'select' || e.target.isContentEditable) {
                return
            }
            if (! Object.keys(self.data('selected')).length) {
                return
            }
            e.preventDefault()
            self.pedalboard('removeSelected')
        })

        // TELEPORT_KEY splits whatever the pointer is on. Same guards as the delete
        // handler above: never while typing, and never while a cable is being dragged.
        $(document).keydown(function (e) {
            if (e.ctrlKey || e.metaKey || e.altKey) {
                return
            }
            // e.which on keydown is a keyCode, NOT a character code: F4 is 115, and
            // String.fromCharCode(115) is 's', so comparing as text fired this on F4 too.
            // A letter's keyCode is its upper-case char code, which is what to match.
            if (e.which !== TELEPORT_KEY.toUpperCase().charCodeAt(0)
                && e.which !== VUMETER_KEY.toUpperCase().charCodeAt(0)) {
                return
            }
            // keydown auto-repeats about 30 times a second; holding the key would toggle
            // dozens of times, and each toggle-off drops the output's name
            // jQuery 1.9 copies a fixed property list onto its event object and `repeat`
            // is not on it, so this has to come off the native event
            if (e.originalEvent && e.originalEvent.repeat) {
                return
            }
            var tag = (e.target.tagName || '').toLowerCase()
            if (tag == 'input' || tag == 'textarea' || tag == 'select' || e.target.isContentEditable) {
                return
            }
            if (self.pedalboard('connecting')) {
                return
            }
            var targets = self.pedalboard('hoverTargets')
            if (! targets.length) {
                return
            }

            if (e.which === TELEPORT_KEY.toUpperCase().charCodeAt(0)) {
                e.preventDefault()
                self.pedalboard('toggleTeleport', targets)
            } else if (e.which === VUMETER_KEY.toUpperCase().charCodeAt(0)) {
                e.preventDefault()
                self.pedalboard('togglePortsMonitoring', targets)
            }
        })

        // Right-clicking a port offers the same split/join as TELEPORT_KEY, for anyone who
        // does not know the key. Ports with no cables keep the browser's own menu.
        self.on('contextmenu', '[mod-port], [mod-role=output-jack]', function (e) {
            if (self.pedalboard('connecting')) {
                return
            }
            var targets = self.pedalboard('hoverTargets')
            if (! targets.length) {
                return
            }
            e.preventDefault()
            e.stopPropagation()
            var joining = true
            for (var i = 0; i < targets.length; i++) {
                if (! targets[i].data('teleported')) {
                    joining = false
                    break
                }
            }
            $('.mod-port-contextmenu').remove()
            var plural = targets.length > 1 ? 's' : ''
            var menu = $('<div class="mod-port-contextmenu">')
                .css({ left: e.clientX, top: e.clientY })
                .appendTo('body')
            var close = function () {
                menu.remove()
                $(document).off('.portcontextmenu')
            }
            var item = function (label, action, key) {
                var row = $('<div>').text(label).appendTo(menu).on('click', function () {
                    close()
                    action()
                })
                // the shortcut, so the menu teaches it
                if (key) {
                    $('<span class="mod-contextmenu-key">').text(key).appendTo(row)
                }
            }
            item((joining ? 'Join cable' : 'Split cable') + plural, function () {
                self.pedalboard('toggleTeleport', targets)
            }, TELEPORT_KEY)
             item(('Toggle VU Meter' + plural), function () {
                self.pedalboard('togglePortsMonitoring', targets)
            }, VUMETER_KEY)
            // same cables as the split: one jack of an expanded input, else all on the port
            item('Disconnect' + (targets.length > 1 ? ' all' : ''), function () {
                for (const target of targets) {
                    self.pedalboard('disconnect', target)
                }
            })
            menu.on('mousedown', function (ev) {
                ev.stopPropagation()
            })
            $(document).on('mousedown.portcontextmenu keydown.portcontextmenu wheel.portcontextmenu', close)
        })

        // The mouse wheel is used to zoom in and out.
        // A wheel gesture is locked to zooming-or-widget on its FIRST event: while zooming,
        // the pan clamp can slide a knob under a cursor that started over the background,
        // and the rest of the gesture must not start editing that knob's value.
        // Capture phase, so we can decide before the widget's own mousewheel handler runs.
        var gestureEnd = 0, gestureIsZoom = false
        var wheelZoom = function (ev) {
            if (ev.timeStamp > gestureEnd) {
                // ask the event target, not the geometry: an open enumeration list
                // overflows the box of the control port it lives in, so hit-testing
                // bounding boxes calls it background and swallows the list's scrolling
                gestureIsZoom = !self.pedalboard('wheelClaimedByWidget', ev.target)
            }
            // 300ms of quiet ends a gesture, raise it if slow scrolling breaks a zoom in two
            gestureEnd = ev.timeStamp + 300

            if (!gestureIsZoom) {
                return
            }
            // this gesture is ours, keep it away from whatever is under the cursor now
            ev.preventDefault()
            ev.stopPropagation()

            var maxS = self.data('maxScale')
            var minS = self.data('minScale')
            var step = (maxS - minS) / 5
            var steps = ev.wheelDelta != null ? ev.wheelDelta / 120 : -ev.detail / 3
            var scale = self.data('scale')
            var newScale = scale + steps * step
            newScale = Math.min(maxS, newScale)
            newScale = Math.max(minS, newScale)

            if (newScale == scale)
                return

            var canvasX = (ev.pageX - self.offset().left) / scale
            var canvasY = (ev.pageY - self.offset().top) / scale
            var screenX = ev.pageX - self.parent().offset().left
            var screenY = ev.pageY - self.parent().offset().top

            self.pedalboard('zoom', newScale, canvasX, canvasY, screenX, screenY, 0)
        }
        // same event names jquery.mousewheel binds, so stopPropagation actually shields the knobs
        self[0].addEventListener('mousewheel', wheelZoom, true)
        self[0].addEventListener('DOMMouseScroll', wheelZoom, true)

        self.pedalboard('initGestures')

        // In grid mode a plugin's whole cell takes taps for it, not just the plugin,
        // which is drawn much smaller, see cellTap. The plugin takes its own
        self.on('click', function (event) {
            if (! self.pedalboard('gridMode') || self.data('pluginView') || self.data('placementGrid') ||
                $(event.target).closest('.mod-pedal').length) {
                return
            }
            self.pedalboard('cellTap', event, null)
        })

        // To add plugins to pedalboard, user drags and drops a plugin element,
        // one that has been registered with registerAvailablePlugin
        self.droppable({
            accept: '[mod-role=available-plugin]',
            drop: function (event, ui) {
                if (ui.helper.consumed)
                    return // TODO Check if this really necessary
                var scale = self.data('scale')
                var position = {
                    x: (ui.helper.offset().left - self.offset().left) / scale,
                    y: (ui.helper.offset().top - self.offset().top) / scale,
                    width: ui.helper.children().width(),
                    height: ui.helper.children().height()
                }
                if (self.pedalboard('gridMode')) {
                    // into the cell under the middle of the dropped plugin, or the
                    // nearest free one
                    var cell = self.pedalboard('cellAt', position.x + position.width / 2,
                                                         position.y + position.height / 2)
                    self.pedalboard('addToCell', ui.draggable, self.pedalboard('nearestFreeCell', cell, null))
                } else {
                    ui.draggable.trigger('pluginAdded', position)
                }
                var uri = unescape(ui.draggable.attr('mod-uri'));
                var count = self.find('.mod-actions').length;
                _paq.push(['trackEvent', 'plugin', 'plugin-add', uri, count]);
            }
        })

        self.disableSelection()

        return self
    },

    setCvAddressing: function (cvAddressing) {
      var self = $(this);
      self.data('cvAddressing', cvAddressing);
    },

    initGestures: function () {
        var self = $(this)
            // Gestures for tablets
        var startScale, canvasX, canvasY
        self[0].addEventListener('gesturestart', function (ev) {
            if (ev.handled) return
            startScale = self.data('scale')
            canvasX = (ev.pageX - self.offset().left) / startScale
            canvasY = (ev.pageY - self.offset().top) / startScale
            ev.preventDefault()
        })
        self[0].addEventListener('gesturechange', function (ev) {
            if (ev.handled) return
            var maxS = self.data('maxScale')
            var minS = self.data('minScale')
            var scale = self.data('scale')
            var newScale = startScale * ev.scale
            newScale = Math.min(maxS, newScale)
            newScale = Math.max(minS, newScale)

            var screenX = ev.pageX - self.parent().offset().left
            var screenY = ev.pageY - self.parent().offset().top

            self.pedalboard('zoom', newScale, canvasX, canvasY, screenX, screenY, 0)
            ev.preventDefault()
        })
        self[0].addEventListener('dblclick', function (ev) {
            if (ev.handled || self.data('pluginView')) return
            self.pedalboard('zoomOut')
            ev.preventDefault()
        })

        // Everywhere else a pinch is two touch pointers. Safari has the gesture events
        // above and would zoom twice. One finger is a pan, which utils/touch.js gets to
        // the mousedown handler as if it were a mouse
        self.attr('data-touch-mouse', '')
        if ('ongesturestart' in window || ! window.PointerEvent) {
            return
        }
        var fingers = {}
        var pinch = null
        var spread = function () {
            var ids = Object.keys(fingers)
            var a = fingers[ids[0]], b = fingers[ids[1]]
            return {
                distance: Math.max(1, Math.sqrt(Math.pow(a.pageX - b.pageX, 2) + Math.pow(a.pageY - b.pageY, 2))),
                pageX: (a.pageX + b.pageX) / 2,
                pageY: (a.pageY + b.pageY) / 2
            }
        }
        self[0].addEventListener('pointerdown', function (ev) {
            if (ev.pointerType !== 'touch') return
            fingers[ev.pointerId] = { pageX: ev.pageX, pageY: ev.pageY }
            if (Object.keys(fingers).length != 2) {
                pinch = null
                return
            }
            var s = spread()
            var scale = self.data('scale')
            pinch = {
                scale: scale,
                distance: s.distance,
                canvasX: (s.pageX - self.offset().left) / scale,
                canvasY: (s.pageY - self.offset().top) / scale
            }
        }, true)
        self[0].addEventListener('pointermove', function (ev) {
            if (! fingers[ev.pointerId]) return
            fingers[ev.pointerId] = { pageX: ev.pageX, pageY: ev.pageY }
            if (! pinch) return
            var s = spread()
            var newScale = pinch.scale * s.distance / pinch.distance
            newScale = Math.min(self.data('maxScale'), newScale)
            newScale = Math.max(self.data('minScale'), newScale)
            self.pedalboard('zoom', newScale, pinch.canvasX, pinch.canvasY,
                            s.pageX - self.parent().offset().left,
                            s.pageY - self.parent().offset().top, 0)
        }, true)
        var lift = function (ev) {
            delete fingers[ev.pointerId]
            pinch = null
        }
        // on the document, a finger lifted off the board must still be forgotten
        document.addEventListener('pointerup', lift, true)
        document.addEventListener('pointercancel', lift, true)
    },

    // Does anything between a wheel event's target and the pedalboard want the wheel
    // for itself? Asking the target beats hit-testing bounding boxes: an open
    // enumeration list overflows the box of the control port it belongs to, so a
    // geometric test calls it background and the list never gets to scroll.
    wheelClaimedByWidget: function (target) {
        var root = this[0]
        for (var el = target; el && el !== root; el = el.parentElement) {
            // knobs and other value controls -- the wheel edits them
            if (el.getAttribute && el.getAttribute('mod-role') === 'input-control-port')
                return true
            // anything that can actually scroll, e.g. an open .mod-enumerated-list.
            // scrollHeight first: it is free, getComputedStyle is not.
            if (el.scrollHeight > el.clientHeight) {
                var overflow = window.getComputedStyle(el).overflowY
                if (overflow === 'auto' || overflow === 'scroll')
                    return true
            }
        }
        return false
    },

    // This wrap all application functions to provide a way to bypass all of them when desired
    wrapApplicationFunctions: function (options, functions) {
        var self = $(this)
        var factory = function (key, closure) {
                return function () {
                    var callback = arguments[arguments.length - 1]
                    if (self.data('bypassApplication')) {
                        callback(true)
                    } else {
                        closure.apply(this, arguments)
                    }
                }
            }
        // First, let's wrap all application functions to provide a way to bypass all of them when desired
        for (var i in functions)
            options[functions[i]] = factory(functions[i], options[functions[i]])
    },

    fakeLoadFromServerData: function (data, callback, bypassApplication) {
        var self = $(this)
        console.log("PEDALBOARD_DATA")
        console.log(data)
        /*
         * Unserialization will first call all application callbacks and after everything is done,
         * build the pedalboard in screen.
         * To do that, it takes 3 queues to work on (plugins, hw-ports, and connections), and as it's working
         * on them, it queues actions to be done when everything is ready.
         * To work on the instances and connections queues, it uses two asynchronous recursive functions
         * that will process next element element and gives itself as callback for the application.
         */

        // Let's avoid modifying original data
        data = $.extend({}, data)

        // We might want to bypass application
        self.data('bypassApplication', false)

        var ourCallback = function () {
            if (callback)
                callback()
        }

        // Queue closures to all actions needed after everything is loaded
        var finalActions = []
        var finish = function () {
            for (var i in finalActions)
                finalActions[i]()

            self.data('bypassApplication', false)
            setTimeout(function () {
                if (! self.pedalboard('fitToWindow')) {
                    self.pedalboard('adapt', true)
                }
                ourCallback()
            }, 1)
        }

        var loadPlugin, createHardwarePorts, connect

        // Loads the next plugin in queue. Gets as parameter a data structure containing
        // information on all plugins
        loadPlugin = function (pluginsData) {
            var plugin = data.plugins.pop()
            if (plugin == null) {
                // Queue is empty, let's create the hardware ports now
                return createHardwarePorts()
            }

            var pluginData = pluginsData[plugin.uri]

            if (pluginData == null) {
                console.log("Missing plugin:", plugin.uri)
                loadPlugin(pluginsData)
                return
            }

            var instance
            if (plugin.instance) {
                instance = '/graph/' + plugin.instance
            } else {
                instance = self.pedalboard('generateInstance', pluginData.uri)
            }

            self.data('pluginLoad')(plugin.uri, instance, plugin.x, plugin.y,
                function (ok) {
                    if (!ok) {
                        return
                    }
                    var symbol, value
                    for (var i in plugin.ports) {
                        symbol = plugin.ports[i].symbol
                        value  = plugin.ports[i].value
                        self.pedalboard('setPortWidgetsValue', instance, symbol, value)
                    }

                    self.pedalboard('addPlugin', pluginData, instance, plugin.label, plugin.bypassed, plugin.x, plugin.y, {}, function () {
                            loadPlugin(pluginsData)
                        }
                    )
                })
        }

        // Create needed hardware ports
        createHardwarePorts = function () {
            if (data.hardware) {
                var symbol
                for (var i=1, count=data.hardware.audio_ins; i<=count; i++) {
                    symbol = (i < 3) ? ('/graph/capture_' + i) : ('/graph/audio_from_slave_' + (i-2))
                    var hw = $('<div class="ignore-arrive hardware-output" mod-port-index="' + i + '" title="Hardware Capture ' + i + '">')
                    self.pedalboard('addHardwareOutput', hw, symbol, 'audio')
                }
                for (var i=1, count=data.hardware.audio_outs; i<=count; i++) {
                    symbol = (i < 3) ? ('/graph/playback_' + i) : ('/graph/audio_to_slave_' + (i-2))
                    var hw = $('<div class="ignore-arrive hardware-input" mod-port-index="' + i + '" title="Hardware Playback ' + i + '">')
                    self.pedalboard('addHardwareInput', hw, '/graph/playback_' + i, 'audio')
                }
                for (var i=1, count=data.hardware.cv_ins; i<=count; i++) {
                    var hw = $('<div class="ignore-arrive hardware-output" mod-port-index="' + i + '" title="Hardware CV Capture ' + i + '">')
                    self.pedalboard('addHardwareOutput', hw, '/graph/cv_capture_' + i + '_in', 'cv')
                }
                for (var i=1, count=data.hardware.cv_outs; i<=count; i++) {
                    var hw = $('<div class="ignore-arrive hardware-input" mod-port-index="' + i + '" title="Hardware CV Playback ' + i + '">')
                    self.pedalboard('addHardwareInput', hw, '/graph/cv_playback_' + i + '_out', 'cv')
                }
                if (data.hardware.serial_midi_in) {
                    var hw = $('<div class="ignore-arrive hardware-output" mod-port-index="1" title="Hardware DIN MIDI In">')
                    self.pedalboard('addHardwareOutput', hw, '/graph/serial_midi_in', 'midi')
                }
                if (data.hardware.serial_midi_out) {
                    var hw = $('<div class="ignore-arrive hardware-input" mod-port-index="1" title="Hardware DIN MIDI Out">')
                    self.pedalboard('addHardwareInput', hw, '/graph/serial_midi_out', 'midi')
                }
                if (data.hardware.midi_merger_in) {
                    var hw = $('<div class="ignore-arrive hardware-output" mod-port-index="2" title="All MIDI In">')
                    self.pedalboard('addHardwareOutput', hw, '/graph/midi_merger_in', 'midi')
                }
                if (data.hardware.midi_merger_out) {
                    var hw = $('<div class="ignore-arrive hardware-input" mod-port-index="2" title="All MIDI Out">')
                    self.pedalboard('addHardwareInput', hw, '/graph/midi_merger_out', 'midi')
                }
                var portdata, pindex, prefix
                for (var i in data.hardware.midi_ins) {
                    portdata = data.hardware.midi_ins[i]
                    pindex   = parseInt(portdata.symbol.replace("midi_capture_",""))+1
                    var hw = $('<div class="ignore-arrive hardware-output" mod-port-index=' + pindex + ' title="Hardware ' + portdata.name + '">')
                    self.pedalboard('addHardwareOutput', hw, '/graph/' + portdata.symbol, 'midi')
                }
                for (var i in data.hardware.midi_outs) {
                    portdata = data.hardware.midi_outs[i]
                    pindex   = parseInt(portdata.symbol.replace("midi_playback_",""))+1
                    prefix   = portdata.name === 'MIDI Loopback' ? 'Virtual' : 'Hardware'
                    var hw = $('<div class="ignore-arrive hardware-input" mod-port-index=' + pindex + ' title="' + prefix + ' ' + portdata.name + '">')
                    self.pedalboard('addHardwareInput', hw, '/graph/' + portdata.symbol, 'midi')
                }
            }
            self.pedalboard('positionHardwarePorts')
            return connect()
        }

        // Loads next connection in queue
        var connect = function () {
            var conn = data.connections.pop()
            if (conn == null)
                // Queue is empty, let's load everything
                return finish()

            var source = conn.source
            var target = conn.target

            self.data('portConnect')(source, target,
                function (ok) {
                    if (!ok) {
                        return
                    }
                    finalActions.push(function () {
                        var plugins = $.extend({
                            'system': self
                        }, self.data('plugins'))

                        var output = $('[mod-port="/graph/' + source + '"]')
                        var  input = $('[mod-port="/graph/' + target + '"]')

                        self.pedalboard('connect', output.find('[mod-role=output-jack]'), input)
                    })
                    connect()
                })
        }

        var uris = []
        for (var i in data.plugins)
            uris.push(data.plugins[i].uri)

        if (data.width > 0 && data.height > 0) {
            // FIXME: finish this
            self.css({
                width: data.width,
                height: data.height,
                position: 'absolute'
            })
        }

        self.data('getPluginsData')(uris, loadPlugin)
    },

    // Register hardware inputs and outputs, elements that will be used to represent the audio inputs and outputs
    // that interface with the hardware.
    // Note that these are considered inputs and outputs from the pedalboard point of view: the outputs are
    // expected to be a source of sound, and so it's an input from the user perspective; the input is the
    // sound destination, so will be an output to user.
    addHardwareInput: function (element, symbol, portType) {
        var self = $(this)
        element.attr('mod-role', 'input-' + portType + '-port')
        element.attr('mod-port-symbol', symbol)
        element.attr('mod-port', symbol)
        self.pedalboard('makeInput', element, '')
        self.data('hwInputs').push(element)
        self.append(element)
    },

    addHardwareOutput: function (element, symbol, portType) {
        var self = $(this)
        element.attr('mod-role', 'output-' + portType + '-port')
        element.attr('mod-port-symbol', symbol)
        element.attr('mod-port', symbol)
        self.pedalboard('makeOutput', element, '')
        self.data('hwOutputs').push(element)
        self.append(element)
    },

    /* Make this element a draggable item that can be used to add effects to this pedalboard.
     * Plugin adding has the following workflow:
     * 1 - Application registers an HTML element as being an available plugin
     * 2 - User drags this element and drops in Pedalboard
     * 3 - Pedalboard calls a the application callback (pluginLoad option), with plugin uri, instanceID and
     *     another callback.
     * 4 - Application loads the plugin with given instance and calls the pedalboard callback,
     *     or communicate error to user
     * 5 - Pedalboard renders the plugin
     * Parameters are:
     *   - Plugin is a data structure as parsed by mod-python's modcommon.lv2.Plugin class.
     *   - draggableOptions will be passed as parameter to the draggable jquery ui plugin
     */
    registerAvailablePlugin: function (element, pluginData, draggableOptions) {
        var self = $(this)

        element.bind('pluginAdded', function (e, position) {
            var waiter = self.data('wait')
            var instance = self.pedalboard('generateInstance', pluginData.uri)
            if (position.cell) {
                self.data('pendingPlacements')[instance] = position.cell
                self.data('pendingWirings')[instance] = position.wiring
            }
            waiter.startPlugin(instance, position)
            var pluginLoad = self.data('pluginLoad')
            pluginLoad(pluginData.uri, instance, position.x, position.y,
                function () {
                    /*
                    self.pedalboard('addPlugin', pluginData, instance, false, position.x, position.y)
                    setTimeout(function () {
                        self.pedalboard('adapt', true)
                    }, 1)
                    */
                    waiter.stopPlugin(instance, false)
                },
                function () {
                    self.data('replacementPlugin', null)
                    delete self.data('pendingPlacements')[instance]
                    delete self.data('pendingWirings')[instance]
                    waiter.stopPlugin(instance, false)
                })
        })

        element.attr('mod-io-type', pluginData.iotype)
        // for the preview of the plugin waiting to be placed, in tap-to-place
        element.data('pluginData', pluginData)

        var options = {
            defaultIconTemplate: DEFAULT_ICON_TEMPLATE,
            dummy: true,
        }
        var thumb = element.children(".thumb");
        var img = thumb.children("img");
        element.draggable($.extend(draggableOptions, {
            helper: function (event) {
                var dummy = $('<div class="mod-pedal ignore-arrive dummy">');
                var imgrect = img.position();
                imgrect.width = img.width();
                imgrect.height = img.height();
                var clickpos  = { x: event.offsetX,
                                  y: event.offsetY };
                var clickperc = { x: Math.min(imgrect.width, Math.max(0, (event.offsetX - imgrect.left))) / imgrect.width,
                                  y: Math.min(imgrect.height, Math.max(0, (event.offsetY - imgrect.top))) / imgrect.height };
                var pad = { left: parseInt(element.css("padding-left")),
                            top: parseInt(element.css("padding-top")) };
                var renderedVersion = [pluginData.builder,
                                       pluginData.microVersion,
                                       pluginData.minorVersion,
                                       pluginData.release].join('_');
                console.log(pluginData.buildEnvironment)

                dummy.data('overIcons', [])
                dummy.data('scale', self.data('scale'))

                $.ajax({
                    url: '/effect/get',
                    data: {
                        uri: pluginData.uri,
                        version: VERSION,
                        plugin_version: renderedVersion,
                    },
                    success: function (plugin) {
                        new GUI(plugin, options).renderDummyIcon(function (icon) {
                            dummy.attr('class', icon.attr('class'))
                            dummy.addClass('dragging')
                            dummy.css("transformOrigin", "0 0");
                            dummy.css("visibility", "hidden");
                            var children = icon.children();

                            var settle = function () {
                                var scale = self.data('scale');
                                var trans = 'scale(' + scale + ') ';
                                var w = icon.width();
                                var h = icon.height();
                                var tx = (pad.left + clickpos.x) / scale - clickperc.x * w;
                                var ty = (pad.top + clickpos.y) / scale - clickperc.y * h;
                                trans += 'translate(' + tx + 'px, ' + ty + 'px) ';
                                dummy.css({
                                    webkitTransform: trans,
                                    MozTransform: trans,
                                    msTransform: trans,
                                    transform: trans,
                                })
                                dummy.data('scale', scale);
                            }
                            children.resize(function () {
                                icon.width(children.width());
                                icon.height(children.height());
                                settle();
                                dummy.css("visibility", "visible");
                            })
                            dummy.append(children);
                        })
                    },
                    cache: !!pluginData.buildEnvironment,
                    dataType: 'json'
                })
                $('body').append(dummy)
                return dummy
            },
            handle: thumb,
            start: function (event, ui) {
                // prevent adding plugin when help mode is active: block the drag event
                if (self.data('getHelpModeActive')()) {
                    return false
                }
            }
        }))
    },

    // Resize pedalboard size to fit whole window
    // Gives the board the window's whole width and its height less `top` and `bottom`
    // pixels, for when the bars around it are not the ones its css was laid out for, see
    // js/appbar.js
    // `covered` is how much of its bottom is under something floating over it, which
    // grid mode's zoom keeps the cells clear of.
    setMargins: function (top, bottom, covered) {
        var self = $(this)
        self.parent().css({ top: top, left: 0 })
        self.data('hmargins', 0)
        self.data('vmargins', top + bottom)
        self.data('coveredBottom', covered || 0)
        // The board moves by its own pan and zoom, never by scrolling what holds it. That
        // can still be scrolled from script, by an element brought into view, and the
        // board and the plugin view's columns would then sit off where they are drawn
        self.parent().off('scroll.margins').on('scroll.margins', function () {
            this.scrollLeft = 0
            this.scrollTop = 0
        })
        self.pedalboard('fitToWindow')
    },

    // This is a bit buggy, because if window size is reduced, a plugin may get out of the pedalboard
    // area and become unreacheble. To correct this, scaling must also be considered when calculating
    // dimensions
    fitToWindow: function () {
        var self = $(this)

        self.pedalboard('fitCellToScreen')

        var old = {
            width: self.width(),
            height: self.height()
        }

        self.parent().css({
            width: $(window).width() - self.data('hmargins'),
            height: $(window).height() - self.data('vmargins')
        })

        var scale = self.data('baseScale')
        self.css({
            width: self.parent().width() / scale,
            height: self.parent().height() / scale,
        })

        var zoom = self.data('currentZoom')
        if (!zoom) {
            return false
        }

        zoom.screenX = zoom.screenX * self.width() / old.width
        zoom.screenY = zoom.screenY * self.height() / old.height

        self.data('windowSize')(self.width(), self.height())
        self.pedalboard('zoom', Math.min(self.data('scale'), scale), zoom.canvasX, zoom.canvasY, zoom.screenX, zoom.screenY, 0)
        self.pedalboard('adapt', true)

        return true
    },

    // Grid mode lays the board out in PLACEMENT_CELL sized cells, for touch screens
    // where placing a plugin to the pixel is fiddly. Every plugin sits in a cell, scaled
    // down to fit it and centered, and every move lands in a free cell. A plugin's cell
    // is kept on its icon as data('gridCell'), so the occupied cells are always just the
    // plugins on the board. The cells start at the canvas origin rather than being
    // fitted to the canvas, so a cell stays put while the canvas grows.
    gridMode: function () {
        return !! $(this).data('gridMode')()
    },

    cellRect: function (cell) {
        return {
            x: cell.col * PLACEMENT_CELL.width,
            y: cell.row * PLACEMENT_CELL.height,
            width: PLACEMENT_CELL.width,
            height: PLACEMENT_CELL.height
        }
    },

    // Grid mode's cells as big as the screen calls for, see PLACEMENT_WIDE_SCREEN.
    // Every plugin is laid out again when that changes, nothing saved.
    fitCellToScreen: function () {
        var self = $(this)
        var size = $(window).width() >= PLACEMENT_WIDE_SCREEN ? PLACEMENT_WIDE_CELL : PLACEMENT_NARROW_CELL
        if (size.width == PLACEMENT_CELL.width && size.height == PLACEMENT_CELL.height) {
            return
        }
        PLACEMENT_CELL.width = size.width
        PLACEMENT_CELL.height = size.height
        if (! self.data('plugins') || ! self.pedalboard('gridMode')) {
            return
        }
        var plugins = self.data('plugins')
        for (var instance in plugins) {
            var cell = plugins[instance].data && plugins[instance].data('gridCell')
            if (cell) {
                self.pedalboard('fitInCell', instance, plugins[instance], cell, false)
            }
        }
    },

    // Where a plugin w x h in `cell` is saved, and the cell a saved plugin is in, see
    // PLACEMENT_SAVED_CELL. Laid out in a cell of that size the same way as in
    // fitInCell, so a board saved on a screen of either size reads the same
    savedPosition: function (cell, w, h) {
        var s = PLACEMENT_SAVED_ICON_SCALE * Math.min(1, (PLACEMENT_SAVED_CELL.width - 2 * PLACEMENT_PAD) / w,
                                                         (PLACEMENT_SAVED_CELL.height - 2 * PLACEMENT_PAD) / h)
        return {
            x: Math.round(cell.col * PLACEMENT_SAVED_CELL.width + (PLACEMENT_SAVED_CELL.width - w * s) / 2),
            y: Math.round(cell.row * PLACEMENT_SAVED_CELL.height + (PLACEMENT_SAVED_CELL.height - h * s) / 2),
            scale: s
        }
    },

    savedCell: function (x, y, w, h) {
        var s = $(this).pedalboard('savedPosition', { col: 0, row: 0 }, w, h).scale
        return {
            col: Math.max(0, Math.floor((x + w * s / 2) / PLACEMENT_SAVED_CELL.width)),
            row: Math.max(0, Math.floor((y + h * s / 2) / PLACEMENT_SAVED_CELL.height))
        }
    },

    // The cell a canvas point falls in. Nothing goes above or left of the origin.
    cellAt: function (x, y) {
        return {
            col: Math.max(0, Math.floor(x / PLACEMENT_CELL.width)),
            row: Math.max(0, Math.floor(y / PLACEMENT_CELL.height))
        }
    },

    // Whether `cell` has no plugin in it other than `except` (an instance), and no
    // hardware port across it.
    cellFree: function (cell, except) {
        var self = $(this)
        var plugins = self.data('plugins')
        for (var instance in plugins) {
            if (instance == except || ! plugins[instance] || ! plugins[instance].data) {
                continue
            }
            var taken = plugins[instance].data('gridCell')
            if (taken && taken.col == cell.col && taken.row == cell.row) {
                return false
            }
        }
        var rect = self.pedalboard('cellRect', cell)
        var ports = self.pedalboard('hardwarePortRects')
        for (var i = 0; i < ports.length; i++) {
            var t = ports[i]
            if (t.x < rect.x + rect.width && rect.x < t.x + t.width &&
                t.y < rect.y + rect.height && rect.y < t.y + t.height) {
                return false
            }
        }
        return true
    },

    // `cell` if it is free, otherwise the free cell closest to it, searching outwards
    // ring by ring.
    nearestFreeCell: function (cell, except) {
        var self = $(this)
        for (var ring = 0; ring < 64; ring++) {
            var best = null, bestDistance = Infinity
            for (var row = cell.row - ring; row <= cell.row + ring; row++) {
                for (var col = cell.col - ring; col <= cell.col + ring; col++) {
                    if (row < 0 || col < 0 ||
                        Math.max(Math.abs(row - cell.row), Math.abs(col - cell.col)) != ring) {
                        continue
                    }
                    var candidate = { col: col, row: row }
                    var distance = Math.pow(col - cell.col, 2) + Math.pow(row - cell.row, 2)
                    if (distance < bestDistance && self.pedalboard('cellFree', candidate, except)) {
                        best = candidate
                        bestDistance = distance
                    }
                }
            }
            if (best) {
                return best
            }
        }
        return cell
    },

    // The hardware ports as canvas-unit rects. Measured on screen and divided back by
    // the scale, which is the same for every child of the canvas.
    hardwarePortRects: function () {
        var self = $(this)
        var scale = self.data('scale')
        var origin = self[0].getBoundingClientRect()
        return self.data('hwInputs').concat(self.data('hwOutputs')).map(function (port) {
            var r = port[0].getBoundingClientRect()
            return {
                x: (r.left - origin.left) / scale,
                y: (r.top - origin.top) / scale,
                width: r.width / scale,
                height: r.height / scale
            }
        }).filter(function (r) {
            return r.width > 0 && r.height > 0
        })
    },

    // How much a port or jack is scaled by the plugin it sits in, on top of the board's
    // own scale. 1 outside grid mode and for the hardware ports.
    iconScale: function (element) {
        return element.closest('[mod-instance]').data('gridScale') || 1
    },

    // The scale a w x h plugin is drawn at in a cell: PLACEMENT_ICON_SCALE of its size,
    // or of the size that fits inside PLACEMENT_PAD of the cell's edges if smaller.
    cellFitScale: function (w, h) {
        return PLACEMENT_ICON_SCALE * Math.min(1, (PLACEMENT_CELL.width - 2 * PLACEMENT_PAD) / w,
                                                  (PLACEMENT_CELL.height - 2 * PLACEMENT_PAD) / h)
    },

    // Puts a plugin in `cell`: scaled by cellFitScale and centered. The scale is a
    // transform from the top left corner, so the plugin's left/top stay its saved
    // position. `persist` saves the position, which a plugin merely being laid out on
    // load does not.
    fitInCell: function (instance, icon, cell, persist) {
        var self = $(this)
        var w = icon.width()
        var h = icon.height()
        var s = self.pedalboard('cellFitScale', w, h)
        var rect = self.pedalboard('cellRect', cell)
        var x = Math.round(rect.x + (rect.width - w * s) / 2)
        var y = Math.round(rect.y + (rect.height - h * s) / 2)

        icon.data('gridCell', cell)
        icon.data('gridScale', s)
        icon.data('gridSize', { width: w, height: h })
        icon.css({
            left: x,
            top: y,
            transform: s == 1 ? '' : 'scale(' + s + ')',
            'transform-origin': '0 0'
        })
        if (persist) {
            var saved = self.pedalboard('savedPosition', cell, w, h)
            self.data('pluginMove')(instance, saved.x, saved.y)
        }
        self.pedalboard('drawPluginJacks', icon)
        // the cells in use may have grown or shrunk, and the zoom with them
        self.pedalboard('scheduleAdapt', false)
    },

    // Lays out a plugin that just arrived on the board. Into `cell` when it was added
    // by choosing one, otherwise into the cell under its middle, or the nearest free
    // one: boards saved outside grid mode have plugins anywhere, overlapping cells and
    // each other. Only shown, not saved, so opening a board does not modify it.
    snapPlugin: function (instance, icon, cell, tries) {
        var self = $(this)
        // just appended, the gui may have no size until its stylesheet and images are in
        tries = tries || 0
        if (! $.contains(self[0], icon[0])) {
            return
        }
        if ((icon.width() == 0 || icon.height() == 0) && tries < 60) {
            setTimeout(function () {
                self.pedalboard('snapPlugin', instance, icon, cell, tries + 1)
            }, 50)
            return
        }
        var persist = !! cell
        // where it was saved, see PLACEMENT_SAVED_CELL
        if (! cell) {
            cell = self.pedalboard('savedCell', parseInt(icon.css('left')), parseInt(icon.css('top')),
                                   icon.width(), icon.height())
        }
        cell = self.pedalboard('nearestFreeCell', cell, instance)
        self.pedalboard('fitInCell', instance, icon, cell, persist)
        // added into a cell: in place under the plugin flown there, see flyToCell
        var landed = persist && self.data('placementLanded')
        if (landed) {
            self.data('placementLanded', null)
            landed()
        }

        // having a size is not having its final one: the gui keeps growing as its
        // stylesheet and images come in, which leaves it off its cell's center
        if (! icon.data('gridRefit')) {
            icon.data('gridRefit', true)
            icon.children().resize(function () {
                if (! $.contains(self[0], icon[0]) || ! icon.data('gridCell') ||
                    icon.hasClass('ui-draggable-dragging') || ! self.pedalboard('gridMode')) {
                    return
                }
                // some children change size with every fit, the plugin itself does not
                var size = icon.data('gridSize')
                if (size && size.width == icon.width() && size.height == icon.height()) {
                    return
                }
                self.pedalboard('fitInCell', instance, icon, icon.data('gridCell'), persist)
            })
        }
    },

    // Draws the cells over the canvas, free ones marked. The grid lives inside the
    // scaled canvas, so it is in canvas units and follows pan and zoom for free.
    // `except` is an instance whose own cell counts as free.
    buildGrid: function (except) {
        var self = $(this)
        // the cells the canvas only partly shows too: the spare room the zoom leaves past
        // the last row and column is where the board grows
        var cols = Math.ceil(self.width() / PLACEMENT_CELL.width)
        var rows = Math.ceil(self.height() / PLACEMENT_CELL.height)
        var grid = $('<div class="mod-placement-grid ignore-arrive">')
        grid.css({
            width: cols * PLACEMENT_CELL.width,
            height: rows * PLACEMENT_CELL.height,
            'z-index': self.data('z_index') + 1000
        })
        for (var row = 0; row < rows; row++) {
            for (var col = 0; col < cols; col++) {
                var cell = { col: col, row: row }
                var rect = self.pedalboard('cellRect', cell)
                $('<div class="mod-placement-cell">')
                    .addClass(self.pedalboard('cellFree', cell, except) ? 'free' : 'taken')
                    .css({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
                    .data('cell', cell)
                    .appendTo(grid)
            }
        }
        self.append(grid)
        return grid
    },

    // Tap-to-place. `element` is a plugin registered with registerAvailablePlugin, and
    // tapping a free cell adds it there. `done` is called once the grid goes away,
    // whether a plugin was placed or not.
    showPlacementGrid: function (element, done) {
        var self = $(this)
        self.pedalboard('hidePlacementGrid')
        self.pedalboard('finishConnection')

        var grid = self.pedalboard('buildGrid', null)

        grid.on('click', '.mod-placement-cell', function () {
            // the tail of a pan is not a choice
            if (Date.now() - (self.data('lastPanMove') || 0) < 300) {
                return false
            }
            var cell = $(this)
            var chosen = cell.data('cell')
            // a plugin it can take the place of, see markSwapCells
            if (cell.hasClass('swap')) {
                var instance = cell.data('swap')
                self.pedalboard('flyToCell', chosen)
                self.pedalboard('hidePlacementGrid')
                self.pedalboard('swapInCell', element, chosen, instance)
                return false
            }
            // another taken cell does nothing, the plugin stays picked for another try.
            // Read before hiding, removing the grid drops its data
            if (! cell.hasClass('free')) {
                return false
            }
            // before hiding, which takes the preview away
            self.pedalboard('flyToCell', chosen)
            self.pedalboard('hidePlacementGrid')
            self.pedalboard('addToCell', element, chosen)
            return false
        })

        $(document).on('keydown.placement', function (e) {
            if (e.keyCode == 27) {
                self.pedalboard('hidePlacementGrid')
            }
        })

        // The plugin being added waits, drawn small, wherever 'placementstart' puts its
        // preview, the dock, until a cell is chosen. 'placementend' once it is, or not
        var pluginData = element.data('pluginData')
        var preview = $('<div class="mod-placement-preview ignore-arrive">')
        grid.data('preview', preview)
        self.trigger('placementstart', [{ label: pluginData.label || pluginData.name || '', preview: preview }])

        self.pedalboard('renderPluginGhost', pluginData, function (icon, plugin) {
            if (self.data('placementGrid') !== grid) {
                return
            }
            // with its ports known, which the library does not list
            self.pedalboard('showInsertPoints', grid, element, plugin)
            self.pedalboard('markSwapCells', grid, plugin)
            icon.css({ visibility: 'hidden', 'transform-origin': '0 0' }).appendTo(preview)
            var children = icon.children()
            // Shown once it has a size, and sized again whenever that changes: the
            // plugin's stylesheet and images keep arriving after the icon is drawn, and
            // a size taken too early leaves it unscaled and spilling out of its box
            var measure = function () {
                var w = children.width()
                var h = children.height()
                if (! w || ! h) {
                    return false
                }
                icon.width(w).height(h)
                preview.data('icon', icon)
                // as big as fits PLACEMENT_PREVIEW
                var s = Math.min(PLACEMENT_PREVIEW.width / w, PLACEMENT_PREVIEW.height / h)
                icon.css('transform', 'scale(' + s + ')')
                preview.css({ width: w * s, height: h * s })
                icon.css('visibility', 'visible')
                return true
            }
            children.resize(measure)
            var settle = function (tries) {
                if (! measure() && tries < 60) {
                    setTimeout(function () { settle(tries + 1) }, 50)
                }
            }
            settle(0)
        })

        grid.data('done', done)
        self.data('placementGrid', grid)
    },

    // Flies the plugin waiting in its preview into `cell`, where and as big as it will be
    // drawn there. It stays over the cell until the plugin itself has arrived under it,
    // see snapPlugin, and at least until it has landed.
    flyToCell: function (cell) {
        var self = $(this)
        var grid = self.data('placementGrid')
        var icon = grid && grid.data('preview').data('icon')
        if (! icon) {
            return
        }
        var w = icon.width()
        var h = icon.height()
        var from = icon[0].getBoundingClientRect()
        var s = self.pedalboard('cellFitScale', w, h)
        var rect = self.pedalboard('cellRect', cell)
        var origin = self[0].getBoundingClientRect()
        var scale = self.data('scale')

        var flyer = $('<div class="mod-placement-flyer ignore-arrive">').css({
            left: from.left,
            top: from.top,
            width: w,
            height: h,
            transform: 'scale(' + from.width / w + ')'
        }).appendTo('body')
        icon.detach().css('transform', '').appendTo(flyer)
        // laid out where it starts, or the transition has nowhere to start from
        flyer[0].getBoundingClientRect()
        flyer.addClass('flying').css({
            left: origin.left + (rect.x + (rect.width - w * s) / 2) * scale,
            top: origin.top + (rect.y + (rect.height - h * s) / 2) * scale,
            transform: 'scale(' + s * scale + ')'
        })

        var flown = false, landed = false
        var finish = function () {
            if (flown && landed) {
                flyer.remove()
            }
        }
        setTimeout(function () {
            flown = true
            finish()
        }, 400)
        self.data('placementLanded', function () {
            landed = true
            finish()
        })
        // a plugin that never arrives does not leave it there
        setTimeout(function () {
            flyer.remove()
        }, 5000)
    },

    // The cells of the plugins the one waiting to be placed, `pluginData`, can take the
    // place of, keeping their cables, see replaceable. Marked to be swapped, see
    // swapInCell.
    markSwapCells: function (grid, pluginData) {
        var self = $(this)
        var plugins = self.data('plugins')
        var swappable = {}
        for (var instance in plugins) {
            var at = plugins[instance].data && plugins[instance].data('gridCell')
            if (at && self.pedalboard('replaceable', instance, pluginData)) {
                swappable[at.col + ' ' + at.row] = instance
            }
        }
        grid.find('.mod-placement-cell.taken').each(function () {
            var cell = $(this).data('cell')
            var instance = swappable[cell.col + ' ' + cell.row]
            if (instance) {
                $(this).addClass('swap').data('swap', instance)
            }
        })
    },

    // Puts the plugin registered as `element` in the place of `instance`, in its `cell`:
    // the one goes, the other comes in with its cables, see replacementFor.
    swapInCell: function (element, cell, instance) {
        var self = $(this)
        var plugin = self.data('plugins')[instance]
        self.data('replacementPlugin', self.pedalboard('replacementFor', instance))
        // once it has gone, for the cell to be free
        self.pedalboard('removePlugin', instance, plugin.data('ports'), function () {
            self.pedalboard('addToCell', element, cell, { swap: true })
        })
    },

    // Whether a plugin picked from the library is waiting to be placed.
    placing: function () {
        return !! $(this).data('placementGrid')
    },

    // The plugin's icon as it is drawn while dragged out of the bar, for `callback`,
    // along with the plugin's full description.
    renderPluginGhost: function (pluginData, callback) {
        var renderedVersion = [pluginData.builder,
                               pluginData.microVersion,
                               pluginData.minorVersion,
                               pluginData.release].join('_')
        $.ajax({
            url: '/effect/get',
            data: {
                uri: pluginData.uri,
                version: VERSION,
                plugin_version: renderedVersion,
            },
            success: function (plugin) {
                new GUI(plugin, {
                    defaultIconTemplate: DEFAULT_ICON_TEMPLATE,
                    dummy: true,
                }).renderDummyIcon(function (icon) {
                    callback(icon, plugin)
                })
            },
            cache: !!pluginData.buildEnvironment,
            dataType: 'json'
        })
    },

    hidePlacementGrid: function () {
        var self = $(this)
        var grid = self.data('placementGrid')
        if (!grid) {
            return
        }
        var done = grid.data('done')
        grid.data('preview').remove()
        grid.remove()
        self.data('placementGrid', null)
        $(document).off('keydown.placement')
        self.trigger('placementend')
        if (done) {
            done()
        }
    },

    // Adds the plugin registered as `element` into `cell`. It is cabled to its
    // neighbours once it is there, see wirePlugin, or into the cables of `wiring`.
    addToCell: function (element, cell, wiring) {
        var self = $(this)
        var rect = self.pedalboard('cellRect', cell)
        element.trigger('pluginAdded', {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            cell: cell,
            wiring: wiring
        })
    },

    // Grid mode's cabling, of the plugins added into a cell and of the ones removed.
    // Done by asking the host, like a cable drawn by hand: the cables appear on the
    // board as it confirms them. Per kind of port, audio, MIDI and CV, each on its own.

    // A plugin's ports of `type`, as {input: [...], output: [...]} lists of their
    // mod-port names, in the plugin's order
    wirePorts: function (instance, type) {
        var plugin = $(this).data('plugins')[instance]
        var ports = plugin && plugin.data && plugin.data('ports')
        var names = function (list) {
            return $.map(list || [], function (port) {
                return instance + '/' + port.symbol
            })
        }
        return {
            input: names(ports && ports[type] && ports[type].input),
            output: names(ports && ports[type] && ports[type].output)
        }
    },

    // Which of the `outs` go to which of the `ins`, as [out, in] pairs: one by one, left
    // to left and right to right, but a single one on either side to or from all of
    // the other side's, so a mono plugin is fed by and feeds both sides of a stereo one
    wirePairs: function (outs, ins) {
        var pairs = []
        for (var i = 0; i < Math.max(outs.length, ins.length); i++) {
            var out = outs[outs.length == 1 ? 0 : i]
            var inp = ins[ins.length == 1 ? 0 : i]
            if (out !== undefined && inp !== undefined) {
                pairs.push([out, inp])
            }
        }
        return pairs
    },

    // The plugin a plugin in `cell` takes `type` from, on the 'left', or gives it to, on
    // the 'right': the nearest one that way in the same row, else in the nearest row that
    // has one that way, one above, one below, two above and so on. Only plugins with the
    // ports for it count.
    wireNeighbour: function (instance, cell, side, type) {
        var self = $(this)
        var plugins = self.data('plugins')
        var byRow = {}
        for (var other in plugins) {
            var at = other != instance && plugins[other].data && plugins[other].data('gridCell')
            if (! at || (side == 'left' ? at.col >= cell.col : at.col <= cell.col)) {
                continue
            }
            var ports = self.pedalboard('wirePorts', other, type)
            if (! (side == 'left' ? ports.output : ports.input).length) {
                continue
            }
            var best = byRow[at.row]
            if (! best || Math.abs(at.col - cell.col) < Math.abs(best.col - cell.col)) {
                byRow[at.row] = { instance: other, col: at.col }
            }
        }
        var rows = $.map(Object.keys(byRow), Number).sort(function (a, b) {
            return Math.abs(a - cell.row) - Math.abs(b - cell.row) || a - b
        })
        return rows.length ? byRow[rows[0]].instance : null
    },

    // Where the board's `type` comes in, for 'capture', or goes out, for 'playback',
    // when no plugin is there to cable to. The main audio ins and outs, and every MIDI
    // in. Not MIDI out, which could loop back in through the gear on it, nor CV, which
    // drives whatever is plugged in.
    wireHardware: function (direction, type) {
        var self = $(this)
        var elements = self.data(direction == 'capture' ? 'hwOutputs' : 'hwInputs') || []
        var pattern = {
            capture: { audio: /\/capture_\d+$/, midi: /\/(midi_merger_in|serial_midi_in|midi_capture_\d+)$/ },
            playback: { audio: /\/playback_\d+$/ }
        }[direction][type]
        var found = $.map(elements, function (element) {
            var port = $(element).attr('mod-port')
            return pattern && pattern.test(port) ? port : null
        }).sort()
        // the merger already carries every MIDI in
        if (type == 'midi' && found.indexOf('/graph/midi_merger_in') >= 0) {
            return ['/graph/midi_merger_in']
        }
        return found
    },

    // Asks the host for the cable, unless it is there already
    wireConnect: function (from, to) {
        var self = $(this)
        if (! self.data('connectionManager').connected(from, to)) {
            self.data('portConnect')(from, to, function () {})
        }
    },

    // Cables a plugin just added into `cell`: from its neighbour on the left, or the
    // board's inputs, and to its neighbour on the right, or the board's outputs, in
    // place of any cable straight from the one to the other. Or,
    // added into the cables of `wiring` (see showInsertPoints), into those instead.
    wirePlugin: function (instance, cell, wiring) {
        var self = $(this)
        // in the place of another, it takes its cables instead, see swapInCell
        if (wiring && wiring.swap) {
            return
        }
        var connect = function (pair) {
            self.pedalboard('wireConnect', pair[0], pair[1])
        }
        if (wiring) {
            var own = self.pedalboard('wirePorts', instance, wiring.type)
            $.each(wiring.cables, function (i, cable) {
                self.data('portDisconnect')(cable[0], cable[1], function () {})
            })
            // from and to each of the plugins on either side on its own, the cables of
            // a run can go to more than one, see showInsertPoints
            var byPlugin = function (ports) {
                var groups = {}, order = []
                $.each(ports, function (i, port) {
                    var at = port.substring(0, port.lastIndexOf('/'))
                    if (! groups[at]) {
                        groups[at] = []
                        order.push(at)
                    }
                    groups[at].push(port)
                })
                return $.map(order, function (at) { return [groups[at]] })
            }
            $.each(byPlugin(wiring.from), function (i, from) {
                $.each(self.pedalboard('wirePairs', from, own.input), function (j, pair) { connect(pair) })
            })
            $.each(byPlugin(wiring.to), function (i, to) {
                $.each(self.pedalboard('wirePairs', own.output, to), function (j, pair) { connect(pair) })
            })
            return
        }
        var connMgr = self.data('connectionManager')
        $.each(['audio', 'midi', 'cv'], function (i, type) {
            var own = self.pedalboard('wirePorts', instance, type)
            var outs = [], ins = []
            if (own.input.length) {
                var left = self.pedalboard('wireNeighbour', instance, cell, 'left', type)
                outs = left ? self.pedalboard('wirePorts', left, type).output
                            : self.pedalboard('wireHardware', 'capture', type)
                $.each(self.pedalboard('wirePairs', outs, own.input), function (i, pair) { connect(pair) })
            }
            if (own.output.length) {
                var right = self.pedalboard('wireNeighbour', instance, cell, 'right', type)
                ins = right ? self.pedalboard('wirePorts', right, type).input
                            : self.pedalboard('wireHardware', 'playback', type)
                $.each(self.pedalboard('wirePairs', own.output, ins), function (i, pair) { connect(pair) })
            }
            // it goes in between: the cables from one side straight to the other are
            // replaced by the ones through it
            $.each(outs, function (j, from) {
                $.each(ins, function (k, to) {
                    if (connMgr.connected(from, to)) {
                        self.data('portDisconnect')(from, to, function () {})
                    }
                })
            })
        })
    },

    // The cables to put back once `instance` is gone: what went into each of its inputs
    // straight to where the matching output went, left to left and right to right, see
    // wirePairs
    bridgeCables: function (instance) {
        var self = $(this)
        var connMgr = self.data('connectionManager')
        var bridges = []
        var others = function (index, port) {
            return $.grep(Object.keys(index[port] || {}), function (other) {
                return other.lastIndexOf(instance + '/', 0) != 0
            })
        }
        $.each(['audio', 'midi', 'cv'], function (i, type) {
            var own = self.pedalboard('wirePorts', instance, type)
            $.each(self.pedalboard('wirePairs', own.input, own.output), function (j, pair) {
                $.each(others(connMgr.destIndex, pair[0]), function (k, from) {
                    $.each(others(connMgr.origIndex, pair[1]), function (l, to) {
                        bridges.push([from, to])
                    })
                })
            })
        })
        return bridges
    },

    // Makes room for a plugin in column `col`, moving it and every column right of it
    // one to the right
    insertColumn: function (col) {
        var self = $(this)
        var plugins = self.data('plugins')
        for (var instance in plugins) {
            var cell = plugins[instance].data && plugins[instance].data('gridCell')
            if (cell && cell.col >= col) {
                self.pedalboard('fitInCell', instance, plugins[instance], { col: cell.col + 1, row: cell.row }, true)
            }
        }
    },

    // While a plugin waits to be placed: a point on each run of cables between two
    // plugins (or a plugin and the board's ins or outs) that it could go into, in the
    // gutter right before the cell it would go in, level with its middle. Tapping
    // one puts it there, in a column of its own right after where the cables come from,
    // fed by what fed them and feeding what they fed. The cables of one kind between
    // the same two make one run, the left and right of a stereo pair together. No point
    // where a free cell already does the same: put there, the plugin goes between the
    // same two, see wirePlugin.
    showInsertPoints: function (grid, element, pluginData) {
        var self = $(this)
        var plugins = self.data('plugins')
        var scale = self.data('scale')
        var instanceOf = function (port) {
            return port.substring(0, port.lastIndexOf('/'))
        }
        // the order of a port among its plugin's, or among the hardware's by name
        var order = function (port) {
            var instance = instanceOf(port)
            var type = runs.types[port]
            var ports = self.pedalboard('wirePorts', instance, type)
            var index = ports.output.indexOf(port)
            return index >= 0 ? index : ports.input.indexOf(port)
        }

        var runs = { list: {}, types: {} }
        self.data('connectionManager').iterate(function (jack) {
            // a teleported cable is not drawn across the board, there is nowhere to tap
            if (jack.data('teleported')) {
                return
            }
            var output = jack.data('origin')
            var input = jack.data('destination')
            var from = output.attr('mod-port'), to = input.attr('mod-port')
            var type = (input.attr('mod-role') || '').split('-')[1]
            var ports = pluginData.ports[type]
            if (! ports || ! ports.input.length || ! ports.output.length) {
                return
            }
            var key = instanceOf(from) + ' ' + instanceOf(to) + ' ' + type
            var run = runs.list[key] = runs.list[key] || { type: type, cables: [], from: [], to: [] }
            run.cables.push([from, to])
            run.from.indexOf(from) < 0 && run.from.push(from)
            run.to.indexOf(to) < 0 && run.to.push(to)
            runs.types[from] = runs.types[to] = type
        })

        // right after the plugin the cables come from, in its row. From the board's
        // inputs, where the plugin they go to is
        var cellFor = function (run) {
            var source = plugins[instanceOf(run.from[0])]
            var target = plugins[instanceOf(run.to[0])]
            var at = source && source.data && source.data('gridCell')
            if (at) {
                return { col: at.col + 1, row: at.row }
            }
            at = target && target.data && target.data('gridCell')
            return at ? { col: at.col, row: at.row } : { col: 0, row: 0 }
        }

        // whether a plugin put in a free cell would be cabled into `run` anyway
        var freeCells = grid.find('.mod-placement-cell.free').map(function () {
            return $(this).data('cell')
        }).get()
        var between = function (run) {
            var source = instanceOf(run.from[0]), target = instanceOf(run.to[0])
            var fits = function (neighbour, end) {
                return plugins[end] ? neighbour == end : ! neighbour
            }
            for (var i = 0; i < freeCells.length; i++) {
                if (fits(self.pedalboard('wireNeighbour', null, freeCells[i], 'left', run.type), source) &&
                    fits(self.pedalboard('wireNeighbour', null, freeCells[i], 'right', run.type), target)) {
                    return true
                }
            }
            return false
        }

        // as big as the button in a cell, see dashboard.css, but never too small to tap
        var size = Math.max(120, 36 / scale)
        // Runs from the same plugin into the same cell, as when it feeds two plugins in
        // the next column, one per row, are one point: put there, the plugin goes
        // before the split and feeds them all
        var merged = []
        $.each(runs.list, function (key, run) {
            run.cell = cellFor(run)
            // in the gutter the cables leave the plugin they come from by, see
            // gridCableCorners, or enter the one they go to from the board's inputs:
            // halfway along a cable going back, or coming from the edge of the board,
            // is on another plugin, or a cell
            run.x = self.pedalboard('cellRect', run.cell).x
            for (var i = 0; i < merged.length; i++) {
                var other = merged[i]
                if (other.type == run.type && instanceOf(other.from[0]) == instanceOf(run.from[0]) &&
                    other.cell.col == run.cell.col && other.cell.row == run.cell.row) {
                    other.cables = other.cables.concat(run.cables)
                    $.each(run.from, function (j, port) { other.from.indexOf(port) < 0 && other.from.push(port) })
                    $.each(run.to, function (j, port) { other.to.indexOf(port) < 0 && other.to.push(port) })
                    other.split = true
                    return
                }
            }
            merged.push(run)
        })

        $.each(merged, function (i, run) {
            // a free cell does the same only for a run to one plugin
            if (! run.split && between(run)) {
                return
            }
            var sorted = function (ports) {
                return ports.sort(function (a, b) {
                    return instanceOf(a) == instanceOf(b) && order(a) >= 0 && order(b) >= 0
                         ? order(a) - order(b) : (a < b ? -1 : 1)
                })
            }
            sorted(run.from)
            sorted(run.to)
            var x = run.x
            var cell = run.cell
            var row = self.pedalboard('cellRect', cell)
            $('<div class="mod-insert-point">').css({
                left: x - size / 2,
                top: row.y + row.height / 2 - size / 2,
                width: size,
                height: size,
                'border-width': size / 20,
                'font-size': size / 3
            }).click(function () {
                if (Date.now() - (self.data('lastPanMove') || 0) < 300) {
                    return false
                }
                self.pedalboard('insertColumn', cell.col)
                self.pedalboard('flyToCell', cell)
                self.pedalboard('hidePlacementGrid')
                self.pedalboard('addToCell', element, cell, {
                    type: run.type,
                    cables: run.cables,
                    from: run.from,
                    to: run.to
                })
                return false
            }).appendTo(grid)
        })
    },

    // While a plugin is dragged in grid mode: the grid, and the cell it would land in.
    gridDrag: function (instance, icon) {
        var self = $(this)
        var grid = self.data('dragGrid')
        if (! grid) {
            grid = self.pedalboard('buildGrid', instance)
            // under the plugins, the one being dragged included
            grid.addClass('passive').css('z-index', 1)
            $('<div class="mod-placement-target">').appendTo(grid)
            self.data('dragGrid', grid)
        }
        var cell = self.pedalboard('gridDropCell', instance, icon)
        var rect = self.pedalboard('cellRect', cell)
        // over the cut of a free cell, inside its border, see dashboard.css
        var inset = 12
        grid.find('.mod-placement-target')
            .toggleClass('blocked', ! self.pedalboard('cellFree', cell, instance))
            .css({ left: rect.x + inset, top: rect.y + inset,
                   width: rect.width - 2 * inset, height: rect.height - 2 * inset })
    },

    // The cell under the middle of a plugin being dragged.
    gridDropCell: function (instance, icon) {
        var s = icon.data('gridScale') || 1
        return $(this).pedalboard('cellAt', parseInt(icon.css('left')) + icon.width() * s / 2,
                                            parseInt(icon.css('top')) + icon.height() * s / 2)
    },

    // A dragged plugin lands in the cell under it if that one is free, and goes back to
    // its own otherwise.
    gridDrop: function (instance, icon) {
        var self = $(this)
        var grid = self.data('dragGrid')
        if (grid) {
            grid.remove()
            self.data('dragGrid', null)
        }
        var cell = self.pedalboard('gridDropCell', instance, icon)
        if (! self.pedalboard('cellFree', cell, instance)) {
            cell = icon.data('gridCell') || self.pedalboard('nearestFreeCell', cell, instance)
        }
        var from = { left: parseInt(icon.css('left')), top: parseInt(icon.css('top')) }
        self.pedalboard('fitInCell', instance, icon, cell, true)
        // and glides there from where it was let go, as one being added flies into its
        // cell, see flyToCell, its cables following
        var to = { left: parseInt(icon.css('left')), top: parseInt(icon.css('top')) }
        if (from.left != to.left || from.top != to.top) {
            icon.stop(true).css(from).animate(to, {
                duration: 400,
                progress: function () {
                    self.pedalboard('drawPluginJacks', icon)
                },
                complete: function () {
                    self.pedalboard('drawPluginJacks', icon)
                }
            })
        }
    },

    // Prevents dragging of whole dashboard when dragging of effect or jack starts
    preventDrag: function (prevent) {
        $(this).data('preventDrag', prevent)
    },

    // Replaces the current selection. Keys of `selected` are plugin instances
    setSelection: function (selected) {
        var self = $(this)
        var plugins = self.data('plugins')
        for (var instance in plugins) {
            if (plugins[instance] && plugins[instance].length) {
                plugins[instance].toggleClass('mod-selected', !!selected[instance])
            }
        }
        // lets the stylesheet fade everything that is not selected
        self.toggleClass('mod-has-selection', Object.keys(selected).length > 0)
        self.data('selected', selected)
    },

    // Adds or removes a single plugin from the selection, for shift-click
    toggleSelected: function (instance) {
        var self = $(this)
        var selected = self.data('selected')
        if (selected[instance]) {
            delete selected[instance]
        } else {
            selected[instance] = true
        }
        self.pedalboard('setSelection', selected)
    },

    // Removes every selected plugin. Asks first when more than one is going, since there
    // is no undo and a stray Delete could otherwise take out a whole board
    removeSelected: function () {
        var self = $(this)
        var plugins = self.data('plugins')
        // snapshot the keys: removing a plugin drops it from the selection as it goes
        var instances = Object.keys(self.data('selected'))
        if (! instances.length) {
            return
        }
        if (instances.length > 1 &&
            ! confirm('Remove ' + instances.length + ' plugins from the pedalboard?')) {
            return
        }

        self.pedalboard('finishConnection')
        for (var i = 0; i < instances.length; i++) {
            var plugin = plugins[instances[i]]
            if (! plugin || ! plugin.length) {
                continue
            }
            // ports is only needed so removePlugin can drop the plugin's cv outputs from
            // the hardware manager; addPlugin stashes it on the icon for us
            self.pedalboard('removePlugin', instances[i], plugin.data('ports'))
        }
        self.pedalboard('setSelection', {})
    },

    // Shift-dragging the background rubber-bands a box and selects what it touches.
    // The box lives in the unscaled parent, so it needs no scale math, and the hit test
    // uses getBoundingClientRect, which is already in the same screen space
    marquee: function (start) {
        var self = $(this)
        var box = $('<div class="mod-selection-box">').appendTo(self.parent())
        var parentRect = self.parent()[0].getBoundingClientRect()

        var rectOf = function (e) {
            return {
                left: Math.min(start.clientX, e.clientX),
                right: Math.max(start.clientX, e.clientX),
                top: Math.min(start.clientY, e.clientY),
                bottom: Math.max(start.clientY, e.clientY)
            }
        }

        var moveHandler = function (e) {
            var r = rectOf(e)
            box.css({
                left: r.left - parentRect.left,
                top: r.top - parentRect.top,
                width: r.right - r.left,
                height: r.bottom - r.top
            })
        }

        var upHandler = function (e) {
            $(document).unbind('mousemove', moveHandler)
            $(document).unbind('mouseup', upHandler)
            box.remove()

            var r = rectOf(e)
            if (r.right - r.left < 4 && r.bottom - r.top < 4) {
                // a shift-click with no drag, leave the selection alone
                return
            }

            var selected = {}
            var plugins = self.data('plugins')
            for (var instance in plugins) {
                if (! plugins[instance] || ! plugins[instance].length) {
                    continue
                }
                var b = plugins[instance][0].getBoundingClientRect()
                if (b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) {
                    selected[instance] = true
                }
            }
            self.pedalboard('setSelection', selected)
        }

        $(document).bind('mousemove', moveHandler)
        $(document).bind('mouseup', upHandler)
    },

    // Called when a plugin drag starts. If that plugin is selected, remember where every
    // other selected plugin sits so the drag can move them all by the same delta
    startGroupDrag: function (instance) {
        var self = $(this)
        var plugins = self.data('plugins')
        var selected = self.data('selected')

        self.data('dragGroup', null)
        if (! selected[instance]) {
            return
        }

        var group = []
        for (var other in selected) {
            if (other == instance || ! plugins[other] || ! plugins[other].length) {
                continue
            }
            group.push({
                instance: other,
                icon: plugins[other],
                left: parseInt(plugins[other].css('left')),
                top: parseInt(plugins[other].css('top'))
            })
        }
        if (! group.length) {
            return
        }

        self.data('dragGroup', group)
        self.data('dragOrigin', {
            left: parseInt(plugins[instance].css('left')),
            top: parseInt(plugins[instance].css('top'))
        })
    },

    // Moves the rest of the selection to follow the dragged plugin. left/top are the
    // dragged plugin's new position, in canvas units
    dragGroupTo: function (left, top) {
        var self = $(this)
        var group = self.data('dragGroup')
        if (! group) {
            return
        }
        var origin = self.data('dragOrigin')
        var dx = left - origin.left
        var dy = top - origin.top
        for (var i = 0; i < group.length; i++) {
            group[i].icon.css({
                left: group[i].left + dx,
                top: group[i].top + dy
            })
            self.pedalboard('drawPluginJacks', group[i].icon)
        }
    },

    // Persists the new position of every plugin that moved along with the dragged one
    finishGroupDrag: function () {
        var self = $(this)
        var group = self.data('dragGroup')
        if (! group) {
            return
        }
        for (var i = 0; i < group.length; i++) {
            self.data('pluginMove')(group[i].instance,
                                    parseInt(group[i].icon.css('left')),
                                    parseInt(group[i].icon.css('top')))
        }
        self.data('dragGroup', null)
    },

    // Moves the viewable area of the pedalboard
    drag: function (start) {
        var self = $(this)

        self.trigger('dragStart')

        var scale = self.data('scale')

        var canvasX = (start.pageX - self.offset().left) / scale
        var canvasY = (start.pageY - self.offset().top) / scale
        var screenX = start.pageX - self.parent().offset().left
        var screenY = start.pageY - self.parent().offset().top

        var moveHandler = function (e) {
            if (self.data('preventDrag'))
                return

            self.data('lastPanMove', Date.now())
            self.pedalboard('zoom', scale, canvasX, canvasY,
                screenX + e.pageX - start.pageX,
                screenY + e.pageY - start.pageY,
                0)
        }

        var upHandler = function (e) {
            $(document).unbind('mouseup', upHandler)
            $(document).unbind('mousemove', moveHandler)
        }

        $(document).bind('mousemove', moveHandler)
        $(document).bind('mouseup', upHandler)
    },

    // Changes the viewing scale of the pedalboard and position it in a way that
    // the (canvasX, canvasY) point of pedalboard will match the (screenX, screenY)
    // position of the screen. This way, when user uses the mousewheel to zoom, the
    // mouse will remain in the same point of the pedalboard while scale is changed.
    // Duration is the time in miliseconds used to animate the zoom, default is 400.
    // Unless `free`, the view stays inside the canvas.
    zoom: function (scale, canvasX, canvasY, screenX, screenY, duration, free) {
        var self = $(this)
        self.data('currentZoom', {
            scale: scale,
            canvasX: canvasX,
            canvasY: canvasY,
            screenX: screenX,
            screenY: screenY
        })

        // This is the offset put by browser, must be compensated
        var autoOffsetX = -self.width() * (scale - 1) / 2
        var autoOffsetY = -self.height() * (scale - 1) / 2

        // This is the position of this point in pixels
        var absoluteX = canvasX * scale
        var absoluteY = canvasY * scale

        var offsetX = -autoOffsetX - absoluteX + screenX
        var offsetY = -autoOffsetY - absoluteY + screenY

        var maxOffsetX = -autoOffsetX
        var minOffsetX = -autoOffsetX - self.width() * scale + self.parent().width()
        var maxOffsetY = -autoOffsetY
        var minOffsetY = -autoOffsetY - self.height() * scale + self.parent().height()

        if (! free) {
            offsetX = Math.max(minOffsetX, offsetX)
            offsetX = Math.min(maxOffsetX, offsetX)
            offsetY = Math.max(minOffsetY, offsetY)
            offsetY = Math.min(maxOffsetY, offsetY)
        }

        self.data('offsetX', offsetX)
        self.data('offsetY', offsetY)

        if (self.data('skipAnimations')) {
            duration = 0
        } else if (duration == null) {
            duration = 400
        }

        // workaround some browsers that send a zero value at step start, which is an invalid scale
        var usingInitialZero = false
        var oldScale = self.data('scale')
        var newScale = scale

        self.animate({
            scale: scale,
            top: offsetY,
            left: offsetX
        }, {
            duration: duration,
            step: function (value, prop) {
                if (prop.prop != 'scale') {
                    return
                }
                // if we receive a value of 0, which is impossible for the scale variable, trigger workaround
                if (value == 0) {
                    usingInitialZero = true
                }
                if (usingInitialZero) {
                    var per = value / newScale
                    value = (oldScale * (1.0 - per)) + (newScale * per)
                }

                self.css({
                    webkitTransform: 'scale(' + value + ')',
                    MozTransform: 'scale(' + value + ')',
                    msTransform: 'scale(' + value + ')',
                    transform: 'scale(' + value + ')',
                })
                self.data('scale', value)
            },
        })
    },

    // Changes the scale of the pedalboard and centers view on (x, y)
    zoomAt: function (scale, x, y, duration) {
        var self = $(this)

        var screenX = self.parent().width() / 2
        var screenY = self.parent().height() / 2
        self.pedalboard('zoom', scale, x, y, screenX, screenY, duration)
    },

    // Zoom to desired plugin
    focusPlugin: function (plugin) {
        var self = $(this)
        var scale = self.data('scale')
        var x = plugin.position().left / scale + plugin.width() / 2
        var y = plugin.position().top / scale + plugin.height() / 2
        self.pedalboard('zoomAt', 1, x, y)
    },

    // Grid mode's plugin view: one plugin as big as the screen allows, the plugins
    // feeding it in a column on the left and the ones it feeds on the right. Everything
    // else on the board goes behind a backdrop, inside the canvas so it can stay under
    // the plugin. A swipe goes along the cables, to a plugin on the left or the right,
    // a double tap on the plugin opens its settings, one on the backdrop goes back to
    // the whole board. The app bar shows the plugin's own actions meanwhile, on the
    // 'pluginview' event.
    showPlugin: function (instance, duration) {
        var self = $(this)
        var icon = self.data('plugins')[instance]
        if (! icon || ! icon.data || ! icon.data('gridSize')) {
            return
        }
        if (duration == null) {
            duration = 400
        }
        var view = self.data('pluginView')
        if (! view) {
            view = self.pedalboard('openPluginView')
        }

        // the plugin left behind stays over the backdrop until the view has moved off it
        var previous = view.instance && view.instance != instance ? self.data('plugins')[view.instance] : null
        if (previous && previous.length) {
            view.from = view.instance
            setTimeout(function () {
                if (self.data('pluginView') == view && view.instance != previous.attr('mod-instance')) {
                    previous.removeClass('mod-viewed')
                }
            }, duration)
        }
        view.instance = instance
        var z = self.data('z_index')
        view.backdrop.css('z-index', z + 1)
        icon.addClass('mod-viewed').css('z-index', z + 2)
        self.data('z_index', z + 2)

        self.pedalboard('fillPluginView')

        // as big as it fits between the columns and above the dock, up to twice its own
        // size, beyond which it only gets blurry
        var size = icon.data('gridSize')
        var cellScale = icon.data('gridScale')
        var room = self.pedalboard('pluginViewRoom')
        var scale = Math.min(2, room.width / size.width, room.height / size.height) / cellScale
        var x = parseFloat(icon.css('left')) + size.width * cellScale / 2
        var y = parseFloat(icon.css('top')) + size.height * cellScale / 2
        self.pedalboard('zoom', scale, x, y, room.x, room.y, duration, true)
        self.trigger('pluginview', instance)
    },

    // Where the viewed plugin goes: the middle of the screen between the side columns,
    // above the dock, and how much room it has there
    pluginViewRoom: function () {
        var self = $(this)
        var view = self.data('pluginView')
        var margin = 16
        var side = view.inputs.outerWidth()
        var width = self.parent().width()
        var height = self.parent().height() - (self.data('coveredBottom') || 0)
        return {
            x: width / 2,
            y: height / 2,
            width: width - 2 * (side + margin),
            height: height - 2 * margin
        }
    },

    openPluginView: function () {
        var self = $(this)
        var view = {}

        // A swipe or a double tap. The backdrop handles its own touches: utils/touch.js
        // would make them a pan of the board
        var down = null, lastTap = 0
        var gestures = function (element, onDoubleTap) {
            element.attr('data-touch-native', '').on('mousedown', function (e) {
                e.stopPropagation()
            })
            var release = function (ev) {
                if (! down || down.pointerId != ev.pointerId) {
                    return
                }
                var dx = ev.clientX - down.clientX
                var dy = ev.clientY - down.clientY
                down = null
                if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
                    lastTap = 0
                    self.pedalboard('stepPluginView', dx < 0 ? 'outputs' : 'inputs')
                } else if (onDoubleTap && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
                    if (Date.now() - lastTap < 350) {
                        lastTap = 0
                        onDoubleTap()
                    } else {
                        lastTap = Date.now()
                    }
                }
            }
            element.each(function () {
                this.addEventListener('pointerdown', function (ev) {
                    ev.stopPropagation()
                    // A swipe on the backdrop may well end over the plugin, where a mouse
                    // would release. Not on the columns, where it would take the taps
                    // from their entries
                    if (onDoubleTap) {
                        this.setPointerCapture(ev.pointerId)
                    }
                    down = ev
                })
                this.addEventListener('pointerup', release)
            })
        }

        view.backdrop = $('<div class="mod-plugin-view-backdrop ignore-arrive">').appendTo(self)
        gestures(view.backdrop, function () {
            self.pedalboard('leavePluginView')
        })
        view.inputs = $('<div class="mod-plugin-view-side inputs">').appendTo(self.parent())
        view.outputs = $('<div class="mod-plugin-view-side outputs">').appendTo(self.parent())
        gestures(view.inputs.add(view.outputs))
        view.inputs.add(view.outputs).css('bottom', self.data('coveredBottom') || 0)

        // a double tap on the plugin's own background, not on its controls, opens its
        // settings
        var tapped = 0
        view.iconTap = function (ev) {
            var role = $(ev.target).closest('[mod-role]')
            if (! role.is('[mod-role=drag-handle]') || $(ev.target).closest('.mod-actions').length) {
                return
            }
            if (Date.now() - tapped < 350) {
                tapped = 0
                var icon = self.data('plugins')[view.instance]
                icon && icon.find('.mod-settings').click()
            } else {
                tapped = Date.now()
            }
        }
        self.on('click', '.mod-viewed', view.iconTap)

        self.data('pluginView', view)
        $('body').addClass('plugin-view')
        // faded in, as the view moves to the plugin
        view.backdrop[0].getBoundingClientRect()
        view.backdrop.add(view.inputs).add(view.outputs).addClass('shown')
        return view
    },

    // The plugins (and hardware ports) cabled into the viewed plugin and out of it, in
    // the side columns. Tapping one goes to it.
    fillPluginView: function () {
        var self = $(this)
        var view = self.data('pluginView')
        var neighbours = self.pedalboard('pluginNeighbours', view.instance)
        $.each(['inputs', 'outputs'], function (i, side) {
            var column = view[side].empty()
            $('<div class="title">').text(side == 'inputs' ? 'From' : 'To').appendTo(column)
            if (! neighbours[side].length) {
                $('<div class="none">').text('Not connected').appendTo(column)
            }
            $.each(neighbours[side], function (j, other) {
                // above each, the way to unplug it: every cable between the two goes,
                // and it leaves the column as the host confirms them gone
                $('<div class="disconnect">').text('Disconnect').click(function () {
                    $.each(other.cables, function (k, cable) {
                        self.data('portDisconnect')(cable[0], cable[1], function () {})
                    })
                    return false
                }).appendTo(column)
                var entry = $('<div class="entry">').appendTo(column)
                if (other.instance) {
                    $('<img>').attr('src', other.thumbnail).appendTo(entry)
                    entry.click(function () {
                        self.pedalboard('showPlugin', other.instance)
                    })
                } else {
                    entry.addClass('hardware')
                }
                $('<div class="label">').text(other.label).appendTo(entry)
            })
        })
    },

    // The side columns again, once the cables have stopped changing: a stereo pair
    // goes or comes as two
    refreshPluginView: function () {
        var self = $(this)
        if (! self.data('pluginView')) {
            return
        }
        clearTimeout(self.data('pluginViewRefresh'))
        self.data('pluginViewRefresh', setTimeout(function () {
            if (self.data('pluginView')) {
                self.pedalboard('fillPluginView')
            }
        }, 50))
    },

    // What a plugin is cabled to: {inputs: [...], outputs: [...]}, each a list of
    // {instance, label, thumbnail} for plugins and {label} for hardware ports, along
    // with the [from, to] cables between the two in `cables`, the
    // plugins in the order of their cells, column by column, the hardware at the ends
    pluginNeighbours: function (instance) {
        var self = $(this)
        var plugins = self.data('plugins')
        var found = { inputs: {}, outputs: {} }
        var instanceOf = function (port) {
            return port.substring(0, port.lastIndexOf('/'))
        }
        self.data('connectionManager').iterateInstance(instance, function (jack) {
            var origin = jack.data('origin')
            var destination = jack.data('destination')
            var incoming = instanceOf(destination.attr('mod-port')) == instance
            var side = incoming ? 'inputs' : 'outputs'
            var element = incoming ? origin : destination
            var other = instanceOf(element.attr('mod-port'))
            if (other == instance) {
                return
            }
            var plugin = plugins[other]
            var key, entry
            if (plugin && plugin.data && plugin.data('gui')) {
                var effect = plugin.data('gui').effect
                var ver = [effect.builder, effect.microVersion, effect.minorVersion, effect.release].join('_')
                key = other
                entry = {
                    instance: other,
                    label: effect.label || effect.name,
                    cell: plugin.data('gridCell') || { col: 0, row: 0 },
                    thumbnail: effect.gui && effect.gui.thumbnail
                             ? '/effect/image/thumbnail.png?uri=' + escape(effect.uri) + '&v=' + ver
                             : '/resources/pedals/default-thumbnail.png'
                }
            } else {
                var label = (element.closest('[title]').attr('title') || element.attr('mod-port'))
                key = label.replace(/^Hardware /, '')
                entry = { label: key }
            }
            found[side][key] = found[side][key] || $.extend(entry, { cables: [] })
            found[side][key].cables.push([origin.attr('mod-port'), destination.attr('mod-port')])
        })
        var sorted = function (side, hardwareFirst) {
            var list = $.map(found[side], function (other) { return other })
            return list.sort(function (a, b) {
                if (! a.instance != ! b.instance) {
                    return (! a.instance) == hardwareFirst ? -1 : 1
                }
                if (! a.instance) {
                    return a.label < b.label ? -1 : 1
                }
                return a.cell.col - b.cell.col || a.cell.row - b.cell.row
            })
        }
        return { inputs: sorted('inputs', true), outputs: sorted('outputs', false) }
    },

    // Goes along the cables to a plugin on one side: back to the one the view came
    // from if it is there, otherwise to the first one
    stepPluginView: function (side) {
        var self = $(this)
        var view = self.data('pluginView')
        var targets = $.grep(self.pedalboard('pluginNeighbours', view.instance)[side], function (other) {
            return !! other.instance
        })
        if (! targets.length) {
            view[side].removeClass('bump')
            view[side][0].getBoundingClientRect()
            view[side].addClass('bump')
            return
        }
        var target = targets[0].instance
        for (var i = 0; i < targets.length; i++) {
            if (targets[i].instance == view.from) {
                target = view.from
            }
        }
        self.pedalboard('showPlugin', target)
    },

    // Back to the whole board, at grid mode's own zoom
    leavePluginView: function () {
        var self = $(this)
        var view = self.data('pluginView')
        if (! view) {
            return
        }
        self.data('pluginView', null)
        self.off('click', '.mod-viewed', view.iconTap)
        $('body').removeClass('plugin-view')
        var parts = view.backdrop.add(view.inputs).add(view.outputs).removeClass('shown')
        setTimeout(function () {
            parts.remove()
            self.find('.mod-viewed').removeClass('mod-viewed')
        }, 400)
        var fit = self.pedalboard('gridFitScale')
        self.data('gridFit', fit)
        self.data('minScale', fit)
        self.pedalboard('zoom', fit, 0, 0, 0, 0, 400)
        // and the canvas sized for it, should the cells in use have changed meanwhile
        setTimeout(function () {
            self.pedalboard('adapt', true)
        }, 400)
        self.trigger('pluginview', null)
    },

    // Increase zoom level
    zoomIn: function () {
        var self = $(this)
        var scale = self.data('scale')
        var newScale
        if (scale == 1)
            return

        if (scale >= 0.5)
            newScale = 1
        else
            newScale = 0.5
        if (newScale > scale) {
            var x = $(window).width() / 2
            var y = $(window).height() / 2
            var canvasX = (x - self.offset().left) / scale
            var canvasY = (y - self.offset().top) / scale
            var screenX = x - self.parent().offset().left
            var screenY = y - self.parent().offset().top

            self.pedalboard('zoom', newScale, canvasX, canvasY, screenX, screenY, 500)
        }
    },

    // Decrease zoom level
    zoomOut: function () {
        var self = $(this)
        var scale = self.data('scale')
        var newScale
        if (scale == self.data('minScale'))
            return
        if (scale <= 0.5)
            newScale = self.data('minScale')
        else
            newScale = 0.5
        if (newScale < scale) {
            var x = $(window).width() / 2
            var y = $(window).height() / 2
            var canvasX = (x - self.offset().left) / scale
            var canvasY = (y - self.offset().top) / scale
            var screenX = x - self.parent().offset().left
            var screenY = y - self.parent().offset().top

            self.pedalboard('zoom', newScale, canvasX, canvasY, screenX, screenY, 500)
        }
    },

    // Grid mode's zoom: the cells in use, and PLACEMENT_SPARE of a cell to the right and
    // below them, as big as they fit the screen, never past the plugins' own size. The
    // canvas is then the screen at that zoom, so it starts at the cells' origin.
    gridFitScale: function () {
        var self = $(this)
        var plugins = self.data('plugins')
        var cols = 1, rows = 1
        for (var instance in plugins) {
            var cell = plugins[instance].data && plugins[instance].data('gridCell')
            if (cell) {
                cols = Math.max(cols, cell.col + 1)
                rows = Math.max(rows, cell.row + 1)
            }
        }
        var width = self.parent().width()
        var height = self.parent().height() - (self.data('coveredBottom') || 0)
        return Math.min(1, width / ((cols + PLACEMENT_SPARE) * PLACEMENT_CELL.width),
                           height / ((rows + PLACEMENT_SPARE) * PLACEMENT_CELL.height))
    },

    // Enlarge the pedalboard to a minimum size capable of accommodating all plugins.
    adapt: function (forcedUpdate) {
        var self = $(this)
        if (self.pedalboard('gridMode')) {
            // against the last fit, not the current zoom: a finger may have zoomed in
            // the plugin view has a zoom of its own, laid out again for a new screen size
            if (self.data('pluginView')) {
                self.pedalboard('showPlugin', self.data('pluginView').instance, 0)
                return
            }
            var fit = self.pedalboard('gridFitScale')
            if (fit == self.data('gridFit') && ! forcedUpdate) {
                return
            }
            self.data('gridFit', fit)
            self.pedalboard('scaleCanvas', fit, self.data('skipAnimations') || forcedUpdate ? 0 : 400, true)
            return
        }
        // First, get the minmum bounding rectangle,
        // given by minX, maxX, minY and maxY
        var minX, maxX, minY, maxY, padX, padY, w, h, x, y, plugin, pos
        //var pedals = self.find('.js-effect')
        var plugins = self.data('plugins')
        var scale = self.data('scale')
        // Seeded from the size resetSize starts with rather than from the current canvas.
        // Seeding with self.width()/height() made the box the union of canvas-and-plugins,
        // so the canvas could only ever grow - deleting or moving plugins inwards left the
        // vacated space behind forever. The floor already carries the viewport aspect
        // ratio, which is what the ratio lock further down expects.
        // Only the right and bottom are reclaimed this way, and neither moves a plugin.
        // Left and top slack still cannot be given back without shifting every plugin.
        minX = 0
        maxX = self.parent().width() / self.data('baseScale')
        minY = 0
        maxY = self.parent().height() / self.data('baseScale')
        var instance

        // Keep one more plugin's worth of empty canvas past the outermost plugin, so
        // there is always somewhere to drop the next one instead of having to shove one
        // against an edge you cannot see past first. The unit is the biggest plugin
        // currently on the board, so the gap is literally "one more of these fits".
        // 150 is the old fixed margin, kept as the floor and as the empty board case.
        //
        // Right and bottom only. Growing left or up is implemented as a shift of every
        // plugin (the minX/minY branches below), which runs through pluginMove and so
        // rewrites and re-persists every saved position and marks the board modified.
        // Those two sides still grow on demand when a plugin is actually dragged there.
        padX = 150
        padY = 150
        // A plugin still loading is a placeholder holding the position from its add
        // message, with no size yet. It is counted at a typical pedal size, so the board
        // is fitted as soon as the load starts instead of after every GUI has arrived;
        // the fit that ends the load corrects it with real sizes. Right and bottom only:
        // the left/top shift moves drawn plugins, and a placeholder cannot be moved.
        // A fixed guess: 90x155 to 780x480 on a real board; the saved pedal:width
        // and height would be exact for boards that stored them (many store 0).
        var guessW = 350, guessH = 450
        for (instance in plugins) {
            plugin = plugins[instance]
            if (!plugin.position) {
                if (plugin.x !== undefined) {
                    padX = Math.max(padX, guessW)
                    padY = Math.max(padY, guessH)
                }
                continue
            }
            padX = Math.max(padX, plugin.width())
            padY = Math.max(padY, plugin.height())
        }
        for (instance in plugins) {
            plugin = plugins[instance]
            if (!plugin.position) {
                if (plugin.x !== undefined) {
                    maxX = Math.max(maxX, plugin.x + guessW + padX)
                    maxY = Math.max(maxY, plugin.y + guessH + padY)
                }
                continue
            }
            pos = plugin.position()
            w = plugin.width()
            h = plugin.height()
            x = pos.left / scale
            y = pos.top / scale

            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x + w + padX)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y + h + padY)
        }

        // Now calculate how much to increase in width and height,
        // and how much to move in left and top
        var wDif = 0
        var hDif = 0
        var left = 0
        var top = 0
        w = self.width()
        h = self.height()
        if (minX < 0) {
            wDif -= minX
            left -= minX
        }
        if (minY < 0) {
            hDif -= minY
            top -= minY
        }
        // Unconditional, so these can come out negative and give space back. They used to
        // be guarded by maxX > w / maxY > h, which is why the canvas could only grow: once
        // maxX is the floor rather than the current width, the guard is false whenever
        // there is slack to reclaim and adapt fell straight through to its early return.
        // The result is w + wDif == maxX - minX, i.e. exactly the box we want, in either
        // direction. Only the right and bottom move; left and top still need the shift.
        wDif += maxX - w
        hDif += maxY - h

        // Nothing has changed, or only by rounding: the zoomed positions make the target
        // wobble a pixel either way while knob images load, and each fit redraws every
        // cable. Compared against the current canvas, so a real change still lands once
        // it adds up to 2px.
        if (Math.abs(wDif) < 2 && Math.abs(hDif) < 2 && ! forcedUpdate) {
            return
        }

        var scale = self.data('scale')

        // now let's modify desired width and height to keep
        // screen ratio
        var ratio = w / h
        w += wDif
        h += hDif
        if (ratio > w / h) // we have to increase width to keep ratio
            w = ratio * h
        else if (ratio < w / h) // increse height to keep ratio
            h = w / ratio

        var time = (self.data('skipAnimations') || forcedUpdate) ? 0 : 400

        // Move animate everything: move plugins, scale and position
        // canvas

        var drawFactory = function (plugin) {
            return function () {
                self.pedalboard('drawPluginJacks', plugin)
            }
        }

        // move plugins
        for (instance in plugins) {
            plugin = plugins[instance]
            if (!plugin.position) continue
            pos = plugin.position()
            old_x = Math.round(pos.left / scale)
            old_y = Math.round(pos.top / scale)
            x = parseInt(plugin.css('left')) + left
            y = parseInt(plugin.css('top')) + top
            if (old_x == x && old_y == y) {
                continue
            }
            plugin.animate({
                left: x,
                top: y
            }, {
                duration: time,
                step: drawFactory(plugin),
                complete: drawFactory(plugin)
            })
            self.data('pluginMove')(instance, x, y)
        }

        self.pedalboard('scaleCanvas', self.parent().width() / w, time, forcedUpdate)
    },

    // Zooms to `newScale` with the canvas just covering the screen, over `time` ms, and
    // makes it the farthest zoom out.
    scaleCanvas: function (newScale, time, forcedUpdate) {
        var self = $(this)
        var scale = self.data('scale')
        var viewWidth = self.parent().width()
        var viewHeight = self.parent().height()

        self.data('minScale', newScale)

        // if we are at scale 1, it is very much likely that we do not want to zoom out now
        // keep current scale if that is the case
        if (scale == 1 && ! forcedUpdate) {
            var width = viewWidth / newScale
            var height = viewHeight / newScale
            self.width(width)
            self.height(height)
            self.pedalboard('positionHardwarePorts')
            return
        }

        // workaround some browsers that send a zero value at step start, which is an invalid scale
        var usingInitialZero = false
        var oldScale = scale

        self.animate({
            scale: newScale,
        }, {
            duration: time,
            step: function (scale, prop) {
                if (prop.prop != 'scale') {
                    return
                }
                // if we receive a scale of 0, which is impossible for the scale variable, trigger workaround
                if (scale == 0) {
                    usingInitialZero = true
                }
                if (usingInitialZero) {
                    var per = scale / newScale
                    scale = (oldScale * (1.0 - per)) + (newScale * per)
                }

                var width = viewWidth / scale
                var height = viewHeight / scale
                var offsetX = (viewWidth - width) / 2
                var offsetY = (viewHeight - height) / 2
                self.width(width)
                self.height(height)
                self.css({
                    webkitTransform: 'scale(' + scale + ')',
                    MozTransform: 'scale(' + scale + ')',
                    msTransform: 'scale(' + scale + ')',
                    transform: 'scale(' + scale + ')',
                    top: offsetY,
                    left: offsetX,
                })
                self.pedalboard('positionHardwarePorts')
                self.data('scale', scale)
                self.data('offsetX', offsetX)
                self.data('offsetY', offsetY)
            },
        })

    },

    scheduleAdapt: function (forcedUpdate) {
        var self = $(this)

        if (self.data('skipAnimations')) {
            return
        }

        if (forcedUpdate) {
            self.data('adaptForcedUpdate', true)
        }
        if (! self.data('adaptWaitingSince')) {
            self.data('adaptWaitingSince', Date.now())
        }

        // A plain debounce: runs 200ms after the last call. Every plugin that arrives and
        // every knob image that loads calls this, so a load is one burst of calls. This
        // used to add time per call instead, which pushed the first fit (and the loading
        // screen and plugin bar waiting on it) out to its 5s cap on any real pedalboard.
        var callAdaptLater = function () {
            // Not while the board is still arriving: a load in progress, or a plugin whose
            // GUI is not drawn yet (a placeholder without position() until it is). Its
            // size, cables and teleports all come with it. A plugin that never arrives
            // stops holding things up after 10s.
            // Deliberately not document.readyState: it only turns "complete" once every
            // image has loaded, knob images included, which on a device is seconds after
            // the last plugin. The page's CSS is in by the time a load can start anyway.
            var pending = typeof pb_loading !== 'undefined' && pb_loading
            var plugins = self.data('plugins')
            for (var instance in plugins) {
                if (! plugins[instance].position) {
                    pending = true
                    break
                }
            }
            if (pending && Date.now() - self.data('adaptWaitingSince') < 10000) {
                self.data('adaptTimer', setTimeout(callAdaptLater, 200))
                return
            }

            var forcedUpdate = self.data('adaptForcedUpdate')
            self.data('adaptForcedUpdate', false)
            self.data('adaptWaitingSince', 0)
            self.data('adaptTimer', null)
            self.pedalboard('positionHardwarePorts')
            self.data('pedalboardFinishedLoading')(function () {
                self.pedalboard('adapt', forcedUpdate)
                self.data('wait').stopIfNeeded()
                // Only the adapt that ends a LOAD -- scheduleAdapt(true) comes solely
                // from loading_end. Firing on the others would discard the pending map
                // on any quiet moment, mid-load or mid-reroute. The flag is sticky
                // until consumed, so it survives coalescing with the false calls.
                if (forcedUpdate) {
                    self.pedalboard('finishTeleportLoad')
                }
            })
        }

        // The fit that ends a load waits for the board to be complete, not for a quiet
        // moment: on a device knob images keep arriving for seconds after the last plugin,
        // and restarting the timer for each of them held that fit back until the last one.
        if (self.data('adaptForcedUpdate') && self.data('adaptTimer')) {
            return
        }
        clearTimeout(self.data('adaptTimer'))
        self.data('adaptTimer', setTimeout(callAdaptLater, 200))
    },

    // Position the hardware ports as to be evenly distributed vertically in pedalboard.
    // Output ports are positioned at left and input ports at right.
    positionHardwarePorts: function () {
        var self = $(this)

        var height = self.height() - self.data('bottomMargin')

        var adjust = function (elements, css) {
            var top = height / (elements.length + 1)
            var i, el
            elements.sort(function(e1, e2) {
                var e1_audio = e1.hasClass('mod-audio-output') || e1.hasClass('mod-audio-input')
                var e2_audio = e2.hasClass('mod-audio-output') || e2.hasClass('mod-audio-input')
                var e1_midi  = e1.hasClass('mod-midi-output')  || e1.hasClass('mod-midi-input')
                var e2_midi  = e2.hasClass('mod-midi-output')  || e2.hasClass('mod-midi-input')
                var e1_cv    = e1.hasClass('mod-cv-output')    || e1.hasClass('mod-cv-input')
                var e2_cv    = e2.hasClass('mod-cv-output')    || e2.hasClass('mod-cv-input')
                // FIXME - there's got to be a better way..
                if ((e1_audio && e2_audio) || (e1_midi && e2_midi) || (e1_cv && e2_cv)) {
                    return (parseInt(e1.attr('mod-port-index')) > parseInt(e2.attr('mod-port-index'))) ? 1 : -1;
                } else if (e1_cv || e2_cv) {
                    return e1_cv ? 1 : -1;
                } else {
                    return e1_midi ? 1 : -1;
                }
            })
            for (i = 0; i < elements.length; i++) {
                el = elements[i]
                el.css($.extend(css, {
                    top: top * (i + 1) - el.height() / 2
                }))
            }
        }

        adjust(self.data('hwInputs'), {
            right: 0
        })
        adjust(self.data('hwOutputs'), {
            left: 0
        })

        // Redraw all cables that connect to or from hardware ports
        //self.data('connectionManager').iterateInstance(':system:', function (jack) {
        self.data('connectionManager').iterate(function (jack) {
            self.pedalboard('drawJack', jack)
        })
    },

    // Resets the pedalboard size and zoom to initial configuration
    resetSize: function () {
        var self = $(this)
        var scale = self.data('baseScale')
        var w = self.parent().width() / scale
        var h = self.parent().height() / scale
        self.css({
            width: w,
            height: h,
            position: 'absolute'
        })

        self.data('minScale', scale)

        self.pedalboard('zoomAt', scale, w / 2, h / 2, 0)
        self.data('windowSize')(self.width(), self.height())

        self.pedalboard('positionHardwarePorts')
    },

    /*********
     * Plugins
     */

    // Generate an instance for a new plugin.
    // TODO: check with ingen if instance does not exist
    generateInstance: function (uri) {
        var self = $(this)
        // copied from ingen's algorithm to get a valid instance symbol
        var last_uri_delim = function (s) {
            for (var i = s.length-1; i > 0; --i) {
                switch(s[i]) {
                    case '/': case '?': case '#': case ':':
                        return i
                }
            }
            return -1
        }
        var re = /[^_a-zA-Z0-9]+/g
        var instance = uri
        var last_delim = last_uri_delim(instance)
        while (last_delim != -1 &&
                !instance.substr(last_delim, instance.length-1).match(/[a-zA-Z0-9]/)) {
            instance = instance.substr(0, last_delim)
            last_delim = last_uri_delim(instance)
        }
        instance = instance.substr(last_delim+1, instance.length-1).replace(re, "_")
        if (instance[0].match(/[0-9]/)) // instance names cant start with numbers
            instance = "_" + instance
        var i = 1;
        instance = '/graph/' + instance
        // the prefix "/graph/cv_" is reserved, make sure we dont use it
        if (instance === '/graph/cv') {
            instance = instance + 'x'
        }
        if (instance in self.data('plugins')) {
            instance = instance + "_1"
            while (instance in self.data('plugins')) {
                i = i + 1
                instance = instance.slice(0, -1) + i
            }
        }
        return instance
    },

    // Adds a plugin to pedalboard. This is called after the application loads the plugin with the
    // instance, now we need to put it in screen.
    addPlugin: function (pluginData, instance, label, bypassed, x, y, guiOptions, renderCallback, skipModified) {
        var self = $(this)
        var scale = self.data('scale')

        var obj = {}
        var options = $.extend({
            dragStart: function () {
                // the viewed plugin stays where it is, its controls get the finger
                if (self.data('pluginView')) {
                    return false
                }
                self.trigger('pluginDragStart', instance)
                obj.icon.addClass('dragging')
                obj.icon.css({'z-index': self.data('z_index')+1})
                self.data('z_index', self.data('z_index')+1)
                // in grid mode a plugin moves alone, a group would need a free cell each
                if (! self.pedalboard('gridMode')) {
                    self.pedalboard('startGroupDrag', instance)
                }
                return true
            },
            drag: function (e, ui) {
                self.trigger('pluginDrag', instance)
                var scale = self.data('scale')
                ui.position.left /= scale
                ui.position.top /= scale
                if (self.pedalboard('gridMode')) {
                    obj.icon.css({ left: ui.position.left, top: ui.position.top })
                    self.pedalboard('gridDrag', instance, obj.icon)
                } else {
                    self.pedalboard('dragGroupTo', ui.position.left, ui.position.top)
                }
                self.trigger('modified')
                self.pedalboard('drawPluginJacks', obj.icon)
            },
            dragStop: function (e, ui) {
                self.trigger('pluginDragStop')
                self.trigger('modified')
                obj.icon.removeClass('dragging')
                if (self.pedalboard('gridMode')) {
                    self.pedalboard('gridDrop', instance, obj.icon)
                    self.pedalboard('adapt', false)
                    return
                }
                self.pedalboard('drawPluginJacks', obj.icon)
                self.data('pluginMove')(instance, ui.position.left, ui.position.top)
                self.pedalboard('finishGroupDrag')
                self.pedalboard('adapt', false)
            },
            click: function (event) {
                // a cable being made by taps goes into the plugin tapped anywhere but on
                // a port, which has its own tap, see connectToPlugin
                var connection = self.data('ongoingConnection')
                if (connection && ! $(event.target).closest('[mod-port]').length) {
                    self.pedalboard('connectToPlugin', connection.jack, instance)
                    return
                }
                // in grid mode, a tap on its background on the side of its outputs or its
                // inputs is for them, see cellTap, and further in shows just the plugin
                if (! connection && self.pedalboard('gridMode') && ! self.data('pluginView') &&
                    $(event.target).hasClass('mod-drag-handle')) {
                    var zone = self.pedalboard('cellZone', event)
                    if (zone && zone.side != 'plugin' && self.pedalboard('cellTap', event, null)) {
                        return
                    }
                }
                if (event.shiftKey) {
                    // A port has its own shift-click, which toggles its vu meter, and the
                    // ports sit inside the plugin, so the click reaches here too on its
                    // way up. Selecting is for the plugin's own body only. closest()
                    // rather than is(), because the click can land on a jack or on some
                    // other decoration inside the port.
                    if ($(event.target).closest('[mod-port]').length) {
                        return
                    }
                    self.pedalboard('toggleSelected', instance)
                    return
                }
                obj.icon.css({'z-index': self.data('z_index')+1})
                self.pedalboard('drawPluginJacks', obj.icon)
                self.data('z_index', self.data('z_index')+1)

                // only zoom-in if event was triggered by a click on the drag-handle
                // this prevents zoom-in when dragging a control and releasing the mouse over an empty area of the plugin
                if (! $(event.target).hasClass("mod-drag-handle"))
                    return;

                // setTimeout avoids cable drawing bug
                setTimeout(function () {
                    if (! self.pedalboard('gridMode')) {
                        self.pedalboard('focusPlugin', obj.icon)
                    } else if (! self.data('pluginView')) {
                        self.pedalboard('showPlugin', instance)
                    }
                }, 0)
            },
            change: function (port, value) {
                self.data('pluginParameterChange')(port, value)
            },
            patchGet: function (uri) {
                self.data('pluginPatchGet')(instance, uri)
            },
            patchSet: function (uri, valuetype, value) {
                self.data('pluginPatchSet')(instance, uri, valuetype, value)
            },
            presetLoad: function (uri) {
                self.data('pluginPresetLoad')(instance, uri, function (ok) {
                        if (ok) {
                            // TODO Handle this error
                        }
                    })
            },
            presetSaveNew: function (name, callback) {
                self.data('pluginPresetSaveNew')(instance, name, function (resp) {
                        if (resp.ok) {
                            callback(resp)
                        }
                    })
            },
            presetSaveReplace: function (uri, bundlepath, name, callback) {
                self.data('pluginPresetSaveReplace')(instance, uri, bundlepath, name, function (resp) {
                        if (resp.ok) {
                            callback(resp)
                        }
                    })
            },
            presetDelete: function (uri, bundlepath, callback) {
                self.data('pluginPresetDelete')(instance, uri, bundlepath, function (ok) {
                        if (ok) {
                            callback()
                        }
                    })
            },
            compareSnapshotSwitch: self.data('compareSnapshotSwitch'),
            compareSnapshotTake: self.data('compareSnapshotTake'),
            changePortMonitoring: self.data('changePortMonitoring'),
            isPortMonitored: self.data('isPortMonitored'),
            bypassed: bypassed ? 1 : 0,
            defaultIconTemplate: DEFAULT_ICON_TEMPLATE,
            defaultSettingsTemplate: DEFAULT_SETTINGS_TEMPLATE
        }, guiOptions)

        /* FIXME this is not used anywhere. remove?
        var preset_list = []
        for (var key in pluginData['presets']) {
            preset_list.push({
                label: pluginData['presets'][key]['label'],
                uri: pluginData['presets'][key]['uri']
            })
        }
        pluginData = $.extend({
            preset_list: preset_list
        }, pluginData)
        */
        var pluginGui = new GUI(pluginData, options)

        pluginGui.label = label
        pluginGui.render(instance, function (icon, settings) {
            obj.icon = icon
            icon.attr('mod-uri', escape(pluginData.uri));

            if (pluginData.licensed < 0) {
                // This is a TRIAL plugin
                icon.find('[mod-role="drag-handle"]').addClass('demo-plugin').addClass('demo-plugin-light');
                self.data('notifyDemoPluginLoaded')()
            }

            self.data('plugins')[instance] = icon

            if (! skipModified) {
                self.trigger('modified')
            }

            icon.data('uri', pluginData.uri)
            icon.data('ports', pluginData.ports)
            icon.data('gui', pluginGui)
            icon.data('settings', settings)
            icon.data('instance', instance)

            var address, symbol, port
            /*
            var hardware = self.data('hardwareManager')
            hardware.instanceAdded(instance)
            */

            var addressFactory = function (port) {
                return function () {
                    if ($(this).hasClass("disabled")) {
                        return
                    }
                    var hardware = self.data('hardwareManager')
                    hardware.open(instance, port, pluginData.label)
                }
            }

            for (symbol in pluginGui.controls) {
                port = pluginGui.controls[symbol]
                if (symbol == ':bypass') {
                    if (pluginData.bypassable === false) {
                        // host-implemented plugin without a bypass: no switch and no addressing for it
                        settings.find('.mod-switch.bypass').hide()
                        continue
                    }
                    address = settings.find('[mod-role=bypass-address]')
                } else if (symbol == ':presets') {
                    address = settings.find('[mod-role=presets-address]')
                } else {
                    address = settings.find('[mod-role=input-control-address][mod-port-symbol=' + symbol + ']')
                }
                if (address.length == 0) {
                    continue
                }
                address.click(addressFactory(port))
            }

            // Find elements with mod-role of audio/midi input/output ports and assign functionality to them
            var types = ['audio', 'midi', 'cv']
            var directions = ['input', 'output']
            var j, k, type, direction, method, element
            for (i = 0; i < types.length; i++) {
                type = types[i]
                for (j = 0; j < directions.length; j++) {
                    direction = directions[j]
                    if (!pluginData.ports[type] || !pluginData.ports[type][direction])
                        continue
                    for (k = 0; k < pluginData.ports[type][direction].length; k++) {
                        symbol = pluginData.ports[type][direction][k].symbol
                        element = icon.find('[mod-role=' + direction + '-' + type + '-port][mod-port-symbol=' + symbol + ']')
                        if (element.length == 0)
                            continue
                        // call either makeInput or makeOutput
                        var method = 'make' + direction.charAt(0).toUpperCase() + direction.slice(1)
                        self.pedalboard(method, element, instance)
                    }
                }
            }

            icon.mousedown(function () {
                self.pedalboard('preventDrag', true)
                var upHandler = function () {
                    self.pedalboard('preventDrag', false)
                    $('body').unbind('mouseup', upHandler)
                }
                $('body').bind('mouseup', upHandler)
            })

            icon.attr('mod-io-type', pluginData.iotype)

            // a plugin of the same kind takes its place, a mono effect a stereo one's too
            // and the other way round, see replacementFor
            var accepted = pluginData.iotype == 1 || pluginData.iotype == 2 ? [1, 2] : [pluginData.iotype]
            icon.droppable({
                accept: $.map(accepted, function (iotype) {
                    return '[mod-role=available-plugin][mod-io-type="' + iotype + '"]'
                }).join(','),
                tolerance: 'custom-replace',
                activeClass: 'possible-replaceable-drop',
                drop: function (event, ui) {
                    // icon.removeClass('replaceable-drop')
                    var overIcons = ui.helper.data('overIcons');
                    if (overIcons.length === 0 || overIcons[overIcons.length-1] != icon) {
                        return;
                    }
                    ui.helper.data('overIcons', []);

                    var instance = event.target.getAttribute('mod-instance')
                    var replacement = self.pedalboard('replacementFor', instance)
                    self.data('replacementPlugin', replacement)
                    self.pedalboard('removePlugin', instance, pluginData.ports)
                },
                over: function (event, ui) {
                    var overIcons = ui.helper.data('overIcons');
                    if (overIcons.length !== 0) {
                        var oldIcon = overIcons[overIcons.length-1]
                        oldIcon.removeClass('replaceable-drop')
                        oldIcon.find('[mod-role="drag-handle"]').removeClass('replaceable-drop')
                    }
                    icon.addClass('replaceable-drop')
                    icon.find('[mod-role="drag-handle"]').addClass('replaceable-drop')
                    overIcons.push(icon)
                },
                out: function (event, ui) {
                    var overIcons = ui.helper.data('overIcons');
                    remove_from_array(overIcons, icon)
                    if (icon.hasClass('replaceable-drop')) {
                        icon.removeClass('replaceable-drop')
                        icon.find('[mod-role="drag-handle"]').removeClass('replaceable-drop')
                        if (overIcons.length !== 0) {
                            var oldIcon = overIcons[overIcons.length-1]
                            oldIcon.addClass('replaceable-drop')
                            oldIcon.find('[mod-role="drag-handle"]').removeClass('replaceable-drop')
                        }
                    }
                },
            })

            // appenda standard UI icons like info, delete to plugin gui on the constructor
            var actions = $('<div>').data('helpId', 'pedalboard-effect-actions').addClass('ignore-arrive').addClass('mod-actions').appendTo(icon)
            if (pluginData.hasExternalUI) {
                $('<div>').addClass('mod-external-ui').click(function () {
                    self.pedalboard('finishConnection')
                    self.data('showExternalUI')(instance)
                    return false
                }).appendTo(actions)
            }
            $('<div>').addClass('mod-snapshotable-status plugin-global-snapshot').click(function () {
                self.pedalboard('finishConnection')
                return false
            }).appendTo(actions)
            $('<div>').addClass('mod-information').click(function () {
                self.pedalboard('finishConnection')
                self.data('showPluginInfo')(pluginData)
                return false
            }).appendTo(actions)
            $('<div>').addClass('mod-settings').click(function () {
                self.pedalboard('finishConnection')
                settings.window('open')
                return false
            }).appendTo(actions)
            $('<div>').addClass('mod-remove').click(function () {
                self.pedalboard('finishConnection')
                self.pedalboard('removePlugin', instance, pluginData.ports)
                return false
            }).appendTo(actions)

            settings.window({
                windowName: "Plugin Settings",
                windowManager: self.data('windowManager'),
                open: function() {
                    self.data('pluginSettingsWindowOpen')(pluginGui)
                },
                close: function() {
                    self.data('pluginSettingsWindowClose')(pluginGui)
                }
            }).appendTo($('body'))
            icon.css({
                'z-index': self.data('z_index'),
                position: 'absolute',
                left: x,
                top: y
            }).appendTo(self)

            // a plugin added into a cell went in at the cell's corner, its size unknown
            // until now
            var cell = self.data('pendingPlacements')[instance]
            var wiring = self.data('pendingWirings')[instance]
            delete self.data('pendingPlacements')[instance]
            delete self.data('pendingWirings')[instance]
            if (self.pedalboard('gridMode')) {
                self.pedalboard('snapPlugin', instance, icon, cell)
                // and cabled, when the user just put it there
                if (cell) {
                    self.pedalboard('wirePlugin', instance, cell, wiring)
                }
            }

            // adjust position of cv out checkboxes if needed
            var lastCvPosY = -1, lastCvElem
            for (k = 0; k < pluginData.ports['cv']['output'].length; k++) {
                symbol = pluginData.ports['cv']['output'][k].symbol
                element = icon.find('[mod-role=' + direction + '-' + type + '-port][mod-port-symbol=' + symbol + ']')
                if (element.length == 0)
                    continue
                var curCvPosY = element.position().top
                if (lastCvPosY != -1 && Math.abs(curCvPosY - lastCvPosY) < 50) {
                    element.find('.output-cv-checkbox').css({left:'50px',top:'10px'})
                    lastCvElem.find('.output-cv-checkbox').css({left:'50px',top:'10px'})
                }
                lastCvElem = element
                lastCvPosY = curCvPosY
            }

            self.data('z_index', self.data('z_index')+1)
            if (renderCallback)
                renderCallback()
        })

        var replacementPlugin = self.data('replacementPlugin')
        self.data('replacementPlugin', null)

        if (replacementPlugin) {
            var counts = replacementPlugin.counts
            // its own ports for one of the replaced plugin's, see replacementFor: the
            // same one, or where it has more or fewer of them, from mono to stereo and
            // back, the last of the fewer stands for all the extra ones of the others
            var ownPorts = function (end, dir) {
                if (typeof end === 'string') {
                    return [end]
                }
                var list = (pluginData.ports[end.type] && pluginData.ports[end.type][dir]) || []
                var count = counts[end.type][dir]
                return $.map(list, function (port, k) {
                    return Math.min(k, count - 1) == end.index || Math.min(end.index, list.length - 1) == k
                         ? instance + '/' + port.symbol : null
                })
            }
            // The cables of each of its ports to each other plugin, together: the new
            // plugin's ports for that one are paired with the other's they went to, in
            // order, so a mono one's two cables into a stereo plugin come from the
            // left and the right of a stereo one taking its place, not both from each.
            // The last of the fewer on either side takes all the extra ones
            var cables = [], seen = {}
            var connect = function (from, to, teleport) {
                // two cables of a stereo one into the same port of the mono one's are
                // one, when they came from the same port
                if (! seen[from + ' ' + to]) {
                    seen[from + ' ' + to] = true
                    cables.push([from, to, teleport || null])
                }
            }
            var groups = {}, order = []
            $.each(replacementPlugin.cables, function (i, cable) {
                // from it to itself
                if (typeof cable[0] !== 'string' && typeof cable[1] !== 'string') {
                    $.each(ownPorts(cable[0], 'output'), function (j, from) {
                        $.each(ownPorts(cable[1], 'input'), function (k, to) {
                            connect(from, to)
                        })
                    })
                    return
                }
                var out = typeof cable[0] !== 'string'
                var own = out ? cable[0] : cable[1]
                var other = out ? cable[1] : cable[0]
                var key = out + ' ' + own.type + ' ' + own.index + ' ' + other.substring(0, other.lastIndexOf('/'))
                if (! groups[key]) {
                    groups[key] = { out: out, own: own, others: [], teleports: {} }
                    order.push(key)
                }
                groups[key].others.push(other)
                groups[key].teleports[other] = cable[2]
            })
            $.each(order, function (i, key) {
                var group = groups[key]
                var mine = ownPorts(group.own, group.out ? 'output' : 'input')
                // theirs in their plugin's order, the board's by name
                var at = group.others[0].substring(0, group.others[0].lastIndexOf('/'))
                var listed = self.pedalboard('wirePorts', at, group.own.type)
                listed = group.out ? listed.input : listed.output
                var others = group.others.sort(function (a, b) {
                    return listed.indexOf(a) >= 0 && listed.indexOf(b) >= 0
                         ? listed.indexOf(a) - listed.indexOf(b) : (a < b ? -1 : 1)
                })
                for (var j = 0; j < Math.max(mine.length, others.length); j++) {
                    var port = mine[Math.min(j, mine.length - 1)]
                    var other = others[Math.min(j, others.length - 1)]
                    if (port !== undefined) {
                        if (group.out) {
                            connect(port, other, group.teleports[other])
                        } else {
                            connect(other, port, group.teleports[other])
                        }
                    }
                }
            })

            var hasConnectionsErrors = 0,
                connectionsDone = 0,
                connectionsToDo = cables.length;

            function finalizeConnection(ok) {
                hasConnectionsErrors |= !ok;

                if (++connectionsDone == connectionsToDo && hasConnectionsErrors) {
                    new Notification('error', "Failed to automatically reconnect all ports", 5000)
                }
            }

            $.each(cables, function (i, cable) {
                var teleportKey = self.pedalboard('restoreReplacedTeleport', cable[2], cable[0], cable[1])
                self.data('portConnect')(cable[0], cable[1], self.pedalboard('replacedConnectionDone', teleportKey, finalizeConnection))
            })
        }
    },

    // What the plugin taking the place of `instance` is to get back of its cables, see
    // addPlugin: each as [from, to, teleport], where an end on `instance` itself is
    // {type, index}, the index of the port among its own ports of that kind, ins or
    // outs, and how many of those it has, so the new plugin's can be matched to them
    // even when it has more or fewer. Taken before `instance` is removed, which takes
    // the cables away
    replacementFor: function (instance) {
        var self = $(this)
        var ports = self.data('plugins')[instance].data('ports')
        var replacement = { instance: instance, counts: {}, cables: [] }
        $.each(['audio', 'midi', 'cv'], function (i, type) {
            replacement.counts[type] = {
                input: ((ports[type] && ports[type].input) || []).length,
                output: ((ports[type] && ports[type].output) || []).length
            }
        })
        var end = function (element, dir) {
            var port = element.attr('mod-port')
            if (! startsWith(port, instance + '/')) {
                return port
            }
            var symbol = port.slice(instance.length + 1)
            var type = (element.attr('mod-role') || '').split('-')[1]
            var list = (ports[type] && ports[type][dir]) || []
            for (var i = 0; i < list.length; i++) {
                if (list[i].symbol == symbol) {
                    return { type: type, index: i }
                }
            }
            return null
        }
        self.data('connectionManager').iterateInstance(instance, function (jack) {
            var output = jack.data('origin')
            var from = end(output, 'output')
            var to = end(jack.data('destination'), 'input')
            if (! from || ! to) {
                return
            }
            // Captured here because this is the last moment it exists: removing the
            // plugin destroys these jacks, and the lifetime rule then drops the name.
            // addPlugin puts both back when it recreates the cable.
            var teleport = jack.data('teleported') ? self.pedalboard('teleportName', output) : null
            replacement.cables.push([from, to, teleport])
        })
        return replacement
    },

    // Whether the plugin `pluginData` describes, its ports listed, can take the place of
    // `instance` and its cables, see replacementFor: with audio and MIDI ins and outs
    // where it has them, and only there, however many, a mono plugin for a stereo one
    // too. CV where it has cables on it.
    replaceable: function (instance, pluginData) {
        var self = $(this)
        var plugin = self.data('plugins')[instance]
        var ports = plugin && plugin.data && plugin.data('ports')
        if (! ports || ! pluginData.ports) {
            return false
        }
        var connMgr = self.data('connectionManager')
        var list = function (ports, type, dir) {
            return (ports[type] && ports[type][dir]) || []
        }
        var types = ['audio', 'midi', 'cv'], dirs = ['input', 'output']
        for (var i = 0; i < types.length; i++) {
            for (var j = 0; j < dirs.length; j++) {
                var own = list(ports, types[i], dirs[j])
                var theirs = list(pluginData.ports, types[i], dirs[j])
                if (types[i] != 'cv') {
                    if (! own.length != ! theirs.length) {
                        return false
                    }
                    continue
                }
                if (theirs.length) {
                    continue
                }
                var index = dirs[j] == 'input' ? connMgr.destIndex : connMgr.origIndex
                for (var k = 0; k < own.length; k++) {
                    if (Object.keys(index[instance + '/' + own[k].symbol] || {}).length) {
                        return false
                    }
                }
            }
        }
        return true
    },

    // Remove "Trial" watermark from all instances of a plugin
    license: function(uri) {
        var self = $(this);
        var plugins = self.data('plugins');

        var icon;
        for (var instance in plugins) {
            icon = plugins[instance]
            if (icon && icon.data && icon.data('uri') == uri) {
                icon.find('[mod-role="drag-handle"]').removeClass('demo-plugin').removeClass('demo-plugin-light');
            }
        }
    },

    getLabel: function (instance) {
        var plugin = $(this).data('plugins')[instance]
        if (plugin && plugin.data) {
            return plugin.data('label')
        }
        return "effect"
    },

    getGui: function (instance) {
        var plugin = $(this).data('plugins')[instance]
        if (plugin && plugin.data) {
            return plugin.data('gui')
        }
        return null
    },

    getLoadedPluginURIs: function () {
        var plugin, plugins = $(this).data('plugins')
        var uri, uris = {}

        for (var i in plugins) {
            plugin = plugins[i]
            if (plugin != null && plugin.data != null) {
                uri = plugin.data('uri')
                if (uri != null) {
                    uris[uri] = true
                }
            }
        }

        return Object.keys(uris)
    },

    setPortEnabled: function (instance, symbol, enabled, feedback, forceAddress, momentaryMode) {
        var self = $(this)
        var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
        var callbackId = instance+'/'+symbol+":enabled"
        var gui = self.pedalboard('getGui', instance)

        if (gui && self.find(targetname).length) {
            if (enabled || feedback) {
                gui.enable(symbol)
            } else {
                gui.disable(symbol)
            }
            if (forceAddress) {
              gui.addressPort(symbol, feedback, momentaryMode)
            }

        } else {
            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                if (enabled || feedback) {
                    gui.enable(symbol)
                } else {
                    gui.disable(symbol)
                }

                if (forceAddress) {
                  gui.addressPort(symbol, feedback, momentaryMode)
                }
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    setPortWidgetsValue: function (instance, symbol, value) {
        var self = $(this)
        var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
        var callbackId = instance+'/'+symbol+":value"
        var gui = self.pedalboard('getGui', instance)

        if (gui && self.find(targetname).length) {
            gui.setPortWidgetsValue(symbol, value, null, true)

        } else {
            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.setPortWidgetsValue(symbol, value, null, true)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    /*
     * Properties are special values of a port tied with the pedalboard
     * set port property of a port
     */
    setPortPropertyValue: function (instance, symbol, property, value) {
        var self = $(this)
        var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
        var callbackId = instance+'/'+symbol+":property:"+property
        var gui = self.pedalboard('getGui', instance)

        if (gui && self.find(targetname).length) {
            gui.setPortPropertyValue(symbol, property, value)
        } else {
            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.setPortPropertyValue(symbol, property, value)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    /*
     * Properties are special values of a parameter tied with the pedalboard
     * set parameter property of a parameter
     */
    setParameterPropertyValue: function (instance, uri, property, value) {
        var self = $(this)
        var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
        var callbackId = instance+'/'+uri+":property:"+property
        var gui = self.pedalboard('getGui', instance)

        if (gui && self.find(targetname).length) {
            gui.setParameterPropertyValue(uri, property, value)
        } else {
            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.setParameterPropertyValue(uri, property, value)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    setOutputPortValue: function (instance, symbol, value) {
        var self = $(this)
        var gui = self.pedalboard('getGui', instance)

        if (gui) {
            gui.setOutputPortValue(symbol, value)

        } else {
            var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
            var callbackId = instance+'/'+symbol+":value"

            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.setOutputPortValue(symbol, value)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    setReadableParameterValue: function (instance, uri, valuetype, valuedata) {
        var self = $(this)
        var gui = self.pedalboard('getGui', instance)

        if (gui) {
            gui.setReadableParameterValue(uri, valuetype, valuedata)

        } else {
            var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
            var callbackId = instance+'@'+uri+'@value'

            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.setReadableParameterValue(uri, valuetype, valuedata)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    setWritableParameterValue: function (instance, uri, valuetype, valuedata) {
        var self = $(this)
        var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
        var callbackId = instance+'@'+uri+'@value'
        var gui = self.pedalboard('getGui', instance)

        if (gui && self.find(targetname).length) {
            gui.setWritableParameterValue(uri, valuetype, valuedata, null, true)

        } else {
            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.setWritableParameterValue(uri, valuetype, valuedata, null, true)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    selectPreset: function (instance, value) {
        var self = $(this)
        var gui = self.pedalboard('getGui', instance)

        if (gui) {
            gui.selectPreset(value)

        } else {
            var targetname = '.mod-pedal[mod-instance="'+instance+'"]'
            var callbackId = instance+'/'+":presets"

            var cb = function () {
                delete self.data('callbacksToArrive')[callbackId]
                self.unbindArrive(targetname, cb)

                var gui = self.pedalboard('getGui', instance)
                gui.selectPreset(value)
            }

            self.pedalboard('addUniqueCallbackToArrive', cb, targetname, callbackId)
        }
    },

    addUniqueCallbackToArrive: function (cb, targetname, callbackId) {
        var self = $(this);
        var callbacks = self.data('callbacksToArrive'),
            currentCallback = callbacks[callbackId];

        if (currentCallback) {
            self.unbindArrive(targetname, currentCallback)
        }

        callbacks[callbackId] = cb
        self.arrive(targetname, cb)
    },

    // Redraw all connections from or to a plugin
    drawPluginJacks: function (plugin) {
        var self = $(this)
        var myjacks = []
        var connMgr = self.data('connectionManager')
        connMgr.iterateInstance(plugin.data('instance'), function (jack) {
            myjacks.push($(jack.data('svg')._container))
        })
        $('.hasSVG.cable-connected').filter(function(e) {!(e in myjacks)}).css({'z-index': 0})

        // over the other plugins, unless the board shows just one: then under the
        // backdrop that hides the rest of it, see showPlugin
        var z = self.data('pluginView') ? 0 : self.data("z_index")-1
        connMgr.iterateInstance(plugin.data('instance'), function (jack) {
            self.pedalboard('drawJack', jack)
            $(jack.data('svg')._container).css({ 'z-index': z, 'pointer-events': 'none'})
        })
    },

    // Removes a plugin from pedalboard. (from the system?)
    // Calls application removal function with proper removal callback
    removePlugin: function (instance, ports, done) {
        var self = $(this)
        var pluginRemove = self.data('pluginRemove')
        // In grid mode the cables through it are joined up again, once it is gone. Not
        // when another plugin is taking its place, which gets its cables instead
        var bridges = self.pedalboard('gridMode') && ! self.data('replacementPlugin')
                    ? self.pedalboard('bridgeCables', instance) : []
        pluginRemove(instance, function () {
          $.each(bridges, function (i, bridge) {
            self.pedalboard('wireConnect', bridge[0], bridge[1])
          })
          if (done) {
            done()
          }
          // Remove plugin's cv output ports from harware manager
          if (ports && ports.cv && ports.cv.output) {
            for (var i = 0; i < ports.cv.output.length; i++) {
              self.data('hardwareManager').removeCvOutputPort('/cv' + instance + '/' + ports.cv.output[i].symbol)
            }
          }
        })
    },

    removeItemFromCanvas: function (instance) {
        var self = $(this)
        var plugins = self.data('plugins')
        var connMgr = self.data('connectionManager')

        if (instance in plugins) {
            connMgr.iterateInstance(instance, function (jack) {
                var input = jack.data('destination')
                jack.data('canvas').remove()
                jack.remove()
                self.pedalboard('packJacks', input)
            })
            connMgr.removeInstance(instance)

            self.data('hardwareManager').removeInstance(instance)

            var plugin = plugins[instance]
            // plugin might have failed to register
            if (plugin && plugin.data) {
                var pluginGui = plugin.data('gui')
                pluginGui && pluginGui.triggerJS({ type: 'end' })
            }
            if (plugin && plugin.length) {
                plugin.remove()
            }

            delete plugins[instance]
            delete self.data('selected')[instance]

            var view = self.data('pluginView')
            if (view && view.instance == instance) {
                self.pedalboard('leavePluginView')
            } else if (view) {
                self.pedalboard('fillPluginView')
            }

            // nothing else asks the canvas to reconsider its size after a removal, and
            // scheduleAdapt debounces, so deleting several plugins recalculates once
            self.pedalboard('scheduleAdapt', false)
        } else {
            connMgr.iterate(function (jack) {
                var input   = jack.data('destination')
                var inport  = input.attr('mod-port')
                var output  = jack.data('origin')
                var outport = output.attr('mod-port')

                if (inport != instance && outport != instance)
                    return

                connMgr.disconnect(outport, inport)
                jack.data('canvas').remove()
                jack.remove()
                self.pedalboard('packJacks', input)

                if (!connMgr.origIndex[outport] || Object.keys(connMgr.origIndex[outport]).length == 0) {
                    output.addClass('output-disconnected')
                    output.removeClass('output-connected')
                }
            })

            var inputs  = self.data('hwInputs')
            var outputs = self.data('hwOutputs')

            var hwsToRemove = []
            inputs.forEach(function (hw) {
                if (hw.attr("mod-port-symbol") == instance) {
                    hwsToRemove.push(hw)
                }
            })
            for (var i in hwsToRemove) {
                hwsToRemove[i].remove()
                remove_from_array(inputs, hwsToRemove[i])
            }

            hwsToRemove = []
            outputs.forEach(function (hw) {
                if (hw.attr("mod-port-symbol") == instance) {
                    hwsToRemove.push(hw)
                }
            })
            for (var i in hwsToRemove) {
                hwsToRemove[i].remove()
                remove_from_array(outputs, hwsToRemove[i])
            }

            self.pedalboard('positionHardwarePorts')
        }

        // Both branches above remove jacks with a bare jack.remove(), so nothing here
        // reaches teleportsChanged on its own. [] because the jacks are already gone: this
        // only re-derives which names are still spoken for.
        self.pedalboard('teleportsChanged', [])
    },

    // Highlight all inputs to which a jack can be connected (any inputs that are not from same
    // instance and are not already connected). Highlight parameter indicates if we want highlighting
    // on or off. If highlight parameter is false, no jack is needed.
    highlightInputs: function (highlight, jack) {
        var self = $(this)
        var connMgr = self.data('connectionManager')
        if (!highlight) {
            self.find('[mod-role=input-audio-port]').removeClass('input-connecting')
            self.find('[mod-role=input-midi-port]').removeClass('input-connecting')
            self.find('[mod-role=input-cv-port]').removeClass('input-connecting')
            self.find('[mod-role=input-audio-port]').removeClass('input-connecting-highlight')
            self.find('[mod-role=input-midi-port]').removeClass('input-connecting-highlight')
            self.find('[mod-role=input-cv-port]').removeClass('input-connecting-highlight')
            return
        }

        var output = jack.data('origin')
        var fromPort = output.attr('mod-port')
        var portType = output.data('portType')

        self.find('[mod-role=input-' + portType + '-port]').each(function () {
            $(this).addClass('input-connecting')
        });
    },

    // Removes all plugins and restore pedalboard initial state, so that a new pedalboard
    // can be created
    reset: function (callback) {
        var self = $(this)

        self.data('bypassApplication', false)
        self.data('callbacksToArrive', {})

        // Its own teardown window, around this loop only. It must not span the async
        // callback below -- resetData opens its own in there, and a flag left raised
        // across the gap would swallow real edits if that callback never fires.
        var connMgr = self.data('connectionManager')
        self.data('teleportsTeardown', true)
        try {
            connMgr.iterate(function (jack) {
                self.pedalboard('disconnect', jack)
            })
        } finally {
            // a throw in here must not leave the flag raised: it would silently swallow
            // every teleport POST for the rest of the session
            self.data('teleportsTeardown', false)
        }

        self.data('reset')(function (ok) {
            if (!ok) {
                return
            }
            self.pedalboard('resetData')
            if (callback) {
                callback()
            }
        })
    },

    // Removes all pedalboard data
    resetData: function () {
        var self = $(this)

        // destroyJack runs per jack and each call POSTs, which would race the next
        // board's load. The in-memory prune still runs; only the network call waits.
        self.data('teleportsTeardown', true)
        try {
            // Nothing re-seeds these on a blank board: applyTeleports only runs when a
            // bundle is loaded, so a key parked by the previous board would survive. Port
            // ids are identical across boards, so wiring capture_1 -> playback_1 on the
            // new one would silently come up teleported under the old board's name.
            self.data('pendingTeleports', {})
            self.data('teleportNames', {})
            self.data('teleportNamesRemembered', {})
            // teleportGen is deliberately NOT cleared: it is the server's, and resetData
            // runs twice per reset with the server's message landing between the two.

            self.data('hardwareManager').reset()

            var connMgr = self.data('connectionManager')

            connMgr.iterate(function(jack) {
                self.pedalboard('destroyJack', jack);
            })

            connMgr.reset()

            var plugins = self.data('plugins')
            for (var instance in plugins) {
                var plugin = plugins[instance]

                // plugin might have failed to register
                if (plugin && plugin.data) {
                    var pluginGui = plugin.data('gui')
                    pluginGui && pluginGui.triggerJS({ type: 'end' })
                }
                if (plugin && plugin.length) {
                    plugin.remove()
                }
            }
            self.data('plugins', {})

            self.pedalboard('resetSize')
        } finally {
            // a throw anywhere above must not leave the flag raised: it would silently
            // swallow every teleport POST for the rest of the session
            self.data('teleportsTeardown', false)
        }
    },

    // Make element an audio/midi inputs, to which jacks can be dragged to make connections
    makeInput: function (element, instance) {
        var self = $(this)
        var symbol = element.attr('mod-port-symbol')
        var portType = element.attr('mod-role').split(/-/)[1]

        element.addClass('mod-input')
        element.addClass('mod-' + portType + '-input')
        element.addClass('input-disconnected')

        element.data('instance', instance)
        element.data('symbol', symbol)
        element.data('portType', portType)

        if (instance != "")
            element.attr('mod-port', instance + "/" + symbol)
        else
            element.attr('mod-port', symbol)

        element.droppable({
            accept: '[mod-role=output-jack]',
            tolerance: 'custom',
            drop: function (event, ui) {
                var overCount = self.data('overCount');
                self.data('overCount', 0);
                self.data('background').droppable('enable')

                var jack = ui.draggable
                var outputType = jack.parent().attr('mod-role').split(/-/)[1]
                var inputType = element.attr('mod-role').split(/-/)[1]
                if (outputType != inputType) {
                    return
                }

                self.pedalboard('do_connect', jack, element, overCount)
                element.removeClass('input-connecting-highlight')
            },
            over: function (event, ui) {
                var outputType = ui.draggable.parent().attr('mod-role').split(/-/)[1]
                var inputType = element.attr('mod-role').split(/-/)[1]
                if (outputType != inputType)
                    return

                element.addClass('input-connecting-highlight')

                var overCount = self.data('overCount')+1;
                self.data('overCount', overCount);
                if (overCount == 1) {
                    self.data('background').droppable('disable')
                }
            },
            out: function (event, ui) {
                element.removeClass('input-connecting-highlight')

                var overCount = self.data('overCount')-1;
                if (overCount < 0) {
                    overCount = 0
                }
                self.data('overCount', overCount);
                if (overCount == 0) {
                    self.data('background').droppable('enable')
                }
            },
            greedy: true,
        })

        element.click(function () {
            var connection = self.data('ongoingConnection')
            // in grid mode a jack is too small a target to tell one port from another: a
            // tap on it is a tap on its plugin, see connectToPlugin
            var port = element.attr('mod-port')
            var instance = port.substring(0, port.lastIndexOf('/'))
            if (connection && self.pedalboard('gridMode') && self.data('plugins')[instance]) {
                self.pedalboard('connectToPlugin', connection.jack, instance)
            } else if (connection) {
                self.pedalboard('do_connect', connection.jack, element)
            } else if (self.pedalboard('gridMode') && self.data('plugins')[instance] &&
                       self.pedalboard('showInputCables', instance)) {
                return false
            } else {
                self.pedalboard('expandInput', element)
            }
        })
    },

    updateGlobalVUMeterPluginInfo: function(pluginInstance) {
        const self = $(this)
        const global_overlay = self.parent()?.parent()?.find(".mod-vumeter-overlay")
        const gui = pluginInstance?.data('gui')
        let label = ""
        let thumbnail_href = ""

        if (gui) {
            const ver = [gui.effect.builder, gui.effect.microVersion, gui.effect.minorVersion, gui.effect.release].join('_')
            label = gui.label

            if (gui.effect) {
                if (!label) {
                    label = gui.effect?.label
                }

                const uri = escape(gui.effect.uri)

                if (gui.effect?.gui?.thumbnail) {
                    thumbnail_href = "/effect/image/thumbnail.png?uri=" + uri + "&v=" + ver
                }
            }
        }

        if (!thumbnail_href) {
            thumbnail_href = "/resources/pedals/default-thumbnail.png"
        }

        global_overlay.find('.js-vumeter-image img').attr('src', thumbnail_href)
        global_overlay.find('.js-vumeter-label').text(label)
    },

    addPortVUMeter: function(port, label, element) {
        const self = $(this)
        const vumeters = self.data('vumeters')
        const vumeter = new VUMeter(32, 256, {
            onClick: (sender, e) => {
                const vumeters = self.data('vumeters')

                const global_vumeter = vumeters['global::overlay']
                let pluginInstance = undefined

                for(var key in vumeters) {
                    const item = vumeters[key]

                    if (item == sender) {
                        item.setIsSelected(true)
                        var instanceKey = key.replace(key.split('/').pop(), '')?.slice(0, -1)

                        if (instanceKey) {
                            self.pedalboard('selectPortVUMeter', instanceKey, port)
                        }
                    } else {
                        item.setIsSelected(false)
                    }
                }
                global_vumeter.setLabel(sender.getLabel())
                global_vumeter.resetClip()
                e.stopPropagation()
            }
        })

        const should_add_global = Object.keys(vumeters).length == 0
        let count = 0
        let vuMeterKey = port.replace(port.split('/').pop(), '')
        for(let key in vumeters) {
            // unselect all other vumeters
            vumeters[key]?.setIsSelected(false)

            // count how many vumeters belong to the same plugin instance, so we can set odd/even class for styling
            if (key.startsWith(vuMeterKey))
                count++
        }

        label = label?.replace('_', ' ')
        vumeter.wrapper.className += count % 2 == 1 ? " odd" : " even"
        vumeter.setLabel(label)
        vumeter.setLabelIsVisible(false)
        vumeter.setIsSelected(true)
        element.append(vumeter.getElement())
        vumeters[port] = vumeter

        if (should_add_global) {
            const global_overlay = self.parent()?.parent()?.find(".mod-vumeter-overlay")
            const global_vumeter_container = global_overlay?.find(".js-vumeter")
            global_overlay.removeClass('mod-hidden')

            // create the global overlay vumeter
            const global_vumeter = new VUMeter("50px", "100%")

            global_vumeter.dbMarkers = [0, -3, -6, -12, -20, -40];
            global_vumeter.wrapper.className += " global"
            global_vumeter.setLabel(label)
            global_vumeter_container.append(global_vumeter.getElement())
            vumeters['global::overlay'] = global_vumeter
        }

        // select the plugin instance for the global vumeter and update the label and thumbnail
        const instance = vuMeterKey.slice(0, -1)
        self.pedalboard('selectPortVUMeter', instance, port)
    },

    selectPortVUMeter: function(pluginInstanceKey, port) {
        const self = $(this)
        const pluginInstance = self.data('plugins')[pluginInstanceKey]

        self.pedalboard('updateGlobalVUMeterPluginInfo', pluginInstance)
        self.data('vumeters::selected', port)

        const vumeters = self.data('vumeters')
        const vumeter = vumeters[port]
        const global_vumeter = vumeters['global::overlay']
        if (global_vumeter) {
            if (vumeter) {
                global_vumeter.setLabel(vumeter.getLabel())
                global_vumeter.setLevel(vumeter.getLevel())
                if (vumeter.getClip()) {
                    global_vumeter.setClip()
                } else {
                    global_vumeter.resetClip()
                }
            } else {
                global_vumeter.setLabel('')
                global_vumeter.setLevel(-60)
                global_vumeter.resetClip()
            }
        }
    },

    removePortVUMeter: function(port) {
        const self = $(this)
        const output = self.find(`[mod-port='${port}']`)
        const vumeter = output ? output.find('.mod-vumeter-wrapper') : undefined

        if (vumeter) {
            vumeter.remove()
            let vumeters = self.data('vumeters')
            delete vumeters[port]

            if (Object.keys(vumeters).length == 1) { // we only have the global vumeter, remove it
                const global_overlay = self.parent()?.parent()?.find(".mod-vumeter-overlay")

                global_overlay.addClass('mod-hidden')
                global_vumeter = vumeters['global::overlay']
                global_vumeter.getElement().remove();
                delete vumeters['global::overlay']
            } else {
                // check if is the selected vumeter
                if (port == self.data('vumeters::selected')) {
                    const global_vumeter = vumeters['global::overlay']
                    const firstKey = Object.keys(vumeters).find(key => key !== 'global::overlay')

                    if (global_vumeter) {
                        const instanceKey = firstKey?.replace(firstKey.split('/').pop(), '')?.slice(0, -1)
                        self.pedalboard('selectPortVUMeter', instanceKey, firstKey)
                    } else {
                        console.warn("not global vumeter present: vumeters not synched with host?!?")
                    }
                }
            }
        }
    },

    setPortVUMeterValue: function(port, db) {
        var self = $(this)
        const vumeters = self.data('vumeters')
        let vumeter = vumeters[port]

        if (vumeter) {
            vumeter.setLevel(db)
            if (port == self.data('vumeters::selected')) {
                vumeter = vumeters['global::overlay']
                vumeter.setLevel(db)
            }
        } else {
            // check if we have to debounce the vumeter creation,
            // because we just closed the plugin settings and the vumeter was removed,
            // but the host is still sending some values for it
            const debounceBaseDate = self.data('currentSettingsWindowClosedTime') || 0
            if (debounceBaseDate && (Date.now() - debounceBaseDate) < 3000) {
                console.log("debouncing vumeter creation for port " + port + " because settings window was just closed")
                return
            }
            // if we don't have a vumeter we have refreshed the page
            // create a new one
            const output = self.find(`[mod-port='${port}']`)
            if (output && output[0]) {
                const label = output.attr('title')

                self.pedalboard('addPortVUMeter', port, label, output[0])
            }
        }

    },

    /*
     * Toggle monitoring for a list of output ports.
     * If the port is already being monitored, it will be stopped, otherwise it will be started.
     *
     * targets parameter is a list of jack connections
     */
    togglePortsMonitoring: function(targets) {
        const self = $(this)
        let distinctOutputPorts = new Map()

        for(const target of targets) {
            const output = target.data('origin')
            const outputPort = output?.attr('mod-port')

            if (outputPort) {
                distinctOutputPorts.set(outputPort, output)
            }
        }

        for(const [port, output] of distinctOutputPorts) {
            const label = output.attr('title')

            self.data('changePortMonitoring')(port, 'toggle', function (resp) {
                if (resp) {
                    self.pedalboard('addPortVUMeter', port, label, output)
                } else {
                    self.pedalboard('removePortVUMeter', port)
                }
            })
        }
    },

    // Make element an audio output, which contain jacks that can be dragged to
    // inputs to make connections
    makeOutput: function (element, instance) {
        var self = $(this)
        var symbol = element.attr('mod-port-symbol')
        var portType = element.attr('mod-role').split(/-/)[1]

        element.addClass('mod-output')
        element.addClass('mod-' + portType + '-output')
        element.addClass('output-disconnected')

        element.data('instance', instance)
        element.data('symbol', symbol)
        element.data('portType', portType)
        if (instance != "")
            element.attr('mod-port', instance + "/" + symbol)
        else
            element.attr('mod-port', symbol)


        self.pedalboard('spawnJack', element)

        element.click(function (e) {
            // Do not start connection if cv addressing checkbox or text input clicked
            if (!$(e.target).is('input') && !$(e.target).hasClass('checkmark') && !$(e.target).hasClass('checkbox-container')) {
              // POC: shift pressed toggle audio level monitoring
              if (e.shiftKey || e.ctrlKey) {
                const jack = element.find('[mod-role=output-jack]')
                const output = jack.parent()
                const port = output.attr('mod-port')
                const label = output.attr('title')
                const urlParam = port + ',toggle'

                self.data('changePortMonitoring')(port, 'toggle', function (resp) {
                    if (resp) {
                        self.pedalboard('addPortVUMeter', port, label, output)
                    } else {
                        self.pedalboard('removePortVUMeter', port)
                    }
                });
             
              } else if (self.pedalboard('gridMode') && ! self.data('ongoingConnection')) {
                  // as small as an input's, see connectFromOutputs
                  var port = element.attr('mod-port')
                  var instance = port.substring(0, port.lastIndexOf('/'))
                  if (! self.data('plugins')[instance] || ! self.pedalboard('connectFromOutputs', instance)) {
                      self.pedalboard('startConnection', element)
                  }
              } else {
                  self.pedalboard('startConnection', element)
              }
            }
        })
    },

    // Creates a jack element inside an output. This jack can then be dragged and dropped
    // inside an input to connect them.
    // Each jack knows it's origin's instance and symbol, and also tracks several elements
    // that are created with it to draw fancy cables.
    spawnJack: function (output) {
        var self = $(this)
        var jack = $('<div>').appendTo(output)

        jack.attr('mod-role', 'output-jack')
        jack.addClass('mod-output-jack')
        jack.addClass('jack-disconnected')

        // Track the origin of the jack
        jack.data('origin', output)

        // Indicates if this jack is connected to an input or not, and to which input
        jack.data('connected', false)
        jack.data('destination', null)

        // Create a canvas occupying the whole screen, which will be used to draw this
        // jack's cable.
        // The cable is composed by three lines with different style: one for the cable,
        // one for the background shadow and one for the reflecting light.
        var canvas = $('<div>');
        canvas.addClass('ignore-arrive');
        // named so the tracing css can dim every cable without also catching the canvas
        // that startConnection makes for a cable being dragged
        canvas.addClass('mod-cable-canvas');

        if (output.attr("class").search("mod-audio-") >= 0)
            canvas.addClass("mod-audio");
        else if (output.attr("class").search("mod-midi-") >= 0)
            canvas.addClass("mod-midi");
        else if (output.attr("class").search("mod-cv-") >= 0)
            canvas.addClass("mod-cv");

        // Add checkbox + text inputs next to output cv ports for addressings
        if (output.attr('mod-role') === 'output-cv-port' && output.find('.output-cv-checkbox').length === 0) {
          var port = output.attr("mod-port");
          var portSymbol = output.attr("mod-port-symbol");
          var cvPort = '/cv' + port;
          var addedPort = self.data('hardwareManager').cvOutputPorts.find(function (port) {
            return port.uri === cvPort;
          });

          var cvCheckboxInput = $('<div>');
          cvCheckboxInput.addClass('ignore-arrive');

          // Append checkbox
          var checkbox = $('<input type="checkbox">');
          var checkboxContainer = $('<span class="checkbox-container"></span>');
          checkbox.appendTo(checkboxContainer);
          $('<span class="checkmark" />').appendTo(checkboxContainer);
          checkboxContainer.appendTo(cvCheckboxInput);

          // Append text input
          var textInput = $('<input type="text" />');
          textInput.appendTo(cvCheckboxInput);

          cvCheckboxInput.addClass('output-cv-checkbox');
          cvCheckboxInput.appendTo(output);
          if (!self.data('cvAddressing')) {
            cvCheckboxInput.hide()
          }

          // Disable inputs for hardware cv ports
          var defaultText = output.attr("title")
          if (
            portSymbol === "/graph/cv_exp_pedal" ||
            portSymbol === "/graph/cv_capture_1" ||
            portSymbol === "/graph/cv_capture_2"
          ) {
            checkbox.prop('disabled', true);
            checkbox.prop('checked', true);
            textInput.prop('disabled', true);
          } else {
            // Add default displayed name to plugins CV ports
            var instance = port
              .split("/graph/")[1]
              .split("/")[0]
              .replace(/^\w/, function(chr) {
                return chr.toUpperCase();
              });
            defaultText = instance + " " + defaultText
            if (addedPort) {
              defaultText = addedPort.name;
              checkbox.prop('checked', true);
            } else {
              textInput.hide();
            }
          }
          textInput.val(defaultText);

          checkbox.change(function () {
            var name = textInput.val();
            if ($(this).prop('checked')) {
              // Register new addressable cv port
              self.data('addCVAddressingPluginPort')(cvPort, name, function (resp) {
                if (resp && resp.ok) {
                  self.data('hardwareManager').addCvOutputPort(cvPort, name, resp.operational_mode);
                  // Show and highlight text input
                  textInput.show();
                  textInput.select();
                }
              });
            } else {
              // Unregister cv port
              self.data('removeCVAddressingPluginPort')(cvPort, function (resp) {
                if (resp) {
                  self.data('hardwareManager').removeCvOutputPort(cvPort);
                  // Hide text input again
                  textInput.hide();
                }
              });
            }
          })

          textInput.change(function () {
            var name = $(this).val();
            self.data('addCVAddressingPluginPort')(cvPort, name, function (resp) {
              if (resp && resp.ok) {
                self.data('hardwareManager').addCvOutputPort(cvPort, name, resp.operational_mode);
              }
            });
          });

          textInput.keydown(function (e) {
            if (e.keyCode === 13) {
              $(this).blur();
            }
          });
        }

        canvas.css({
            width: '100%',
            height: '100%',
            position: 'absolute',
            top: 0,
            left: 0
        })
        self.append(canvas)
        canvas.svg()
        var svg = canvas.find('svg')
        svg.css({
            width: '100%',
            height: '100%',
            position: 'absolute',
            top: 0,
            left: 0
        })

        jack.data('canvas', canvas)
        svg = canvas.svg('get')
        jack.data('svg', svg)
        canvas.data('pathShadow', svg.createPath())
        canvas.data('pathCable', svg.createPath())
        canvas.data('pathLight', svg.createPath())

        jack.draggable({
            revert: 'invalid',
            revertDuration: 0,
            start: function () {
                // Prevents dragging of whole pedalboard while jack is being dragged
                self.pedalboard('preventDrag', true)

                // If user has started a connection by clicking a jack, this drag will
                // end it
                self.pedalboard('finishConnection')

                // the cable about to be dragged is drawn into this jack's own canvas, so
                // any trace still running would dim it along with the rest
                self.pedalboard('clearTracing')

                // Highlight all inputs in which this jack can be dropped
                self.pedalboard('highlightInputs', true, jack)

                // While jack is being dragged, all related elements receive
                // the "*-connecting" class
                jack.removeClass('jack-disconnected')
                jack.removeClass('jack-connected')
                jack.addClass('jack-connecting')
                output.addClass('output-connecting')
                canvas.removeClass('cable-connected')
                canvas.addClass('cable-connecting')

                var cur = jack.data('destination')
                if (cur)
                    cur.removeClass('input-connected')

            },
            drag: function (e, ui) {
                // the jack moves inside its plugin, which grid mode may have scaled too
                var scale = self.data('scale') * self.pedalboard('iconScale', jack)
                ui.position.top /= scale
                ui.position.left /= scale
                jack.css({ marginTop: 0 })
                self.pedalboard('drawJack', jack, true)
            },
            stop: function () {
                self.pedalboard('preventDrag', false)

                self.pedalboard('highlightInputs', false)
                jack.removeClass('jack-connecting')
                output.removeClass('output-connecting')
                canvas.removeClass('cable-connecting')
                if (!jack.hasClass('jack-connected')) {
                    jack.addClass('jack-disconnected')
                    jack.css({
                        top: 'auto',
                        left: 'auto',
                        marginTop: 'auto',
                    })

                    // if jack output previous sibling has a margin-bottom,
                    // adjust jack top position in accordance
                    if (jack.data('origin') && jack.data('origin').prev() && jack.data('origin').prev().css('margin-bottom')) {
                      jack.css('top', parseInt(jack.css('top')) - parseInt(jack.data('origin').prev().css('margin-bottom')))
                    }
                }
                self.pedalboard('drawJack', jack)
            }
        })

        // draggable puts position relative in jack. this messes with layout and is not necessary
        // in this case, because we'll recalculate the position during drag anyway because of scaling
        jack.css('position', 'absolute')

        canvas.click(function () {
            self.pedalboard('colapseInput')
            self.pedalboard('finishConnection')
        })

        return jack
    },

    destroyJack: function (jack) {
        var self = $(this)
        var output = jack.data('origin')
        var input = jack.data('destination')
        self.pedalboard('refreshPluginView')
        // Looked up while the connection is still there, because that is what identifies
        // the pair. A merged stereo cable is painted into one half's canvas, so losing
        // either half leaves the wrong thing on screen - a cable with a leg dangling
        // where its partner used to land, or nothing at all - until what is left of the
        // pair is redrawn on its own
        var pair = self.pedalboard('stereoPartnerJack', jack)
        self.pedalboard('clearTracing')
        self.data('connectionManager').disconnect(output.attr('mod-port'), input.attr('mod-port'))
        jack.data('canvas').remove()
        jack.remove()
        // after the remove, not before: teleportedJacks() walks the live dom, so a jack
        // still in it counts itself and the prune lags a cable behind
        self.pedalboard('teleportsChanged', [])
        self.pedalboard('packJacks', input)
        if (pair) {
            self.pedalboard('drawJack', pair.jack)
        }
    },

    // The port element that `element` forms a stereo pair with, or null. `first` tells
    // whether `element` is the left/odd half of that pair, which is the half that owns
    // the drawing of the merged cable.
    stereoPartner: function (element) {
        var self = $(this)

        // Off by preference: every connection then draws as its own cable, which is
        // what the rest of the code does anyway when nothing pairs up.
        if (typeof PREFERENCES !== 'undefined' && PREFERENCES['merge-stereo-cables'] == "false") {
            return null
        }

        var counterpart = stereoCounterpart(element.data('symbol'))
        if (! counterpart) {
            return null
        }
        var instance = element.data('instance')
        var port = instance ? instance + '/' + counterpart.symbol : counterpart.symbol
        var partner = self.find('[mod-port="' + port + '"]')
        // Guessing the name is not enough. It has to be a port that exists, and one that
        // faces the same way and carries the same kind of signal, or "gain_1" pairs with
        // a control port and a hardware capture pairs with a playback
        if (partner.length !== 1 ||
            partner.hasClass('mod-output') !== element.hasClass('mod-output') ||
            partner.data('portType') !== element.data('portType')) {
            return null
        }
        return { element: partner, first: counterpart.first }
    },

    // The jack that pairs with `jack` to make one stereo cable, plus whether `jack` is
    // the left/odd half. That is a stereo pair wired straight across, or one output into
    // both halves of a stereo input (mono into stereo), or both halves of a stereo output
    // into one input (stereo into mono): the ends that coincide meet in one point. Null
    // when there is no pair: the ports do not name themselves as one, they are crossed
    // over, or nothing matching is wired up on the other side.
    stereoPartnerJack: function (jack) {
        var self = $(this)
        var input = jack.data('destination')
        if (! jack.data('connected') || ! input) {
            return null
        }
        var origin = jack.data('origin')
        var output = self.pedalboard('stereoPartner', origin)
        var dest = self.pedalboard('stereoPartner', input)
        var origIndex = self.data('connectionManager').origIndex
        var jackBetween = function (from, to) {
            return (origIndex[from.attr('mod-port')] || {})[to.attr('mod-port')] || null
        }
        var partner
        // A pair wired straight across is one cable. L to R and R to L is a channel swap,
        // and drawing that as one cable would hide what it does
        if (output && dest && dest.first === output.first) {
            partner = jackBetween(output.element, dest.element)
            if (partner) {
                return { jack: partner, first: output.first }
            }
        }
        // the same output into the other half of the input's pair
        if (dest) {
            partner = jackBetween(origin, dest.element)
            if (partner) {
                return { jack: partner, first: dest.first }
            }
        }
        // the other half of the output's pair into the same input
        if (output) {
            partner = jackBetween(output.element, input)
            if (partner) {
                return { jack: partner, first: output.first }
            }
        }
        return null
    },

    // Origin and destination anchor points of one jack's cable, in canvas coordinates
    jackCoords: function (jack, force) {
        var self = $(this)
        var source = jack.data('origin')
        var scale = self.data('scale')

        // Cable will follow a cubic bezier curve, which is defined by 4 points. They are:
        // P0 (xi, yi) - starting point
        // P3 (xo, yo) - the destination point
        // P1 (xo - deltaX, yi) and P2 (xi + deltaX, yo): define the curve
        // Gets origin and destination coordinates
        // offset() already has any scaling of the plugins in it, width() and height() do not
        var sourceScale = self.pedalboard('iconScale', source)
        var jackScale = self.pedalboard('iconScale', jack)
        var xi = source.offset().left / scale - self.offset().left / scale + source.width() * sourceScale
        var yi = source.offset().top / scale - self.offset().top / scale + source.height() * sourceScale / 2
        var xo = jack.offset().left / scale - self.offset().left / scale
        var jackOffsetTop = jack.offset().top

        // Adjust jack offset top position
        // that is sometimes biased by jack destination previous sibling margin bottom
        if (!force && parseInt(jack.css('top')) === 0 && parseInt(jack.css('bottom')) === 0) {
          jackOffsetTop = jack.offset().top - jack.position().top
        }
        var yo = jackOffsetTop / scale - self.offset().top / scale + jack.height() * jackScale / 2

        return { xi: xi, yi: yi, xo: xo, yo: yo }
    },

    // How far a teleport's stub runs before it meets its box.
    // (TELEPORT_STUB is defined at the bottom of this file, beside cableDeltaX)

    // The name of the point an output feeds, or null if it has none.
    teleportName: function (port) {
        var self = $(this)
        return self.data('teleportNames')[port.attr('mod-port')] || null
    },

    // Every jack currently drawn as a teleport. Walked rather than indexed: teleports are
    // changed by hand, a few at a time, so there is nothing here worth an index.
    teleportedJacks: function () {
        var self = $(this)
        var out = []
        self.find('[mod-role=output-jack]').each(function () {
            var jack = $(this)
            if (jack.data('teleported') && jack.data('connected')) {
                out.push(jack)
            }
        })
        return out
    },

    // The cables the teleport key acts on. A jack inside an expanded input is a single cable and wins,
    // because that is the whole reason for expanding an input; otherwise it is every cable
    // on the hovered port, whichever way round the port is.
    hoverTargets: function () {
        var self = $(this)
        var jack = self.data('hoverJack')
        if (jack && jack.data('connected') && jack.closest('.expanded').length) {
            return [jack]
        }
        var port = self.data('hoverPort')
        if (! port) {
            return []
        }
        var jacks = self.pedalboard('jacksAtPort', port)
        var out = []
        for (var i = 0; i < jacks.length; i++) {
            if (jacks[i] && jacks[i].data('connected')) {
                out.push(jacks[i])
            }
        }
        return out
    },

    // Turns the given cables into teleports, or back if they are all already on. Follows a
    // stereo partner in BOTH directions: un-teleporting one leg at a time would leave the
    // pair half-teleported, which is what the rule exists to prevent.
    toggleTeleport: function (jacks) {
        var self = $(this)
        var i
        if (! jacks.length) {
            return
        }
        var turningOff = true
        for (i = 0; i < jacks.length; i++) {
            if (! jacks[i].data('teleported')) {
                turningOff = false
                break
            }
        }

        var todo = []
        var seen = []
        for (i = 0; i < jacks.length; i++) {
            var group = [jacks[i]]
            var pair = self.pedalboard('stereoPartnerJack', jacks[i])
            if (pair && pair.jack.data('connected')) {
                group.push(pair.jack)
            }
            for (var g = 0; g < group.length; g++) {
                if (seen.indexOf(group[g][0]) < 0) {
                    seen.push(group[g][0])
                    todo.push(group[g])
                }
            }
        }

        for (i = 0; i < todo.length; i++) {
            var jack = todo[i]
            jack.data('teleported', ! turningOff)
            if (! turningOff) {
                // an output with no name yet gets one, unique by construction
                var output = jack.data('origin')
                if (! self.pedalboard('teleportName', output)) {
                    var names = self.data('teleportNames')
                    var key = output.attr('mod-port')
                    var last = self.data('teleportNamesRemembered')[key]
                    if (last && teleportNameAvailable(last, key, names)) {
                        // what you called it last time, unless someone else has taken it
                        names[key] = last
                    } else {
                        names[key] = teleportDefaultName(
                            self.pedalboard('teleportPluginName', output),
                            output.attr('title') || output.data('symbol') || '',
                            names)
                    }
                }
            }
        }

        self.pedalboard('teleportsChanged', todo)
        self.trigger('modified')
    },

    // The plugin a port belongs to, by the name shown on its pedal, for use in a default
    // teleport name. The plugin's own label wins over the effect's -- the same order
    // updateGlobalVUMeterPluginInfo uses. Hardware ports belong to no plugin and get an
    // empty string, which teleportDefaultName handles by using the port name alone.
    teleportPluginName: function (port) {
        var self = $(this)
        var instance = port.data('instance')
        if (! instance) {
            return ''
        }
        // getGui, not data('plugins') directly: host.js leaves a bare {} placeholder while
        // /effect/get is in flight, and {} is truthy but has no .data. getGui guards it.
        var gui = self.pedalboard('getGui', instance)
        if (! gui) {
            return ''
        }
        return gui.label || (gui.effect ? gui.effect.label : '') || ''
    },

    // THE lifetime rule: a name exists exactly as long as one of its output's cables is
    // teleported. Split out of teleportsChanged so finishTeleportLoad can apply it without
    // posting or marking the board modified.
    pruneTeleportNames: function () {
        var self = $(this)
        var names = self.data('teleportNames')
        var used = {}
        var live = self.pedalboard('teleportedJacks')
        for (var i = 0; i < live.length; i++) {
            used[live[i].data('origin').attr('mod-port')] = true
        }
        // A cable with no jack right now still counts if it is parked in pendingTeleports:
        // during a load its connection has not arrived yet, and during a re-route the jack
        // carrying it is destroyed and replaced. Either way the name must survive the gap.
        var pending = self.data('pendingTeleports')
        for (var key in pending) {
            used[key.split(TELEPORT_ARROW)[0]] = true
        }
        var remembered = self.data('teleportNamesRemembered')
        for (var port in names) {
            if (! used[port]) {
                // keep it recallable, but stop it occupying the namespace
                remembered[port] = names[port]
                delete names[port]
            }
        }
    },

    // Everything that changes a teleport ends here: prune names, drop dead boxes, redraw,
    // and post the map so it reaches the next save. Marking the board modified is the
    // caller's job.
    teleportsChanged: function (jacks) {
        var self = $(this)
        var i

        self.pedalboard('pruneTeleportNames')
        self.pedalboard('pruneTeleportBoxes')
        for (i = 0; i < (jacks || []).length; i++) {
            self.pedalboard('drawJack', jacks[i])
        }
        // No generation means no board has been handed to us yet, so nothing to post
        // about. The teardown flag saves pointless writes; the generation is what makes a
        // late one harmless.
        var gen = self.data('teleportGen')
        if (! self.data('teleportsTeardown') && gen !== null && gen !== undefined) {
            $.ajax({
                url: '/pedalboard/teleports/',
                type: 'POST',
                data: {
                    teleports: JSON.stringify(self.pedalboard('serialiseTeleports')),
                    gen: gen,
                },
                cache: false,
                dataType: 'json',
            })
        }

        // A trace names the canvas each cable was painted into when the pointer arrived.
        // Teleporting moves that paint and adds boxes that did not exist to be lit, so the
        // stale trace dims the very cable under the pointer. Recompute, behind the redraws
        // above, which are what create the boxes.
        if (self.hasClass('mod-tracing')) {
            setTimeout(function () {
                var hovered = self.data('hoverPort')
                if (! hovered) {
                    return
                }
                self.pedalboard('clearTracing')
                self.pedalboard('traceFrom', hovered)
            }, 0)
        }
    },

    // The saved shape, built from the live jacks rather than from a stored key set. A jack
    // dragged to another input is disconnected and reconnected as the SAME element, so a
    // set keyed by "out -> in" would see one key vanish and an unrelated one appear; the
    // flag rides on the jack instead and the key comes out right here.
    serialiseTeleports: function () {
        var self = $(this)
        var jacks = self.pedalboard('teleportedJacks')
        var cables = []
        for (var i = 0; i < jacks.length; i++) {
            cables.push({ from: jacks[i].data('origin').attr('mod-port'),
                          to:   jacks[i].data('destination').attr('mod-port') })
        }
        return teleportSerialise(self.data('teleportNames'), cables)
    },

    // Applies a map that arrived with a pedalboard. Names are usable at once; most cables
    // are not, because their plugins are still being built by an async /effect/get. Those
    // are parked in pendingTeleports and consumed by connect() as each cable appears.
    // Deliberately not via teleportsChanged, which would post straight back.
    applyTeleports: function (data) {
        var self = $(this)
        var parsed = teleportDeserialise(data)
        var manager = self.data('connectionManager')
        // this map belongs to THIS load: started fresh, so a cable left unplaced by a
        // previous board can never latch onto a connection in the next one
        var pending = {}
        var i

        self.data('teleportNames', parsed.names)
        self.data('pendingTeleports', pending)
        // the generation this map belongs to, echoed back on every POST so the server can
        // drop a write computed from a board that has since been torn down
        self.data('teleportGen', (data && typeof data.gen === 'number') ? data.gen : null)
        for (i = 0; i < parsed.cables.length; i++) {
            var from = parsed.cables[i].from
            var to = parsed.cables[i].to
            var byDest = manager.origIndex[from]
            var jack = byDest ? byDest[to] : null
            if (jack) {
                jack.data('teleported', true)
            } else {
                pending[from + TELEPORT_ARROW + to] = true
            }
        }

        var jacks = self.pedalboard('teleportedJacks')
        self.pedalboard('pruneTeleportBoxes')
        for (i = 0; i < jacks.length; i++) {
            self.pedalboard('drawJack', jacks[i])
        }
    },

    // Once a load finishes, anything still pending named a cable that never showed up, so
    // it is dropped rather than left to latch onto a later connection. Prunes directly
    // rather than via teleportsChanged, which would post back and dirty the board.
    finishTeleportLoad: function () {
        var self = $(this)
        self.data('pendingTeleports', {})
        self.pedalboard('pruneTeleportNames')
    },

    // Applies a name the user typed. Empty removes the teleport from this output's cables.
    // A name another output holds is refused and the caller restores the old text --
    // silently renumbering it, or taking it off the other output, would both be worse.
    setTeleportName: function (port, typed) {
        var self = $(this)
        var names = self.data('teleportNames')
        var key = port.attr('mod-port')
        var name = (typed || '').trim()
        var affected = []
        var jacks = self.pedalboard('teleportedJacks')
        var i

        for (i = 0; i < jacks.length; i++) {
            if (jacks[i].data('origin').attr('mod-port') === key) {
                affected.push(jacks[i])
            }
        }

        // The box under the pointer is about to be replaced or removed, so its mouseleave
        // will never arrive and the trace would stay on with nothing to clear it -- the
        // board sits dimmed until something else happens. destroyJack does this for the
        // same reason.
        self.pedalboard('clearTracing')

        if (! name) {
            for (i = 0; i < affected.length; i++) {
                affected[i].data('teleported', false)
            }
            delete names[key]
            // an explicit discard, so the remembered copy goes too -- otherwise an earlier
            // toggle-off would quietly bring the old label back on the next teleport
            delete self.data('teleportNamesRemembered')[key]
            self.pedalboard('teleportsChanged', affected)
            self.trigger('modified')
            return true
        }

        if (! teleportNameAvailable(name, key, names)) {
            return false
        }

        names[key] = name
        self.pedalboard('teleportsChanged', affected)
        self.trigger('modified')
        return true
    },

    // How many teleported cables arrive at one input. They all draw their box at the same
    // place, so past one only the topmost is visible and the rest are hidden behind it.
    teleportsIntoPort: function (port) {
        var self = $(this)
        var wanted = port.attr('mod-port')
        var jacks = self.pedalboard('teleportedJacks')
        var n = 0
        for (var i = 0; i < jacks.length; i++) {
            var dest = jacks[i].data('destination')
            if (dest && dest.attr('mod-port') === wanted) {
                n++
            }
        }
        return n
    },

    // The count shown over a pile of boxes at one input, so a stack of them does not read
    // as a single teleport. One badge per input rather than one per box: they are all at
    // the same spot, and which of them ends up on top is not something to depend on.
    teleportBadge: function (port) {
        var self = $(this)
        var boxes = self.data('teleportBoxes')
        var key = 'badge ' + port.attr('mod-port')
        var badge = boxes[key]
        if (! badge) {
            badge = $('<div>').addClass('ignore-arrive mod-teleport-badge')
            badge.attr('title', 'Several teleports arrive here -- click to fan them out')
            badge.on('mousedown', function (e) { e.stopPropagation() })
            // as above: a second click on the badge must not zoom the board out
            badge.on('dblclick', function (e) { e.stopPropagation() })
            badge.on('click', function (e) {
                e.stopPropagation()
                self.pedalboard('expandInput', port)
            })
            badge.appendTo(self)
            boxes[key] = badge
        }
        badge.data('port', port)
        return badge
    },

    // The box at one end of a teleport. Keyed by side, port and name, so an output with
    // one name shows one box however many cables leave it, and an input shows one box per
    // distinct name arriving. Boxes are html, not svg: they take text and a caret, and the
    // canvas holding the svg has pointer-events:none anyway.
    teleportBox: function (side, port, name) {
        var self = $(this)
        var boxes = self.data('teleportBoxes')
        var key = side + ' ' + port.attr('mod-port') + ' ' + name
        var box = boxes[key]
        if (! box) {
            box = $('<input type="text" spellcheck="false">')
            box.addClass('ignore-arrive mod-teleport mod-teleport-' + side)
            if (side === 'in') {
                // Only the output end is editable; the input ends mirror it. Kept out of
                // the tab order as well as read-only -- it is a label, and anything that
                // invites you to type in it is a lie, since the text lives on the output.
                box.attr('readonly', 'readonly')
                box.attr('tabindex', '-1')
            }
            box.appendTo(self)
            if (side === 'out') {
                box.on('keydown', function (e) {
                    // do not let the board's own shortcuts see the typing
                    e.stopPropagation()
                    if (e.keyCode === 13) {
                        $(this).blur()
                    } else if (e.keyCode === 27) {
                        $(this).val($(this).data('committed')).blur()
                    }
                })
                box.on('focus', function () {
                    $(this).data('committed', $(this).val())
                })
                box.on('blur', function () {
                    var typed = $(this).val()
                    // nothing typed, nothing to commit -- this is also what makes Escape a
                    // real cancel, since it puts the committed text back before blurring
                    if (typed === $(this).data('committed')) {
                        return
                    }
                    if (! self.pedalboard('setTeleportName', $(this).data('port'), typed)) {
                        $(this).val($(this).data('committed'))
                        $(this).addClass('mod-teleport-clash')
                        var flashing = $(this)
                        setTimeout(function () { flashing.removeClass('mod-teleport-clash') }, 900)
                    }
                })
            }
            if (side === 'in') {
                // The label is what you can actually hit when several teleports stack at
                // one input -- the input itself is behind them. Same action as clicking
                // the port: fan the jacks out so each box gets its own cable.
                box.on('click', function (e) {
                    e.stopPropagation()
                    self.pedalboard('expandInput', $(this).data('port'))
                })
            }

            // Both ends swallow mousedown, or a click on a label pans the board. The
            // read-only end also refuses focus: it is still an <input>, so preventDefault
            // is what stops a caret appearing in a field you cannot type into. The click
            // still fires, which is what fans the stack out.
            box.on('mousedown', function (e) {
                e.stopPropagation()
                if (side === 'in') {
                    e.preventDefault()
                }
            })

            // Stopped from reaching the board, which double-click-zooms out, and body,
            // where desktop.js preventDefaults every dblclick and kills the selection.
            // Only the editable end selects: doing it on the mirror suggests you can
            // change it there.
            box.on('dblclick', function (e) {
                e.stopPropagation()
                if (side === 'out') {
                    this.select()
                }
            })
            boxes[key] = box
        }
        box.data('port', port)
        // the box is narrower than some names, so the full one is on hover
        box.attr('title', name)
        // do not fight the caret while the user is typing in this very box
        if (document.activeElement !== box[0]) {
            box.val(name)
        }
        return box
    },

    // Drops boxes that no teleported cable asks for any more. Called when teleports
    // change -- a keypress, a rename, a disconnect -- not on every redraw, because a
    // redraw happens on every drag tick and changes nothing about which boxes exist.
    pruneTeleportBoxes: function () {
        var self = $(this)
        var boxes = self.data('teleportBoxes')
        var live = {}
        var jacks = self.pedalboard('teleportedJacks')
        for (var i = 0; i < jacks.length; i++) {
            var jack = jacks[i]
            var name = self.pedalboard('teleportName', jack.data('origin'))
            if (! name) {
                continue
            }
            live['out ' + jack.data('origin').attr('mod-port') + ' ' + name] = true
            live['in ' + jack.data('destination').attr('mod-port') + ' ' + name] = true
        }
        for (var key in boxes) {
            // A badge is keyed by input port, not by name, so the name-based sweep below
            // says nothing about it. It goes when its input no longer has a pile to count
            // -- including when the last teleport there is removed, after which
            // drawTeleportJack never runs for that input again to take it down itself.
            if (key.indexOf('badge ') === 0) {
                var bport = boxes[key].data('port')
                if (! bport || ! bport.closest('body').length ||
                    self.pedalboard('teleportsIntoPort', bport) < 2) {
                    boxes[key].remove()
                    delete boxes[key]
                }
                continue
            }
            if (! live[key]) {
                boxes[key].remove()
                delete boxes[key]
            }
        }
    },

    // Puts a teleport back on a cable a plugin replacement is recreating: the old jack is
    // gone, so both the flag and the name went with it. Parks the cable so connect() flags
    // whichever jack carries it. Only reclaims the name if it is still free.
    restoreReplacedTeleport: function (name, outport, inport) {
        var self = $(this)
        if (! name) {
            return null
        }
        var names = self.data('teleportNames')
        if (! names[outport] && teleportNameAvailable(name, outport, names)) {
            names[outport] = name
        }
        if (! names[outport]) {
            return null
        }
        var key = outport + TELEPORT_ARROW + inport
        self.data('pendingTeleports')[key] = true
        // Handed back so the caller can drop it if the reconnect is refused. A key nobody
        // consumes is not harmless: pruneTeleportNames counts a parked key as in use, so
        // the name would sit in the namespace with no cable and no box until the next load.
        // do_connect does the same on its own failure path.
        return key
    },

    // Wraps the replacement's finalizeConnection so a refused reconnect also un-parks the
    // teleport key restoreReplacedTeleport put down for it.
    replacedConnectionDone: function (key, finalize) {
        var self = $(this)
        return function (ok) {
            if (! ok && key) {
                delete self.data('pendingTeleports')[key]
                // the key was the only thing keeping that name alive; without this it sits
                // in the namespace with no cable and no box, refusing itself to others
                self.pedalboard('pruneTeleportNames')
            }
            finalize(ok)
        }
    },

    // The canvas actually carrying a jack's paint, and which half of it the jack is. Both
    // halves of a merged stereo pair are painted together into the left half's canvas and
    // the right half's is emptied, so hovering either half lights the left one; leg says
    // which of the two sets of legs is the hovered jack's own. An unmerged cable is all
    // one thing, so its leg is null.
    litCanvas: function (jack) {
        var self = $(this)
        var pair = self.pedalboard('stereoPartnerJack', jack)
        // Same guard as drawStereoJack: a teleported pair is painted into two separate
        // canvases, not merged into the left half's, so resolving to the partner's canvas
        // here would light the wrong cable (or the partner's, and never this jack's own)
        // whenever either half of the pair is teleported.
        if (pair && pair.jack.data('connected') &&
                ! jack.data('teleported') && ! pair.jack.data('teleported')) {
            return { canvas: (pair.first ? jack : pair.jack).data('canvas'),
                     leg: pair.first ? 0 : 1, partner: pair.jack }
        }
        return { canvas: jack.data('canvas'), leg: null, partner: null }
    },

    // Every jack touching a port. origIndex is keyed by output port and destIndex by
    // input port, each holding a map of the other end to its jack, so one lookup in each
    // covers a port whichever way round it is.
    jacksAtPort: function (port) {
        var self = $(this)
        var name = port.attr('mod-port')
        var manager = self.data('connectionManager')
        var jacks = []
        if (! name || ! manager) {
            return jacks
        }
        var indexes = [manager.origIndex[name], manager.destIndex[name]]
        for (var i = 0; i < indexes.length; i++) {
            for (var otherEnd in indexes[i]) {
                jacks.push(indexes[i][otherEnd])
            }
        }
        return jacks
    },

    // True while a new cable is being made, either by dragging a jack out of an output or
    // by the click to start, click to finish path. Tracing keeps out of the way then: the
    // cable being dragged is drawn into its own jack's canvas, which the dimming would
    // catch, so the one cable the pointer is carrying is the one that would go dim.
    connecting: function () {
        var self = $(this)
        return !! self.data('ongoingConnection') || self.find('.jack-connecting').length > 0
    },

    // Lights every cable on a port, and the jacks at both ends of each. A port with
    // nothing connected traces nothing at all, which is what keeps the spare jack an
    // output always holds for dragging from dimming the board and lighting nothing.
    traceFrom: function (port) {
        var self = $(this)
        if (self.pedalboard('connecting')) {
            return
        }
        var jacks = self.pedalboard('jacksAtPort', port)
        var traced = 0
        for (var i = 0; i < jacks.length; i++) {
            var jack = jacks[i]
            if (! jack || ! jack.data('connected')) {
                continue
            }
            var lit = self.pedalboard('litCanvas', jack)
            lit.canvas.attr('data-cable-lit', lit.leg === null ? '' : lit.leg)
            jack.attr('data-jack-lit', '')
            // a teleported cable's boxes are not inside the canvas the tracing lights, so
            // they have to be picked out by name
            if (jack.data('teleported')) {
                var tname = self.pedalboard('teleportName', jack.data('origin'))
                if (tname) {
                    // read the boxes, never teleportBox(): that CREATES one on a key miss
                    // and tracing has no business placing it, so a miss would leave an
                    // unpositioned box sitting at the origin
                    var boxes = self.data('teleportBoxes')
                    var outBox = boxes['out ' + jack.data('origin').attr('mod-port') + ' ' + tname]
                    var inBox = boxes['in ' + jack.data('destination').attr('mod-port') + ' ' + tname]
                    if (outBox) {
                        outBox.attr('data-teleport-lit', '')
                    }
                    if (inBox) {
                        inBox.attr('data-teleport-lit', '')
                    }
                }
            }
            // both jacks of a merged pair belong to the one cable being traced
            if (lit.partner) {
                lit.partner.attr('data-jack-lit', '')
            }
            traced++
        }
        if (traced) {
            self.addClass('mod-tracing')
        }
    },

    // Ends a trace. Sweeps rather than remembering what it lit, because a trace can cover
    // any number of cables, and because destroyJack calls this for a jack removed under
    // the pointer, which never gets a mouseleave of its own.
    clearTracing: function () {
        var self = $(this)
        self.find('[data-cable-lit]').removeAttr('data-cable-lit')
        self.find('[data-jack-lit]').removeAttr('data-jack-lit')
        self.find('[data-teleport-lit]').removeAttr('data-teleport-lit')
        self.removeClass('mod-tracing')
    },

    // A stereo pair running to a matching stereo pair is drawn as one cable that splits
    // into a Y at each end, rather than as two cables following the same route. Both
    // halves keep their own jack, canvas and host connection - only the paint is merged.
    // Returns false when this jack is not half of a mergeable pair, and the caller then
    // draws an ordinary cable.
    drawStereoJack: function (jack, force) {
        var self = $(this)
        var pair = self.pedalboard('stereoPartnerJack', jack)
        // The partner is still in the connection index between a disconnect and the host
        // confirming it, so its own connected flag is what says the pair is still whole
        if (! pair || ! pair.jack.data('connected')) {
            return false
        }
        // a merged pair is one cable running end to end, which a teleported cable is not.
        // the teleport key takes both halves together, so this normally sees both or neither
        if (jack.data('teleported') || pair.jack.data('teleported')) {
            return false
        }

        // The left half's canvas carries the whole cable and the right half's is emptied,
        // so redrawing either half on its own still leaves both of them right
        var left = pair.first ? jack : pair.jack
        var right = pair.first ? pair.jack : jack
        var rightSvg = right.data('svg')
        if (rightSvg) {
            rightSvg.clear()
        }
        right.data('canvas').removeClass('mod-stereo')

        var l = self.pedalboard('jackCoords', left, force)
        var r = self.pedalboard('jackCoords', right, force)
        self.pedalboard('drawStereoBezier', left.data('canvas'),
                        { x: l.xi, y: l.yi }, { x: r.xi, y: r.yi },
                        { x: l.xo, y: l.yo }, { x: r.xo, y: r.yo }, '')
        return true
    },

    // Draws a cable from jack's source (the output) to it's current position
    // Force parameter will force drawing when jack is disconnected
    drawJack: function (jack, force) {
        var self = $(this)
        // We used settimeout so that drawing will occur after all events are processed. This avoids some bad
        // user experience
        setTimeout(function () {
            var svg = jack.data('svg')
            if (!svg)
            // maybe jack has just been disconnected and so no drawing is necessary
                return

            svg.clear()

            // If this jack is not connected and
            if (!jack.data('connected') && !force)
                return

            // a teleported cable is drawn split, and never merged with a stereo partner:
            // a merged pair is one cable running end to end, which this no longer is
            if (jack.data('teleported') && self.pedalboard('drawTeleportJack', jack, force))
                return

            if (self.pedalboard('drawStereoJack', jack, force))
                return

            var c = self.pedalboard('jackCoords', jack, force)
            self.pedalboard('drawBezier', jack.data('canvas'), c.xi, c.yi, c.xo, c.yo, '')
        }, 0)
    },

    // A teleported cable is two short stubs rather than one long curve: out of the output
    // into its box, and out of the destination's box into the input. Straight lines --
    // over this distance a bezier is indistinguishable from one and costs more to read.
    drawTeleportBezier: function (canvas, outFrom, outTo, inFrom, inTo) {
        var svg = canvas.svg('get')
        if (! svg) {
            return
        }
        svg.clear()
        canvas.removeClass('mod-stereo')

        var parts = [['pathShadow', 'shadow'], ['pathCable', 'cable'], ['pathLight', 'light']]
        for (var i = 0; i < parts.length; i++) {
            var path = canvas.data(parts[i][0])
            path.reset()
            path.move(outFrom.x, outFrom.y).line(outTo.x, outTo.y)
            path.move(inFrom.x, inFrom.y).line(inTo.x, inTo.y)
            svg.path(null, path, { class_: parts[i][1] })
        }
    },

    // Resizes the labels from the teleport-label-scale preference. One stylesheet rule
    // rather than per-box, so it reaches boxes made later too. The numbers are
    // dashboard.css's at scale 1; box and text scale together.
    applyTeleportScale: function () {
        var self = $(this)
        var scale = 1
        if (typeof PREFERENCES !== 'undefined' && PREFERENCES['teleport-label-scale']) {
            var wanted = parseFloat(PREFERENCES['teleport-label-scale'])
            if (wanted > 0) {
                scale = wanted
            }
        }
        var sheet = $('#mod-teleport-scale')
        if (! sheet.length) {
            sheet = $('<style id="mod-teleport-scale">').appendTo('head')
        }
        sheet.text('.mod-teleport {' +
                   ' width: ' + Math.round(184 * scale) + 'px;' +
                   ' font-size: ' + Math.round(26 * scale) + 'px;' +
                   ' line-height: ' + Math.round(34 * scale) + 'px;' +
                   ' padding: ' + Math.round(2 * scale) + 'px ' + Math.round(8 * scale) + 'px;' +
                   ' }' +
                   // the count rides along, so it stays in proportion to the pile it counts
                   '.mod-teleport-badge {' +
                   ' font-size: ' + Math.round(22 * scale) + 'px;' +
                   ' line-height: ' + Math.round(32 * scale) + 'px;' +
                   ' padding: 0 ' + Math.round(10 * scale) + 'px;' +
                   ' border-radius: ' + Math.round(16 * scale) + 'px;' +
                   ' }')
        // the boxes just changed size, so where they are centred has moved; the next
        // redraw places them, and a resize is always followed by one
    },

    // Places both boxes and draws the two stubs between them and their ports. Returns
    // false when this jack should be drawn as an ordinary cable after all, which is what
    // happens if its output has somehow lost its name.
    drawTeleportJack: function (jack, force) {
        var self = $(this)
        var output = jack.data('origin')
        var input = jack.data('destination')
        var name = self.pedalboard('teleportName', output)
        if (! name || ! input) {
            return false
        }

        var c = self.pedalboard('jackCoords', jack, force)
        var outBox = self.pedalboard('teleportBox', 'out', output, name)
        var inBox = self.pedalboard('teleportBox', 'in', input, name)

        // xi,yi is the output end and xo,yo the input end, despite the letters
        var outX = c.xi + TELEPORT_STUB
        var inX = c.xo - TELEPORT_STUB

        // Both ends remember the output that owns the name. Hovering either box traces
        // from there, which is exactly the cables that box stands for -- tracing an input
        // box from its own port would drag in every other cable arriving at that input.
        outBox.data('sourcePort', output)
        inBox.data('sourcePort', output)

        self.pedalboard('placeTeleportBox', outBox, 'out', output, name, outX, c.yi)
        self.pedalboard('placeTeleportBox', inBox, 'in', input, name,
                        inX - inBox.outerWidth(), c.yo)

        // Only worth saying when the boxes are actually piled up: expanding the input fans
        // them onto their own cables, at which point you can see how many there are.
        var stacked = self.pedalboard('teleportsIntoPort', input)
        if (stacked > 1 && ! input.data('expanded')) {
            var badge = self.pedalboard('teleportBadge', input)
            badge.text('x' + stacked)
            badge.css({ left: inX - badge.outerWidth() - 3,
                        top: c.yo - inBox.outerHeight() / 2 - badge.outerHeight() / 2 })
        } else {
            var old = self.data('teleportBoxes')['badge ' + input.attr('mod-port')]
            if (old) {
                old.remove()
                delete self.data('teleportBoxes')['badge ' + input.attr('mod-port')]
            }
        }

        self.pedalboard('drawTeleportBezier', jack.data('canvas'),
                        { x: c.xi, y: c.yi }, { x: outX, y: c.yi },
                        { x: inX, y: c.yo }, { x: c.xo, y: c.yo })

        return true
    },

    placeTeleportBox: function (box, side, port, name, x, y) {
        // Centred on its own cable, always. Stacking boxes at a shared port offsets them
        // by a box height, which at larger sizes exceeds the gap between the cables and
        // walks each box off the one it belongs to. Expanding the input fans them apart.
        var h = box.outerHeight() || 42
        box.css({ left: x, top: y - h / 2 })
    },

    // One trunk with a Y at each end: out1 and out2 converge, run as a single cable, then
    // split again to in1 and in2. Same three stroked paths as drawBezier, so the cable,
    // shadow and light CSS is shared. Each point is an {x, y}.
    drawStereoBezier: function (canvas, out1, out2, in1, in2, stylePrefix) {
        var self = $(this)
        var svg = canvas.svg('get')
        if (!svg)
            return
        svg.clear()
        canvas.addClass('mod-stereo')

        // Where the two halves meet. Far enough clear of the ports that the split reads
        // as a split, and not as a kink in a cable that left at an angle
        var stub = 18
        var x1 = Math.max(out1.x, out2.x) + stub
        var y1 = (out1.y + out2.y) / 2
        var x2 = Math.min(in1.x, in2.x) - stub
        var y2 = (in1.y + in2.y) / 2

        var parts = [['pathShadow', 'shadow'], ['pathCable', 'cable'], ['pathLight', 'light']]
        var i

        // The trunk is the only part carrying both channels, so it is the only part drawn
        // as a stereo cable -- heavier, and striped.
        for (i = 0; i < parts.length; i++) {
            var trunk = canvas.data(parts[i][0])
            trunk.reset()
            self.pedalboard('cablePath', trunk, x1, y1, x2, y2, true)
            svg.path(null, trunk, { class_: stylePrefix + parts[i][1] + ' mod-trunk' })
        }

        // The four legs carry one channel each, so they are drawn as ordinary cable. They
        // are separate paths from the trunk so the stereo styling can skip them, and one
        // path per channel rather than one for all four so that hovering a jack can fade
        // the half that is not its own.
        var channels = [[out1, in1], [out2, in2]]
        for (i = 0; i < parts.length; i++) {
            for (var c = 0; c < channels.length; c++) {
                var legs = svg.createPath()
                legs.move(channels[c][0].x, channels[c][0].y).line(x1, y1)
                legs.move(x2, y2).line(channels[c][1].x, channels[c][1].y)
                svg.path(null, legs, { class_: stylePrefix + parts[i][1] + ' mod-leg-' + c })
            }
        }
    },

    drawBezier: function (canvas, xi, yi, xo, yo, stylePrefix) {
        var self = $(this)
        var svg = canvas.svg('get')
        if (!svg)
            return
        svg.clear()
        canvas.removeClass('mod-stereo')

        var pathS = canvas.data('pathShadow')
        var pathC = canvas.data('pathCable')
        var pathL = canvas.data('pathLight')

        pathS.reset()
        pathC.reset()
        pathL.reset()

        // the one being dragged keeps its curve, it has no cell to go to yet
        var routed = ! stylePrefix

        // Draw three lines following same path, one for shadow, one for cable and one for light
        // The recipe for a good cable is that shadow is wide and darke, cable is not so wide and not so dark,
        // and light is very thin and light.
        // Each has a different class, so it will be defined by CSS.
        svg.path(null,
            self.pedalboard('cablePath', pathS, xi, yi, xo, yo, routed), {
                class_: stylePrefix + 'shadow'
            }
        )
        svg.path(null,
            self.pedalboard('cablePath', pathC, xi, yi, xo, yo, routed), {
                class_: stylePrefix + 'cable'
            }
        )
        svg.path(null,
            self.pedalboard('cablePath', pathL, xi, yi, xo, yo, routed), {
                class_: stylePrefix + 'light'
            }
        )
    },

    // A cable from the output at (xi, yi) to the input at (xo, yo), into `path`. A bezier
    // curve, or in grid mode, when `routed`, along the gaps between the cells, see
    // gridCableCorners, its corners rounded off
    cablePath: function (path, xi, yi, xo, yo, routed) {
        var self = $(this)
        if (! routed || ! self.pedalboard('gridMode')) {
            var deltaX = cableDeltaX(xi, xo)
            return path.move(xi, yi).curveC(xo - deltaX, yi, xi + deltaX, yo, xo, yo)
        }
        var points = self.pedalboard('gridCableCorners', xi, yi, xo, yo)
        var radius = 40
        path.move(points[0].x, points[0].y)
        for (var i = 1; i < points.length - 1; i++) {
            var prev = points[i - 1], at = points[i], next = points[i + 1]
            var inLength = Math.abs(at.x - prev.x) + Math.abs(at.y - prev.y)
            var outLength = Math.abs(next.x - at.x) + Math.abs(next.y - at.y)
            var r = Math.min(radius, inLength / 2, outLength / 2)
            var toward = function (from, to, distance) {
                var length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y) || 1
                return { x: from.x + (to.x - from.x) * distance / length,
                         y: from.y + (to.y - from.y) * distance / length }
            }
            var before = toward(at, prev, r), after = toward(at, next, r)
            path.line(before.x, before.y).curveQ(at.x, at.y, after.x, after.y)
        }
        var last = points[points.length - 1]
        return path.line(last.x, last.y)
    },

    // The corners of a cable laid along the gaps between grid mode's cells, from (xi, yi)
    // to (xo, yo). It turns into the vertical gap at the edge of its plugin's cell right
    // away, runs to the gap along the row it goes to, across to the gap at the edge of
    // that row's cell, and into the input. Between neighbours that is just the gap
    // between them, and along a row with only free cells between it goes straight
    // across. A port outside the cells, on the board's edge, turns a little way off it.
    gridCableCorners: function (xi, yi, xo, yo) {
        var self = $(this)
        var W = PLACEMENT_CELL.width, H = PLACEMENT_CELL.height, stub = 30
        var from = self.pedalboard('cellAt', xi, yi)
        var to = self.pedalboard('cellAt', xo, yo)
        // a plugin's output is on its right, in its cell's right half, its input in the left
        var outGap = xi - from.col * W > W / 2 ? (from.col + 1) * W : xi + stub
        var inGap = xo - to.col * W < W / 2 ? to.col * W : xo - stub
        var start = { x: xi, y: yi }, end = { x: xo, y: yo }

        if (outGap == inGap) {
            return [start, { x: outGap, y: yi }, { x: outGap, y: yo }, end]
        }
        if (from.row == to.row && outGap < inGap) {
            var clear = true
            for (var col = from.col + 1; col < to.col; col++) {
                clear = clear && self.pedalboard('cellFree', { col: col, row: from.row })
            }
            if (clear) {
                return [start, { x: inGap, y: yi }, { x: inGap, y: yo }, end]
            }
        }
        // the gap along the row it goes to: on the side it comes from, below its own row
        // within the same row
        var gapY = to.row > from.row ? to.row * H : (to.row + 1) * H
        return [start, { x: outGap, y: yi }, { x: outGap, y: gapY },
                { x: inGap, y: gapY }, { x: inGap, y: yo }, end]
    },

    startConnection: function (output) {
        var self = $(this)
        if (self.data('ongoingConnection'))
            return
        self.pedalboard('clearTracing')
        var jack = output.find('[mod-role=output-jack]')
        var canvas = $('<div>')
        canvas.addClass('ignore-arrive')
        canvas.css({
            width: '100%',
            height: '100%',
            position: 'absolute',
            top: 0,
            left: 0
        })
        self.append(canvas)
        canvas.svg()
        var svg = canvas.find('svg')
        svg.css({
            width: '100%',
            height: '100%',
            position: 'absolute',
            top: 0,
            left: 0
        })

        svg = canvas.svg('get')
        canvas.data('pathShadow', svg.createPath())
        canvas.data('pathCable', svg.createPath())
        canvas.data('pathLight', svg.createPath())

        // in grid mode a tap in a plugin's cell ends the cable there, see cellTap,
        // anywhere else it drops it
        canvas.click(function (event) {
            var connection = self.data('ongoingConnection')
            if (! (self.pedalboard('gridMode') && self.pedalboard('cellTap', event, connection))) {
                self.pedalboard('finishConnection')
            }
            return false
        })
        var moveHandler = function (e) {
            if ($(e.target).is('input')) { // cv addressing input
              return
            }
            var scale = self.data('scale')
                // In iPad a tap will first trigger a mousemove event and, if no modifications are made, a click
                // event will be triggered. So, to capture a click we must schedule all actions in mousemove handler
            if (!self.data('ongoingConnection'))
            // a tap in ipad will cause this
                return
            setTimeout(function () {
                var xi = output.offset().left / scale - self.offset().left / scale
                var yi = output.offset().top / scale - self.offset().top / scale + output.height() * self.pedalboard('iconScale', output) / 2
                var xo = (e.pageX - self.offset().left) / scale
                var yo = (e.pageY - self.offset().top) / scale

                self.pedalboard('drawBezier', canvas, xi, yi, xo, yo, 'connecting-')
            }, 0)
        }
        var connection = {
            jack: jack,
            canvas: canvas,
            moveHandler: moveHandler,
        }
        self.bind('mousemove', moveHandler)
        self.data('ongoingConnection', connection)
        self.pedalboard('highlightInputs', true, jack)
        self.trigger('connectionstart', [self.pedalboard('connectionSource', output)])
    },

    // What a cable starting from `output` comes from, for the dock: { label, port, type,
    // thumbnail }, the thumbnail being for a plugin's output only, not the board's
    connectionSource: function (output) {
        var self = $(this)
        var port = output.attr('mod-port')
        var instance = port.substring(0, port.lastIndexOf('/'))
        var symbol = port.substring(port.lastIndexOf('/') + 1)
        var type = output.data('portType') || 'audio'
        var plugin = self.data('plugins')[instance]
        var gui = plugin && plugin.data && plugin.data('gui')
        if (! gui) {
            var label = output.closest('[title]').attr('title') || symbol
            return { label: label.replace(/^Hardware /, ''), port: '', type: type, thumbnail: null }
        }
        var effect = gui.effect
        var ports = plugin.data('ports')[type]
        var name = symbol
        $.each((ports && ports.output) || [], function (i, each) {
            if (each.symbol == symbol) {
                name = each.name || symbol
            }
        })
        var ver = [effect.builder, effect.microVersion, effect.minorVersion, effect.release].join('_')
        return {
            label: gui.label || effect.label || effect.name,
            port: name,
            type: type,
            thumbnail: effect.gui && effect.gui.thumbnail
                     ? '/effect/image/thumbnail.png?uri=' + escape(effect.uri) + '&v=' + ver
                     : '/resources/pedals/default-thumbnail.png'
        }
    },

    // The plugin in grid mode whose cell takes a tap at `event`, and the side of it the
    // tap is on: { instance, side }, the side being 'inputs' left of the plugin,
    // 'outputs' right of it, 'plugin' on it. Either side takes CELL_TAP_SIDE of the cell
    // at least, into a plugin as wide as that. Not within PLACEMENT_PAD of the cell's
    // border, nor in a cell with no plugin: null.
    cellZone: function (event) {
        var self = $(this)
        var scale = self.data('scale')
        var board = self[0].getBoundingClientRect()
        var x = (event.clientX - board.left) / scale
        var y = (event.clientY - board.top) / scale
        var cell = { col: Math.floor(x / PLACEMENT_CELL.width), row: Math.floor(y / PLACEMENT_CELL.height) }
        var rect = self.pedalboard('cellRect', cell)
        if (x < rect.x + PLACEMENT_PAD || x > rect.x + rect.width - PLACEMENT_PAD ||
            y < rect.y + PLACEMENT_PAD || y > rect.y + rect.height - PLACEMENT_PAD) {
            return null
        }
        var plugins = self.data('plugins')
        for (var instance in plugins) {
            var at = plugins[instance].data && plugins[instance].data('gridCell')
            if (! at || at.col != cell.col || at.row != cell.row) {
                continue
            }
            var body = plugins[instance][0].getBoundingClientRect()
            var left = Math.max(body.left, board.left + (rect.x + rect.width * CELL_TAP_SIDE) * scale)
            var right = Math.min(body.right, board.left + (rect.x + rect.width * (1 - CELL_TAP_SIDE)) * scale)
            return {
                instance: instance,
                side: event.clientX < left ? 'inputs' : event.clientX > right ? 'outputs' : 'plugin'
            }
        }
        return null
    },

    // A tap in grid mode in a plugin's cell, see cellZone: it ends `connection` in the
    // plugin, see connectToPlugin. With none, on the side of its outputs it starts a
    // cable from them, see connectFromOutputs, on the side of its inputs it shows the
    // cables into them, see showInputCables, and otherwise, or with no outputs or
    // cables there, it shows just the plugin. Whether it was in a plugin's cell.
    cellTap: function (event, connection) {
        var self = $(this)
        // the tail of a pan is not a tap
        if (Date.now() - (self.data('lastPanMove') || 0) < 300) {
            return false
        }
        var zone = self.pedalboard('cellZone', event)
        if (! zone) {
            return false
        }
        if (connection) {
            self.pedalboard('connectToPlugin', connection.jack, zone.instance)
            return true
        }
        if (zone.side == 'outputs' && self.pedalboard('connectFromOutputs', zone.instance)) {
            return true
        }
        if (zone.side == 'inputs' && self.pedalboard('showInputCables', zone.instance)) {
            return true
        }
        self.pedalboard('showPlugin', zone.instance)
        return true
    },

    // Starts a cable from the outputs of `instance`: from its only one, or from the one
    // picked in pickPort. Whether it has any.
    connectFromOutputs: function (instance) {
        var self = $(this)
        var origIndex = self.data('connectionManager').origIndex
        var outputs = []
        $.each(['audio', 'midi', 'cv'], function (i, type) {
            outputs = outputs.concat(self.pedalboard('wirePorts', instance, type).output)
        })
        if (! outputs.length) {
            return false
        }
        var start = function (port) {
            self.pedalboard('startConnection', self.find('[mod-port="' + port + '"]'))
        }
        if (outputs.length == 1) {
            start(outputs[0])
            return true
        }
        self.pedalboard('pickPort', instance, 'output', $.map(outputs, function (port) {
            return { port: port, connected: Object.keys(origIndex[port] || {}).length > 0 }
        }), start)
        return true
    },

    // The inputs of `instance` in pickPort, each with the cables coming into it to be
    // unplugged one by one. Whether there are any.
    showInputCables: function (instance) {
        var self = $(this)
        var destIndex = self.data('connectionManager').destIndex
        var inputs = []
        $.each(['audio', 'midi', 'cv'], function (i, type) {
            inputs = inputs.concat(self.pedalboard('wirePorts', instance, type).input)
        })
        var any = false
        var choices = $.map(inputs, function (input) {
            var cables = $.map(Object.keys(destIndex[input] || {}), function (from) {
                var source = self.pedalboard('connectionSource', self.find('[mod-port="' + from + '"]'))
                return { from: from, label: source.port ? source.label + ' · ' + source.port : source.label }
            })
            any = any || cables.length > 0
            return { port: input, connected: cables.length > 0, cables: cables }
        })
        if (! any) {
            return false
        }
        self.pedalboard('pickPort', instance, 'input', choices, null, function (from, to) {
            self.data('portDisconnect')(from, to, function () {})
        })
        return true
    },

    // Ends the cable being made from `jack` in `instance`: in its only input of the
    // cable's kind, or in the one picked in pickPort. Into the plugin it comes from it
    // does not go, nor into an input it already goes into, and with no input left it
    // says so
    connectToPlugin: function (jack, instance) {
        var self = $(this)
        var output = jack.data('origin')
        var port = output.attr('mod-port')
        var source = port.substring(0, port.lastIndexOf('/'))
        if (source == instance) {
            return
        }
        var type = output.data('portType')
        var destIndex = self.data('connectionManager').destIndex
        var inputs = self.pedalboard('wirePorts', instance, type).input
        var choices = $.map(inputs, function (input) {
            var from = Object.keys(destIndex[input] || {})
            return { port: input, connected: from.length > 0, disabled: from.indexOf(port) >= 0 }
        })
        var open = $.grep(choices, function (choice) {
            return ! choice.disabled
        })
        var connect = function (input) {
            self.pedalboard('do_connect', jack, self.find('[mod-port="' + input + '"]'))
        }
        if (choices.length > 1 && open.length) {
            self.pedalboard('pickPort', instance, 'input', choices, connect)
            return
        }
        if (open.length) {
            connect(open[0].port)
            return
        }
        var name = function (instance) {
            var plugin = self.data('plugins')[instance]
            var gui = plugin && plugin.data && plugin.data('gui')
            return gui ? (gui.label || gui.effect.label || gui.effect.name) : instance
        }
        new Notification('warning', inputs.length
                                    ? 'Every ' + type + ' input of ' + name(instance) + ' already comes from this output'
                                    : name(instance) + ' has no ' + type + ' input', 3000)
    },

    // Lets a tap pick one of the `ports` of `instance`, its outputs or inputs as `dir`
    // says, for `done`: an overlay by the plugin with their jacks spread out, each with
    // its name. Each choice is { port, connected, disabled, cables }; one that is
    // disabled is shown but cannot be picked. With no `done` none can, the overlay
    // being for the `cables` listed under each, { from, label }, which a tap on their
    // trash hands to `unplug`. A tap anywhere else closes it, picking nothing.
    pickPort: function (instance, dir, ports, done, unplug) {
        var self = $(this)
        var plugin = self.data('plugins')[instance]
        var all = plugin.data('ports')
        var gui = plugin.data('gui')
        var describe = function (port) {
            var symbol = port.substring(port.lastIndexOf('/') + 1)
            for (var type in all) {
                var list = (all[type] && all[type][dir]) || []
                for (var i = 0; i < list.length; i++) {
                    if (list[i].symbol == symbol) {
                        return { type: type, name: list[i].name || symbol }
                    }
                }
            }
            return { type: 'audio', name: symbol }
        }

        $('.mod-port-picker').remove()
        var overlay = $('<div class="mod-port-picker">').attr('data-touch-native', '').appendTo('body')
        var panel = $('<div class="mod-port-picker-panel">').addClass(dir).appendTo(overlay)
        $('<div class="mod-port-picker-title">')
            .text((gui ? (gui.label || gui.effect.label || gui.effect.name) : instance) +
                  (dir == 'output' ? ' outputs' : ' inputs'))
            .appendTo(panel)
        $.each(ports, function (i, choice) {
            var port = describe(choice.port)
            var row = $('<div class="mod-port-picker-port">')
                .addClass(port.type)
                .toggleClass('connected', !! choice.connected)
                .toggleClass('disabled', !! choice.disabled)
                .appendTo(panel)
            $('<div class="mod-port-picker-jack">').appendTo(row)
            $('<div class="mod-port-picker-name">').text(port.name).appendTo(row)
            if (done && ! choice.disabled) {
                row.on('click', function () {
                    overlay.remove()
                    done(choice.port)
                    return false
                })
            } else if (! done) {
                row.addClass('static')
            }
            $.each(choice.cables || [], function (j, cable) {
                var line = $('<div class="mod-port-picker-cable">').appendTo(panel)
                $('<div class="mod-port-picker-from">').text(cable.label).appendTo(line)
                $('<div class="mod-port-picker-unplug">').on('click', function () {
                    unplug(cable.from, choice.port)
                    line.remove()
                    if (! panel.find('.mod-port-picker-cable').length) {
                        overlay.remove()
                    }
                    return false
                }).appendTo(line)
            })
        })
        overlay.on('click', function (event) {
            if (! $(event.target).closest('.mod-port-picker-panel').length) {
                overlay.remove()
            }
            return false
        })

        // by the plugin: its outputs on its right, its inputs on its left, in the window
        var rect = plugin[0].getBoundingClientRect()
        var width = panel.outerWidth(), height = panel.outerHeight()
        var gap = 12
        var left = dir == 'output' ? rect.right + gap : rect.left - gap - width
        if (left + width > window.innerWidth - gap || left < gap) {
            left = dir == 'output' ? rect.left - gap - width : rect.right + gap
        }
        panel.css({
            left: Math.max(gap, Math.min(left, window.innerWidth - width - gap)),
            top: Math.max(gap, Math.min(rect.top + rect.height / 2 - height / 2,
                                        window.innerHeight - height - gap))
        })
    },

    finishConnection: function () {
        var self = $(this)
        var connection = self.data('ongoingConnection')
        if (!connection)
            return
        self.data('ongoingConnection', null)
        connection.canvas.remove()
        self.unbind('mousemove', connection.moveHandler)
        self.pedalboard('highlightInputs', false)
        self.trigger('connectionend')
    },

    do_connect: function (jack, input, overCount) {
        var self = $(this)
        var output = jack.data('origin')
        var previousInput = jack.data('destination')
        var pendingKey = output.attr('mod-port') + TELEPORT_ARROW + input.attr('mod-port')

        if (self.pedalboard('connected', output, input)) {
            // If this jack is already connected to this output, keep connection
            // This means user just took a connected jack, dragged around and dropped in the same input
            if (previousInput && input && previousInput[0] == input[0]) {
                jack.addClass('jack-connected')
                output.addClass('output-connected')
                output.removeClass('output-disconnected')
                output.removeClass('output-connecting')
                jack.data('canvas').addClass('cable-connected')
                jack.data('connected', true)
                input.addClass('input-connected')

                jack.css({
                    top: 'auto',
                    left: 'auto',
                    marginTop: 'auto',
                })

                // if jack input previous sibling has a margin-bottom,
                // adjust jack top position in accordance
                if (jack.data('destination') && jack.data('destination').prev() && jack.data('destination').prev().css('margin-bottom')) {
                  jack.css('top', parseInt(jack.css('top')) - parseInt(jack.data('destination').prev().css('margin-bottom')))
                }
            // If output is already connected to this input through another jack, abort connection
            } else {
                self.pedalboard('disconnect', jack)
                output.addClass('output-connected')
                output.removeClass('output-disconnected')
                output.removeClass('output-connecting')
            }
            return
        }

        // This jack was connected to some other input, let's disconnect it
        if (previousInput && overCount < 2) {
            // Re-routing keeps the teleport, and nothing else carries it across the gap:
            // the jack does not survive either, since the disconnect echo destroys it and
            // the connect echo picks up the output's SPARE jack. Parking the new pair keeps
            // the name and flags whichever jack ends up with the cable.
            if (jack.data('teleported')) {
                self.data('pendingTeleports')[pendingKey] = true
            }
            self.pedalboard('disconnect', jack)
            self.pedalboard('packJacks', previousInput)
        }

        self.data('portConnect')(output.attr('mod-port'), input.attr('mod-port'),
            function (ok) {
                if (!ok) {
                    // the connection was refused, so nothing will ever consume the parked
                    // teleport above -- drop it rather than let it wait for a load
                    delete self.data('pendingTeleports')[pendingKey]
                    self.pedalboard('disconnect', jack)
                }
            })
    },

    // Connects an output port to an input port.
    // The output is obtained from jack
    connect: function (jack, input, skipModified) {
        var self = $(this)
        var output = jack.data('origin')
        self.pedalboard('refreshPluginView')
        if (output == null) {
            console.log("ERROR: The origin for '" + jack.selector + "' is missing")
            return
        }

        // If output is already connected to this input through another jack, abort connection
        if (self.pedalboard('connected', output, input)) {
            self.pedalboard('disconnect', jack)
            output.addClass('output-connected')
            output.removeClass('output-disconnected')
            output.removeClass('output-connecting')
            return
        }

        // Can only ports if they are the same type
        if (input.data('portType') != output.data('portType')) {
            return self.pedalboard('disconnect', jack)
        }

        // Everything ok, let's do the connection
        self.pedalboard('finishConnection')

        // Register the connection in desktop structure
        self.data('connectionManager').connect(output.attr("mod-port"), input.attr("mod-port"), jack)

        // Register the connection in jack
        jack.data('destination', input)
        jack.data('connected', true)
        input.append(jack)

        // A teleport map that arrived before this connection existed (applyTeleports,
        // during a bundle load) left this cable here rather than forcing a retry loop.
        // Consumed the moment the cable it names actually shows up.
        var pendingTeleports = self.data('pendingTeleports')
        var pendingKey = output.attr('mod-port') + TELEPORT_ARROW + input.attr('mod-port')
        if (pendingTeleports && pendingTeleports[pendingKey]) {
            delete pendingTeleports[pendingKey]
            jack.data('teleported', true)
            if (skipModified) {
                // during a load: the map came from the server, posting it back is noise
                self.pedalboard('drawJack', jack)
            } else {
                // a re-route: the disconnect half of it posted a map without this cable,
                // so the server has to hear the finished pair or the next save loses it
                self.pedalboard('teleportsChanged', [jack])
            }
        }

        // Add status classes
        output.addClass('output-connected')
        output.removeClass('output-disconnected')
        output.removeClass('output-connecting')
        jack.addClass('jack-connected')
        jack.removeClass('jack-connecting')
        jack.removeClass('jack-disconnected')
        jack.data('canvas').addClass('cable-connected')

        // Redraw jack arrangement in both new and previous input, if any
        self.pedalboard('packJacks', input)
        self.pedalboard('spawnJack', output)

        if (! skipModified) {
            // Pedalboard has been modified
            self.trigger('modified')
        }

        // Do the connection in host. If there's a problem, undo the connection
        // It might be better to check first and then connect instead
        return
    },

    // Disconnect this jack
    // This will undo the connection made by this jack, if any,
    // destroy the jack and spawn a new one if necessary
    disconnect: function (jack) {
        var self = $(this)
        var connected = jack.data('connected')
        var input = jack.data('destination')
        var output = jack.data('origin')
        // Same as in destroyJack: the surviving half of a merged pair has to be repainted,
        // and the pair can only be found while this jack still counts as connected
        var pair = self.pedalboard('stereoPartnerJack', jack)

        if (connected) {
            self.data('portDisconnect')(output.attr('mod-port'), input.attr('mod-port'), function (ok) {})
            self.trigger('modified')

            var connMgr = self.data('connectionManager')
            var outport = output.attr('mod-port')
            if (connMgr.origIndex[outport] && Object.keys(connMgr.origIndex[outport]).length == 1) {
                output.addClass('output-disconnected')
                output.removeClass('output-connected')
            }

        } else {
            jack.css({
                top: 'auto',
                left: 'auto',
                marginTop: 'auto',
            })

            // if jack output previous sibling has a margin-bottom,
            // adjust jack top position in accordance
            if (jack.data('origin') && jack.data('origin').prev() && jack.data('origin').prev().css('margin-bottom')) {
              jack.css('top', parseInt(jack.css('top')) - parseInt(jack.data('origin').prev().css('margin-bottom')))
            }
        }

        jack.data('connected', false)
        // the lifetime rule: this cable no longer holds its output's name up
        self.pedalboard('teleportsChanged', [])

        if (pair) {
            self.pedalboard('drawJack', pair.jack)
        }
    },

    // Connect two ports using instance and symbol information.
    // Used for unserializing. We have to find the spare jack in output,
    // put it
    connectPorts: function (fromInstance, fromSymbol, toInstance, toSymbol) {},

    connected: function (output, input) {
        var self = $(this)
        return self.data('connectionManager').connected(output.attr("mod-port"), input.attr("mod-port"))
    },

    // Adjust layout of all jacks connected to this input to fit inside it
    packJacks: function (input) {
        var self = $(this)
        var jacks = input.find('[mod-role=output-jack]')
        var count = jacks.length
        var height = input.height() //(input.height() - 6 - count) / count
        jacks.height(height)
        jacks.width(input.width())

        if (count > 0) {
            input.addClass('input-connected')
            input.removeClass('input-disconnected')
        } else {
            input.removeClass('input-connected')
            input.addClass('input-disconnected')
        }

        jacks.each(function () {
            var jack = $(this)
            jack.css({
                top: 'auto',
                left: 'auto',
                marginTop: 'auto',
            })

            // if jack input previous sibling has a margin-bottom,
            // adjust jack top position in accordance
            if (jack.position().top !== 0 && jack.data('destination') && jack.data('destination').prev() && jack.data('destination').prev().css('margin-bottom')) {
              jack.css('top', parseInt(jack.css('top')) - parseInt(jack.data('destination').prev().css('margin-bottom')))
            }

            jack.draggable(count <= 1 ? 'enable' : 'disable')
            self.pedalboard('drawJack', jack)
        });

        if (input.data('expanded'))
            self.pedalboard('colapseInput', input)
    },

    // This expands/collapses an input that has sevel connected jacks
    expandInput: function (input) {
        var self = $(this)
        var jacks = input.find('[mod-role=output-jack]')
        if (jacks.length < 2 || input.data('expanded'))
            return
        var wrapper = $('<div class="mod-pedal-input-wrapper ignore-arrive">')
        //var arrow = $('<div class="mod-pedal-input-arrow ignore-arrive">').appendTo(wrapper)
        wrapper.appendTo(input)

        //arrow.css('top', wrapper.height() / 2 - 12)
        var jack
        var h = 0;
        for (var i = 0; i < jacks.length; i++) {
            jack = $(jacks[i]);
            h = jack.height();
            w = jack.width();
            jack.css({
                position: 'absolute',
                marginTop: (-jacks.length * h) / 2 + h / 2 + h * i,
            })
            h = jack.height();
            self.pedalboard('drawJack', jack)
            jack.draggable('enable')
        }

        wrapper.innerHeight(jacks.length * h);
        wrapper.css('top', (input.height() - wrapper.height()) / 2)
        wrapper.css("width", w);
        wrapper.click(function () {
            self.pedalboard('colapseInput', input)
            return false
        })
        input.addClass('expanded')
        input.data('expanded', true)
        input.data('wrapper', wrapper)
        self.pedalboard('colapseInput')
        self.data('expandedInput', input)
    },
    colapseInput: function (input) {
        var self = $(this)
        if (input == null)
            input = self.data('expandedInput')
        if (!input)
            return
        var jacks = input.find('[mod-role=output-jack]')
        var wrapper = input.data('wrapper')
        if (wrapper) {
            wrapper.remove()
            input.data('wrapper', null)
        }
        input.data('expanded', false)
        self.data('expandedInput', null)
        input.removeClass('expanded')
        self.pedalboard('packJacks', input)
    },

    setPluginPosition: function(instance, x, y) {
        var self = $(this)
        var plugins = self.data('plugins');
        var plugin = plugins[instance];
        // moved from another window: into the cell it was saved in, see savedCell
        if (self.pedalboard('gridMode') && plugin.data && plugin.data('gridCell')) {
            var cell = self.pedalboard('savedCell', x, y, plugin.width(), plugin.height())
            self.pedalboard('fitInCell', instance, plugin, self.pedalboard('nearestFreeCell', cell, instance), false)
            return
        }
        plugin.css({ top: y, left: x })
        self.pedalboard('fitToWindow')
        self.pedalboard('drawPluginJacks', plugin)
    },
})

// How far a teleport's stub runs from its port before it meets its box. Long enough to
// read as a cable going somewhere, short enough that it is not the thing you notice.
var TELEPORT_STUB = 44

// How much of a cell, from either side, is at least for the outputs or the inputs of its
// plugin when tapped in grid mode, even where the plugin is: see cellZone
var CELL_TAP_SIDE = 0.25

// The key that splits a cable into a teleport, and joins it back up. A single lower-case
// letter, matched case-insensitively with no modifier held. Named so a preference, if one
// is ever added, has one place to write to.
var TELEPORT_KEY = 's'

// The key that opens a vumeter for a cable, and closes it. A single lower-case letter,
// matched case-insensitively with no modifier held. Named so a preference, if one
// is ever added, has one place to write to.
var VUMETER_KEY = 'v'

// Horizontal pull on a cable's bezier control points. The numbers below were
// empirically obtained by trying several things. It gives us a pretty good result
function cableDeltaX(xi, xo) {
    var deltaX = xo - xi - 50
    if (deltaX < 0) {
        return 8.5 * (deltaX / 6) // ^ 0.8
    }
    return deltaX / 1.5
}

function ConnectionManager() {
    /*
     * Manages all connections in pedalboard.
     * Each connection is represented by 2 values:
     * origin port and destination port
     * Keeps two indexes, origIndex and destIndex, with jack objects in both.
     * The indexes are dicts that store each jack in path [port][port]
     */
    var self = this

    this.reset = function () {
        self.origIndex = {}
        self.destIndex = {}
        self.origByInstanceIndex = {}
        self.destByInstanceIndex = {}
    }

    this.reset()

    this._addToIndex = function (index, key1, key2, jack) {
        if(index[key1] == null)
            index[key1] = {}
        index[key1][key2] = jack
    }

    this._removeFromIndex = function (index, key1, key2) {
        if(index[key1] != null)
            delete index[key1][key2]
    }

    // Connects two ports
    this.connect = function (fromPort, toPort, jack) {
        self._addToIndex(self.origIndex, fromPort, toPort, jack)
        self._addToIndex(self.destIndex, toPort, fromPort, jack)

        // TODO: change the architecture so we don't need to keep this other index
        // and this 'system' HACK
        var instance = fromPort.substring(0, fromPort.lastIndexOf("/"))
        if (self.origByInstanceIndex[instance] == null)
            self.origByInstanceIndex[instance] = {}
        self._addToIndex(self.origByInstanceIndex[instance], fromPort, toPort, jack)

        instance = toPort.substring(0, toPort.lastIndexOf("/"))
        if (self.destByInstanceIndex[instance] == null)
            self.destByInstanceIndex[instance] = {}
        self._addToIndex(self.destByInstanceIndex[instance], toPort, fromPort, jack)
    }

    // Disconnects two ports
    this.disconnect = function (fromPort, toPort) {
        self._removeFromIndex(self.origIndex, fromPort, toPort)
        self._removeFromIndex(self.destIndex, toPort, fromPort)

        // TODO: change the architecture so we don't need to keep this other index
        // and this 'system' HACK
        var instance = fromPort.substring(0, fromPort.lastIndexOf("/"))
        if (self.origByInstanceIndex[instance] != null)
            self._removeFromIndex(self.origByInstanceIndex[instance], fromPort, toPort)

        instance = toPort.substring(0, toPort.lastIndexOf("/"))
        if (self.destByInstanceIndex[instance] != null)
            self._removeFromIndex(self.destByInstanceIndex[instance], toPort, fromPort)
    }

    // Checks if two ports are connected
    this.connected = function (fromPort, toPort) {
        try {
            return self.origIndex[fromPort][toPort] != null
        } catch (TypeError) {
            return false
        }
    }

    // Execute callback for all connections, passing jack as parameter
    this.iterate = function (callback) {
        for (var key1 in self.origIndex)
            for (var key2 in self.origIndex[key1])
                callback(self.origIndex[key1][key2])
    }

    // Execute callback for each connection of a given instance, passing jack as parameter
    this.iterateInstance = function (instance, callback) {
        if (self.origByInstanceIndex[instance] != null)
            for (var key1 in self.origByInstanceIndex[instance])
                for (var key2 in self.origByInstanceIndex[instance][key1])
                    callback(self.origByInstanceIndex[instance][key1][key2])
        if (self.destByInstanceIndex[instance] != null)
            for (var key1 in self.destByInstanceIndex[instance])
                for (var key2 in self.destByInstanceIndex[instance][key1])
                    callback(self.destByInstanceIndex[instance][key1][key2])
    }

    this.removeInstance = function (instance) {
        for (var port in self.origByInstanceIndex[instance]) {
            delete self.origIndex[port]
            for (var ins in self.destByInstanceIndex)
                for (var obiport in self.destByInstanceIndex[ins])
                    delete self.destByInstanceIndex[ins][obiport][port]
            for (var oport in self.destIndex)
                delete self.destIndex[oport][port]
        }

        for (var port in self.destByInstanceIndex[instance]) {
            delete self.destIndex[port]
            for (var ins in self.origByInstanceIndex)
                for (var dbiport in self.origByInstanceIndex[ins])
                    delete self.origByInstanceIndex[ins][dbiport][port]
            for (var dport in self.origIndex)
                delete self.origIndex[dport][port]
        }

        delete self.origByInstanceIndex[instance]
        delete self.destByInstanceIndex[instance]
    }
}


function T3KIntegration(pedalboard, pubKey) {
    /*
     * Handle Tone3000 integration
     *
     * Terminology:
     *
     * CLIENT: is the javascript mod UI that runs in the browser
     * SERVER: is the python mod server that runs in the unit (dwarf)
     * T3K: is the Tone3000 remote REST api
     *
     * Flow:
     *
     * 1. The CLIENT start the select tone flow using the T3K API
     * 2. T3K callback the python SERVER when a tone is selected or the popup is closed
     * 3. The SERVER callback the CLIENT to inform the tone selection is done using the websocket connection using the command 't3k-tone-selected' or 't3k-cancel'
     * 4. The CLIENT exchange the code with an auth token using T3K API
     * 5. The CLIENT call the T3K to fetch the tones and upload to the SERVER
     *
     */
    const self = this
    let t3kOpenPopups = []

    this.pedalboard = pedalboard
    /*
     * Find ongoing t3k state by effect.
     *
     * Returns the popup window or undefined
     */
    const findInfoByEffect = function(effect) {
        for(let item of t3kOpenPopups) {
            if (item.effect === effect) {
                return item
            }
        }

        return undefined
    }

    /*
     * Delete the effect from the list of monitored effects
     */
    const deleteEffectPopup = function(effect) {
        t3kOpenPopups = t3kOpenPopups.filter(item => item.effect != effect)
    }

    this.startSelectFlow = function(effect, parameter, skipAuthCheck) {
        const hasApiKey = pubKey && pubKey.length > 0

        if (!skipAuthCheck || !hasApiKey) {
            let authenticated = false
            if (hasApiKey) {
                    // check if I'm authenticated
                    const auth = window.Tone3000Client.getTokens()
                    if (auth != null) {
                        // note that this call is sync
                        $.ajax({
                        url: `https://www.tone3000.com/api/v1/user`,
                        type: 'GET',
                        async: false,
                        headers: {
                            'Authorization': 'Bearer ' + auth.tokens.access_token
                        },
                        success: function (tone) {
                            authenticated = true
                        },
                        error: function(xhr, status, error) {
                            console.error("AJAX Error:", status, error);
                        }
                    })
                }
            }

            if (!authenticated || !hasApiKey) {
                // if not authenticated show the T3K welcome
                const width = 480;
                const height = 720;
                const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
                const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
                let url = "/t3ksplash.html?v=" + VERSION
                const t3kwelcome = window.open(url, 't3k_select', `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no,resizable=yes,scrollbars=yes`);
                // Register the continuation on the opener (us), where the splash can
                // reach it via window.opener. Setting it on the popup directly loses the
                // race with the popup's document load on first open.
                window.onT3KSplashContinue = function() {
                    // continue with the select workflow skipAuthCheck = true
                    if (hasApiKey) {
                        self.startSelectFlow(effect, parameter, true)
                    }
                }
                try { t3kwelcome.onSplashContinue = window.onT3KSplashContinue } catch (e) {}

                return // stop now because we have shown the splash window
            }
        }

        // start the select workflow
        const callbackUrl = window.location.origin + '/effect/t3k/select' + effect
        // Restrict Tone3000's browser by model FORMAT, not by gear type: a `gears` filter is
        // locked in Tone3000's UI (the user cannot narrow it to, say, amp heads), while `format`
        // only hides files this port cannot load and leaves the gear filters free.
        // Tone3000 formats: nam for NAM captures (amps, pedals, amps+cabs, outboard), ir for cabinets.
        const options = {
            menubar: true,
            //loginHint: string,
            preview: true
        }
        if (parameter.fileTypes.indexOf('nammodel') >= 0) {
            options.format = 'nam'
            options.architecture = 2 // NAM A2; without it Tone3000 hides A2-only tones
        } else {
            options.format = 'ir'
        }
        window.Tone3000Client
            .startSelectFlowPopup(pubKey, callbackUrl, options)
            .then((data) => {
                // add the popup to the traked popups
                t3kOpenPopups.push({effect: effect, parameter: parameter, popup: data})
            })
            .catch((error) => {
                // the popup is tracked only on success, nothing to clean up here
                new Notification('error', 'Error opening Tone3000.')
                console.error("T3KSelect error:", error);
            })
    }

    this.refreshPluginsFilelist = function(senderEffect, senderParameter, senderSetValue) {
        const plugins = self.pedalboard.data('plugins')
        // the requesting plugin may have been removed while the download ran
        for(let pluginKey in plugins) {
            // refresh the file lists
            const plugin = plugins[pluginKey]
            const pluginGui = plugin.data('gui')

            pluginGui?.effect?.parameters?.forEach(parameter => {
                // we need to refresh a plugin parameter if it has the same filetype of the senderParameter
                if (parameter.fileTypes && senderParameter.fileTypes.some(item => parameter.fileTypes.includes(item))) {
                    pluginGui.refreshPluginFileListParameter(pluginKey, parameter, (pluginKey == senderEffect ? senderSetValue?.fullname : undefined))
                }
            });
        }
    }

    this.getToneInfo = async function (access_token, toneId) {
        try {
            const tone = await $.ajax({
                url: 'https://www.tone3000.com/api/v1/tones/' + toneId,
                type: 'GET',
                headers: {
                    'Authorization': 'Bearer ' + access_token
                },
                cache: false,
                dataType: 'json'
            })

            return tone
        } catch (error) {
            throw new Error(`Error downloading the tone metadata: ${error}`)
        }
    }

    /*
     * Get the tone models from T3K
     */
    this.getModels = async function (access_token, tone) {
        // now fetch the models
        try {
            let models = []
            const pageSize = 50
            let page = 1
            let total = 1

            let baseurl = `https://www.tone3000.com/api/v1/models?tone_id=${tone.id}`
            if (tone.a2_models_count > 0)
                baseurl += '&architecture=2'

            while (models.length < total) {
                const pageModels = await $.ajax({
                    url: `${baseurl}&page=${page}&page_size=${pageSize}`,
                    headers: {
                        'Authorization': 'Bearer ' + access_token
                    },
                    cache: false,
                    dataType: 'json'
                })

                if (!pageModels.data || pageModels.data.length == 0)
                    throw new Error('no models on data')
                models = models.concat(pageModels.data)
                total = pageModels.total
                page += 1
            }
            return models
        } catch (error) {
            throw new Error(`Error downloading the tone models metadata: ${error}`)
        }
    }

    /*
     * The tone description cut to a few sentences, for the file metadata
     */
    const shortDescription = function (description, maxLength = 300) {
        const text = (description || '').replace(/\s+/g, ' ').trim()
        return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + '…' : text
    }

    /*
     * This function download the models files and upload to the device using the file upload api
     */
    this.downloadModelsFiles = async function (access_token, tone, models, progressFunc) {
        try {
            const total = models.length
            const files = []
            let current = 0
            let directory = total > 1 ? tone.title : "" // do not place in a subfolder if it's just one file

            progressFunc?.(null, 0, total)
            for(const model of models) {
                current += 1
                progressFunc?.(model, current, total)
                const url = new URL(model.model_url);
                const tmpFilename = url.pathname.split('/').pop();
                const fileExtension = tmpFilename.split('.').pop();
                let fileName = (total > 1 ? model.name : tone.title)
                let filetype

                if (tone.gear == 'cab') {
                    filetype = 'cabsim'
                } else if (tone.gear == 'space') {
                    filetype = 'ir'
                } else {
                    filetype = 'nammodel'
                }
                const uploadConfig = {
                    directory: directory,
                    onDirectoryConflict: current == 1 ? 'rename' : 'merge', // rename directory if exists, the file is always renamed on conflict
                    filename: (fileName + (fileExtension ? '.' + fileExtension : '')).trim(),
                    filetype: filetype,
                    metadata: {
                        source: 'T3K',
                        // one sidecar per download: next to the file, or inside the folder
                        // of a many files tone, where the server collects every models entry
                        data: {
                            toneId: tone.id,
                            // enough to show the tone and its license without asking Tone3000
                            title: tone.title,
                            // short: it travels in the X-Upload-Config header
                            description: shortDescription(tone.description),
                            author: tone.user?.display_name || tone.user?.username,
                            url: tone.url,
                            image: tone.images?.[0],
                            // amp, amp-cab, pedal, outboard, cab, space...: an amp needs a cab
                            gear: tone.gear == 'full-rig' ? 'amp-cab' : tone.gear, // full-rig is the deprecated amp-cab
                            format: tone.format, // nam, ir
                            license: tone.license,
                            models: [{
                                modelId: model.id,
                                name: model.name,
                                size: model.size,
                                architecture: model.architecture_version,
                                updatedAt: model.updated_at
                            }]
                        }
                    }
                }

                const response = await new Promise((resolve, reject) => {
                    var transfer = new SimpleTransference(
                                        model.model_url,
                                        '/files/upload',
                                        {
                                            from_args: {
                                                headers: { 'Authorization': 'Bearer ' + access_token }
                                            },
                                            to_args: {
                                                headers: {
                                                    'Authorization' : 'MOD ' + desktop.cloudAccessToken,
                                                    'X-Upload-Config': encodeURIComponent(JSON.stringify(uploadConfig))
                                                }
                                            }
                                        })

                    transfer.reauthorizeUpload = desktop.authenticateDevice

                    transfer.reportFinished = function (resp2) {
                        resolve(resp2)
                    }

                    transfer.reportError = function (error) {
                    reject(new Error(error))
                    }

                    transfer.start()
                })

                if (!response.ok)
                    throw new Error(model.name)

                if (current == 1) // place all the other files in the same directory (the server can rename the directory to not overwrite files)
                    directory = response.result.dirname

                files.push(response.result)
            }

            return files
        } catch (error) {
            throw new Error(`Error downloading the tone models file: ${error}`)
        }
    }

    /*
     * This function is called on tone selection (3)
     */
    this.t3kToneSelected = function(effect, code, state, toneId) {
        // Select Flow — user browses TONE3000 and picks a tone
        // Optional: gears, platform, architecture, menubar (same query params as authorize URL)
        // console.log(`t3k cancel instance ${effect}, code ${code}, state ${state}, toneId ${toneId}`)
        const cleanup = function(t3kinfo) {
            t3kinfo.popup.location = 'about:blank'
            t3kinfo.popup.close()
            deleteEffectPopup(t3kinfo.effect)
        }
        const onError = function(t3kinfo, error) {
            cleanup(t3kinfo)
            new Notification('error', 'Error downloading from Tone3000.')
            console.error(`t3kToneSelected status error: ${error} `);
        }
        const t3kinfo = findInfoByEffect(effect)

        // check if we have a popup registered
        if (!t3kinfo) {
            console.error(`t3kToneSelected t3kinfo for instance ${effect} can't download models`)
            return
        }

        t3kinfo.state = 'downloading'
        t3kinfo.popup.location = "/t3k.html?v=" + VERSION

        // must match the callbackUrl of the request we need to exchange the code for
        const callbackUrl = window.location.origin + '/effect/t3k/select' + effect
        // start the download
        const t3kClient = window.Tone3000Client

        t3kClient
            .exchangeCode(pubKey, callbackUrl, code, state)
            .then((auth) => {
                if (auth?.ok) {
                    // fetching the tone info
                    t3kClient.setTokens(auth)
                    self
                        .getToneInfo(auth.tokens.access_token, toneId)
                        .then((tone) => {
                            // update the popup with the info of the tone
                            const title = tone.title
                            const des = tone.description
                            const user = tone.user?.display_name
                            const image = tone.images?.[0]

                            t3kinfo.popup?.setToneInfo?.(user, title, des, image)
                            self
                                .getModels(auth.tokens.access_token, tone)
                                .then((models) => {
                                    // download models and store on the dwarf user files
                                    self
                                        .downloadModelsFiles(auth.tokens.access_token, tone, models, function(model, current, count) {
                                            const msg = `Downloading files ${current}/${count}...`
                                            const perc = Math.round(current / Math.max(1, count) * 100)
                                            t3kinfo.popup?.progress?.(msg, perc)
                                        })
                                        .then((files) => {
                                            // refresh the file lists and load the first downloaded
                                            // file (alphabetical) into the requesting plugin
                                            let setValue = undefined
                                            if (files && files.length > 0) {
                                                files.sort((a, b) =>  a.fullname.localeCompare(b.fullname))
                                                setValue = files[0]
                                            }
                                            self.refreshPluginsFilelist(effect, t3kinfo.parameter, setValue)
                                            cleanup(t3kinfo)
                                            new Notification('info', 'Download from Tone3000 completed.', 2000)
                                        })
                                        .catch((errDownloadModels) => {
                                            onError(t3kinfo, errDownloadModels)
                                        })
                                })
                                .catch((errFetchModels) => {
                                    onError(t3kinfo, errFetchModels)
                                })

                        })
                        .catch((errTone) => {
                            onError(t3kinfo, errTone)
                        })
                }
            })
            .catch((error) => {
                onError(t3kinfo, error)
            })
    }

    /*
     * This function is called on tone selection (3)
     */
    this.t3kCancel = function(instance) {
        console.log("t3k cancel " + instance)
        const t3kinfo = findInfoByEffect(instance)

        // check if we have a popup registered
        if (t3kinfo) {
            deleteEffectPopup(instance)
            t3kinfo.popup?.close()
        } else {
            console.error(`t3kCancel no popup for instance ${instance} can't download models`)
            return
        }
    }

    /*
     * Update the popup UI with the progress of the
     * (download) current operation
     */
    this.t3kProgress = function(instance, msg, progress) {
        const t3kinfo = findInfoByEffect(instance)

        t3kinfo?.popup?.progress?.(msg, progress)
    }
}