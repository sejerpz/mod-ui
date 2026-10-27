// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grid mode's application bar, a dock floating at the bottom center of the screen,
// where a thumb reaches on a tablet. It takes the place of the top and bottom bars,
// which are hidden: the menu, the constructor and performance switch, the snapshots,
// the A/B comparer, saving the pedalboard and adding a plugin are on it, and the menu
// leads to everything else the bars had.
// Every button drives the element that already does the job, so the app's own state
// and handlers stay where they are.

// How long a press on the A/B button lasts before it brings up the whole comparer, in ms
var AB_LONG_PRESS = 500

JqueryClass('appBar', {
    init: function (options) {
        var self = $(this)

        self.addClass('mod-app-bar')
        $('body').addClass('app-bar-mode')

        // The page itself never zooms: a double tap used to zoom it in with no way back,
        // since the board takes pinches for its own zoom. Laid out at least 980 wide, as
        // mobile browsers do with no viewport given, which the dock fits in: narrower
        // screens show it smaller, wider ones at their own width rather than enlarged,
        // which also kept Firefox's touch simulation from landing taps outside the page.
        // Again whenever the screen turns
        var viewport = $('meta[name=viewport]')
        if (! viewport.length) {
            viewport = $('<meta name="viewport">').appendTo('head')
        }
        var fitViewport = function () {
            var landscape = window.matchMedia('(orientation: landscape)').matches
            var across = landscape ? Math.max(screen.width, screen.height)
                                   : Math.min(screen.width, screen.height)
            var content = across >= 980 ? 'width=device-width, initial-scale=1, user-scalable=no'
                                        : 'width=980, user-scalable=no'
            if (viewport.attr('content') != content) {
                viewport.attr('content', content)
            }
        }
        fitViewport()
        $(window).on('orientationchange resize', fitViewport)

        // A phone, by the short side of its screen, which the page's 980 wide layout does
        // not change, for what a phone's screen is too small for. A screen of no known
        // size is not one
        var side = Math.min(screen.width, screen.height)
        $('body').toggleClass('phone', side > 0 && side < 600)

        // A button opening a menu upwards. `sections` are lists of [label, element]
        // pairs, the element being clicked when its label is, each list under its title
        // if it has one. Any other tap closes the menu. Each element keeps its entry,
        // as data('appBarItem')
        var popups = $()
        var popup = function (name, label, sections) {
            var holder = $('<div class="popup">').addClass(name)
            var menu = $('<div class="menu">').appendTo(holder)
            $.each(sections, function (i, section) {
                var column = $('<div class="section">').appendTo(menu)
                if (section.title) {
                    $('<div class="title">').text(section.title).appendTo(column)
                }
                var list = $('<ul>').appendTo(column)
                $.each(section.items, function (j, item) {
                    var entry = $('<li>').text(item[0]).click(function () {
                        holder.removeClass('open')
                        item[1].click()
                        return false
                    }).appendTo(list)
                    item[1].data('appBarItem', entry)
                })
            })
            $('<div class="toggle">').text(label).click(function () {
                popups.not(holder).removeClass('open')
                holder.toggleClass('open')
                return false
            }).appendTo(holder)
            popups = popups.add(holder)
            return holder
        }
        $(document).on('click', function (e) {
            popups.each(function () {
                if (! $.contains(this, e.target)) {
                    $(this).removeClass('open')
                }
            })
        })

        // The dock's states, which fold parts of it away, see dashboard.css: adding a
        // plugin, performing, elsewhere. It changes size by animating those parts in and
        // out, which clip what they hold for as long as they move: not longer, or the
        // menus opening above them would be cut too.
        var moving = null
        var setState = function (name, on) {
            if (self.hasClass(name) == on) {
                return
            }
            popups.removeClass('open')
            self.addClass('folded').toggleClass(name, on)
            clearTimeout(moving)
            moving = setTimeout(function () {
                self.removeClass('folded')
            }, 300)
        }

        // the gateway to whatever the hidden bars had and the dock has no room for
        popup('main', 'Menu', options.menu).appendTo(self)

        // CV ports is a mode rather than a place: it shows a box on every plugin's CV
        // output, which offers it to the bindings. Its entry is ticked while it is on,
        // and turning it on says so, or that there is no CV output on the board to show.
        // After the bar's own handler, which switches it
        options.cvToggle.click(function () {
            var on = options.cvToggle.hasClass('selected')
            var entry = options.cvToggle.data('appBarItem')
            entry && entry.toggleClass('checked', on)
            if (on && $('.output-cv-checkbox').length) {
                new Notification('info', "Tick a plugin's CV output to use it in the bindings", 4000)
            } else if (on) {
                new Notification('warning', 'No plugin on this pedalboard has CV outputs', 4000)
            }
        })

        // Edit is the constructor, Live the performance view: two states of one switch.
        // Going from one to the other fades the one out and then the other in: the
        // board, then the performance view as it opens, or the performance view, then
        // the board once it has closed. Animated from script, which starts over every
        // time, where an animation set by a class may not
        var FADE = 250
        // `done` once it has, or a little later at the latest: a page in the background
        // does not run animations, and the switch must still happen
        var fade = function (element, from, to, done) {
            var finished = false
            var finish = function () {
                if (! finished) {
                    finished = true
                    done && done()
                    animation && animation.cancel()
                }
            }
            var animation = element[0].animate && element[0].animate([{ opacity: from }, { opacity: to }],
                                                                     { duration: FADE, easing: 'ease', fill: 'forwards' })
            if (animation) {
                animation.onfinish = finish
            }
            setTimeout(finish, animation ? FADE + 100 : 0)
        }
        // The board stays faded out (by its style, once its animation is over) for as
        // long as the performance view is fading in or out over it
        var board = options.pedalboard.parent()
        var boardIn = function () {
            fade(board, 0, 1, function () {
                board.css('opacity', '')
            })
        }
        var switching = false
        var mode = $('<div class="mode">').appendTo(self)
        var edit = $('<div class="segment">').text('Edit').click(function () {
            var view = options.performanceBox
            if (switching) {
                return
            }
            if (options.places.filter(':visible').length) {
                options.constructorTrigger.click()
                boardIn()
                return
            }
            if (! view.is(':visible')) {
                return
            }
            switching = true
            edit.addClass('selected')
            live.removeClass('selected')
            board.css('opacity', 0)
            fade(view, 1, 0, function () {
                switching = false
                options.constructorTrigger.click()
                boardIn()
            })
        }).appendTo(mode)
        var live = $('<div class="segment">').text('Live').click(function () {
            var view = options.performanceBox
            if (switching || view.is(':visible')) {
                return
            }
            // from one of the places the menu leads to, the board is not showing
            if (options.places.filter(':visible').length) {
                options.performanceTrigger.click()
                return
            }
            switching = true
            edit.removeClass('selected')
            live.addClass('selected')
            fade(board, 1, 0, function () {
                board.css('opacity', 0)
                switching = false
                options.performanceTrigger.click()
            })
        }).appendTo(mode)
        // In one of the places the menu leads to, like the plugin store, the board and
        // its tools are not there: the dock folds down to the way back to the board, the
        // menu being only there
        $('<div>').text('‹ Back').click(function () {
            edit.click()
        }).appendTo($('<div class="back">').appendTo(self))
        var showMode = function () {
            var elsewhere = options.places.filter(':visible').length > 0
            var performing = ! elsewhere && options.performanceBox.is(':visible')
            edit.toggleClass('selected', ! elsewhere && ! performing)
            live.toggleClass('selected', performing)
            setState('performing', performing)
            setState('elsewhere', elsewhere)
        }
        options.performanceBox.add(options.places).on('windowopen windowclose', showMode)
        options.performanceBox.on('windowopen', function () {
            fade(options.performanceBox, 0, 1, function () {
                board.css('opacity', '')
            })
        })
        showMode()

        // The performance view's own actions, from its header: the switch into arranging
        // it, and while arranging, the filter of what it shows and saving. Shown in the
        // dock while performing, in place of the board's tools but the A/B comparer.
        // Arranging, the dock has just the filter, Cancel and Save, both of which end
        // it. Cancel puts back the plugins' order, visibility and names as they were:
        // each change reached the host as it was made, so it is undone the same way
        var perf = $('<div class="perf">').append(options.performanceActions).appendTo(self)
        var design = options.performanceActions.find('.js-settings')
        var saveLayout = options.performanceActions.find('.js-save')
        var guis = function () {
            return $.map(options.pedalboard.data('plugins'), function (plugin) {
                return plugin.data && plugin.data('gui') || null
            })
        }
        var before = null
        design.click(function () {
            var arranging = !! options.performanceBox.data('inDesign')
            before = arranging ? $.map(guis(), function (gui) {
                var performance = gui.getPerformanceOptions()
                return { gui: gui, index: performance.index, visible: performance.visible, label: gui.label }
            }) : null
            setState('arranging', arranging)
        })
        $('<button class="js-cancel">').text('Cancel').click(function () {
            $.each(before || [], function (i, was) {
                var performance = was.gui.getPerformanceOptions()
                if (performance.index != was.index) {
                    performance.index = was.index
                    options.pedalboard.data('performancePluginIndexSet')(was.gui.instance, was.index)
                }
                if (performance.visible != was.visible) {
                    performance.visible = was.visible
                    options.pedalboard.data('performancePluginVisibilitySet')(was.gui.instance, was.visible)
                }
                if (was.gui.label != was.label) {
                    was.gui.setLabel(was.label || '')
                }
            })
            design.click()
        }).insertBefore(saveLayout)
        // after the view's own handler, which saves
        saveLayout.click(function () {
            design.click()
        })

        var tools = $('<div class="tools">').appendTo(self)

        // the header's snapshots menu
        popup('snapshots', 'Snapshots', [{ items: [
            ['Save', options.snapshotSaveButton],
            ['Save as', options.snapshotSaveAsButton],
            ['Load / Manage', options.snapshotManageButton],
        ]}]).appendTo(tools)

        // The snapshot dialogs take the room the dock would cover: it slides away while
        // one is up. They open and close with show() and hide(), whatever opened them,
        // and so do the plugins' CPU usage, see below, and the MIDI ports. So do the
        // bindings and the CV ports, which are added to the page while open, and the
        // windows of a plugin the board shows alone, see below
        var dialogs = $()
        var shown = options.snapshotDialogs.add(options.cpuLoadWindow).add(options.midiPortsWindow)
        var makeRoom = function () {
            self.toggleClass('away', shown.filter(':visible').length > 0 ||
                                     $('body > .mod-pedal-settings-address').length > 0 ||
                                     dialogs.length > 0)
        }
        shown.each(function () {
            new MutationObserver(makeRoom).observe(this, {
                attributes: true,
                attributeFilter: ['style', 'class']
            })
        })
        new MutationObserver(makeRoom).observe(document.body, { childList: true })

        // The A/B comparer as one button: A/B, on black, until there is a snapshot to
        // compare with. A tap takes one, which goes to B, and from then on switches
        // between A and B. A long press, or a double tap, brings up the whole comparer
        // above it, the way to take a new snapshot. A tap waits briefly for a second
        // one, or a double tap would switch there and back first
        var compareA = options.abCompare.find('.js-ab-compare-snapshot-a')
        var compareB = options.abCompare.find('.js-ab-compare-snapshot-b')
        var compareTake = options.abCompare.find('.js-ab-compare-snapshot-take')
        // 'A' or 'B' as selected, 'init' with a snapshot but neither, null with none
        var compared = function () {
            if (compareA.hasClass('js-ab-compare-snapshot-selected')) {
                return 'A'
            }
            if (compareB.hasClass('js-ab-compare-snapshot-selected')) {
                return 'B'
            }
            return compareA.hasClass('js-ab-compare-snapshot-disabled') ? null : 'init'
        }
        var ab = $('<div class="popup ab">').appendTo(tools)
        $('<div class="menu">').append(options.abCompare).appendTo(ab)
        popups = popups.add(ab)
        var abTapped = null
        // the long press, and whether the tap it ends in is its own
        var abPress = null, abPressedAt = null, abLongPressed = false
        var abOpen = function () {
            popups.not(ab).removeClass('open')
            ab.toggleClass('open')
        }
        var abButton = $('<div class="toggle">').click(function () {
            if (abLongPressed) {
                abLongPressed = false
                return false
            }
            if (abTapped) {
                clearTimeout(abTapped)
                abTapped = null
                abOpen()
                return false
            }
            abTapped = setTimeout(function () {
                abTapped = null
                var status = compared()
                if (! status) {
                    compareTake.click()
                } else {
                    (status == 'B' ? compareA : compareB).click()
                }
            }, 300)
            return false
        }).appendTo(ab)
        var abRelease = function () {
            clearTimeout(abPress)
            abPress = null
        }
        abButton.on('pointerdown', function (e) {
            abLongPressed = false
            abPressedAt = { x: e.originalEvent.clientX, y: e.originalEvent.clientY }
            abRelease()
            abPress = setTimeout(function () {
                abPress = null
                abLongPressed = true
                clearTimeout(abTapped)
                abTapped = null
                abOpen()
            }, AB_LONG_PRESS)
        }).on('pointermove', function (e) {
            // a finger that wanders off is not pressing
            if (abPress && (Math.abs(e.originalEvent.clientX - abPressedAt.x) > 10 ||
                            Math.abs(e.originalEvent.clientY - abPressedAt.y) > 10)) {
                abRelease()
            }
        }).on('pointerup pointercancel', abRelease)
        // nor does the browser's own menu for a long press come up
        .on('contextmenu', false)
        var showCompared = function () {
            var status = compared()
            abButton.text(status == 'A' || status == 'B' ? status : 'A/B')
                .removeClass('compare-none compare-init compare-a compare-b')
                .addClass('compare-' + (status || 'none').toLowerCase())
        }
        compareA.add(compareB).each(function () {
            new MutationObserver(showCompared).observe(this, {
                attributes: true,
                attributeFilter: ['class']
            })
        })
        showCompared()

        // the header's save marks unsaved changes as 'unmodified-changes'
        var save = $('<div class="save">').text('Save').click(function () {
            options.saveButton.click()
        }).appendTo(tools)
        var showModified = function () {
            save.toggleClass('modified', options.saveButton.hasClass('unmodified-changes'))
        }
        new MutationObserver(showModified).observe(options.saveButton[0], {
            attributes: true,
            attributeFilter: ['class']
        })
        showModified()

        // The bottom bar's CPU and RAM meters, as two bars side by side, red for a while
        // after an xrun. Tapping them opens the plugins' CPU usage, as the bar's CPU
        // meter does. Read off the bar's texts, which host.js keeps up to date
        var meter = $('<div class="meter">').click(function () {
            options.cpuButton.click()
        }).appendTo(tools)
        var cpu = $('<div class="fill">').appendTo($('<div class="bar">').appendTo(meter))
        var ram = $('<div class="fill">').appendTo($('<div class="bar">').appendTo(meter))
        var percent = function (text) {
            var value = parseFloat((text.text().match(/[\d.]+/) || ['0'])[0])
            return Math.max(0, Math.min(100, value))
        }
        var showLoad = function () {
            var c = percent(options.cpuText), r = percent(options.ramText)
            cpu.css('height', c + '%')
            ram.css('height', r + '%')
            meter.attr('title', 'CPU ' + c + '% / RAM ' + r + '%')
        }
        options.cpuText.add(options.ramText).each(function () {
            new MutationObserver(showLoad).observe(this, { childList: true, characterData: true, subtree: true })
        })
        showLoad()
        var xrun = null
        new MutationObserver(function () {
            meter.addClass('xrun')
            clearTimeout(xrun)
            xrun = setTimeout(function () {
                meter.removeClass('xrun')
            }, 2000)
        }).observe(options.xruns[0], { childList: true, characterData: true, subtree: true })

        // the library's tab, see effectBox's setGridLibrary, last. While a plugin is
        // being added it is the way out of it, and the dock folds down to just it
        $('<div class="add">').append(options.addButton).appendTo(self)
        var fold = function () {
            setState('adding', options.addButton.hasClass('active'))
        }
        new MutationObserver(fold).observe(options.addButton[0], {
            attributes: true,
            attributeFilter: ['class']
        })

        // Something waiting for a tap on the board: a cable being made by taps, see the
        // pedalboard's cellTap, or a plugin being added, see its
        // showPlacementGrid. The dock folds down to what it is about, under a title
        // floating above, and the way to drop it
        var task = $('<div class="task">').appendTo(self)
        var title = $('<div class="title">').appendTo(task)
        var source = $('<div class="source">').appendTo(task)
        var thumbnail = $('<img>').appendTo(source)
        var holder = $('<div class="preview">').appendTo(source)
        var names = $('<div class="names">').appendTo(source)
        var sourceLabel = $('<div class="label">').appendTo(names)
        var sourcePort = $('<div class="port">').appendTo(names)
        var cancel = null
        $('<div class="cancel">').text('Cancel').click(function () {
            cancel && cancel()
            return false
        }).appendTo(task)
        // `what` has a title, a label and a port, either of them empty, and a thumbnail or
        // a preview to show
        var startTask = function (what, onCancel) {
            title.text(what.title)
            thumbnail.toggle(!! what.thumbnail).attr('src', what.thumbnail || '')
            holder.empty().toggle(!! what.preview).append(what.preview || null)
            sourceLabel.text(what.label || '').toggle(!! what.label)
            sourcePort.text(what.port || '').toggle(!! what.port)
            cancel = onCancel
            setState('task', true)
        }
        var endTask = function () {
            cancel = null
            setState('task', false)
        }
        options.pedalboard.on('connectionstart', function (e, from) {
            startTask({ title: 'Connect', thumbnail: from.thumbnail, label: from.label, port: from.port }, function () {
                options.pedalboard.pedalboard('finishConnection')
            })
        })
        options.pedalboard.on('placementstart', function (e, plugin) {
            startTask({ title: 'Add', preview: plugin.preview, port: plugin.label }, function () {
                options.pedalboard.pedalboard('hidePlacementGrid')
            })
        })
        options.pedalboard.on('connectionend placementend', endTask)

        // What a plugin can do, while the board shows just it, see the pedalboard's
        // showPlugin: the dock folds down to these and the way back to the whole board.
        // They are the plugin's own action icons
        var plugin = $('<div class="plugin">').appendTo(self)
        var viewed = null
        var action = function (label, name, handler) {
            $('<div>').addClass(name).text(label).click(handler || function () {
                var icon = options.pedalboard.data('plugins')[viewed]
                icon && icon.find('.mod-' + name).click()
            }).appendTo(plugin)
        }
        action('‹ Board', 'board', function () {
            options.pedalboard.pedalboard('leavePluginView')
        })
        action('Info', 'information')
        action('Settings', 'settings')
        // asked first: on a phone it is a finger away from Settings, and there is no undo
        action('Remove', 'remove', function () {
            var icon = options.pedalboard.data('plugins')[viewed]
            var gui = icon && icon.data('gui')
            var name = gui && gui.effect ? (gui.effect.label || gui.effect.name) : 'this plugin'
            if (icon && confirm('Remove ' + name + ' from the pedalboard?')) {
                icon.find('.mod-remove').click()
            }
        })
        options.pedalboard.on('pluginview', function (e, instance) {
            viewed = instance
            // the A/B comparer comes along, between Info and Settings, and goes back
            // among the board's tools after
            if (instance) {
                ab.insertAfter(plugin.children('.information'))
            } else {
                ab.insertBefore(save)
            }
            setState('viewing', !! instance)
        })
        // Its settings and its info take the whole screen above the dock, which folds
        // down to the way back to the plugin, in place of the windows' own close. Its
        // other windows have the dock slide away. Wherever they were opened from.
        // The board and a plugin's settings are the two faces of a card: going from one
        // to the other flips it, the face going away fading out as the other fades in,
        // whether the board shows just that plugin or all of them. The board's face is
        // the whole of it, under its own scale
        var settings = null, info = null
        var front = options.pedalboard.parent()
        var FLIP = 350
        var flipBack = function () {
            if (! front.hasClass('mod-flip-away')) {
                return
            }
            front.removeClass('mod-flip-away').addClass('mod-flip-back')
            setTimeout(function () {
                front.removeClass('mod-flip-back')
            }, FLIP)
        }
        var closeSettings = function () {
            if (! settings || settings.hasClass('mod-flip-out')) {
                return
            }
            var closing = settings.removeClass('mod-flip-in').addClass('mod-flip-out')
            flipBack()
            setTimeout(function () {
                closing.removeClass('mod-flip-out').window('close')
            }, FLIP)
        }
        var dialog = $('<div class="dialog">').appendTo(self)
        $('<div>').text('‹ Back').click(function () {
            if (settings) {
                closeSettings()
            } else if (info) {
                info.window('close')
            } else if (options.transportWindow.is(':visible')) {
                options.transportButton.click()
            }
        }).appendTo(dialog)

        // The transport, from the menu, folds the dock down to the same way back. It is
        // no window, its button shows and hides it
        var showTransport = function () {
            setState('dialog', options.transportWindow.is(':visible'))
        }
        new MutationObserver(showTransport).observe(options.transportWindow[0], {
            attributes: true,
            attributeFilter: ['style', 'class']
        })
        // A double tap on the settings' background goes back too: not on a control,
        // nor where a finger scrolls
        var down = null, tapped = 0
        var controls = 'input, select, textarea, button, a, li, img, [mod-role], [mod-widget], [class*=icon-]'
        var settingsDown = function (e) {
            down = e.originalEvent
        }
        var settingsUp = function (e) {
            var ev = e.originalEvent
            if (! down || down.pointerId != ev.pointerId ||
                Math.abs(ev.clientX - down.clientX) > 10 || Math.abs(ev.clientY - down.clientY) > 10 ||
                $(ev.target).closest(controls).length) {
                down = null
                return
            }
            down = null
            if (Date.now() - tapped < 350) {
                tapped = 0
                closeSettings()
            } else {
                tapped = Date.now()
            }
        }
        // the window's own close, where it has one, flips back too
        var closeClicked = function (ev) {
            if ($(ev.target).closest('.js-close').length) {
                ev.stopPropagation()
                closeSettings()
            }
        }
        $(document).on('windowopen', function (e) {
            var target = $(e.target)
            // the settings of a plugin on the board, not those of the performance view
            if (target.is('.mod-settings') && target.parent().is('body') &&
                ! options.performanceBox.is(':visible')) {
                settings = target
                settings[0].addEventListener('click', closeClicked, true)
                settings.removeClass('mod-flip-out').addClass('mod-flip-in')
                front.removeClass('mod-flip-back').addClass('mod-flip-away')
            }
            if (viewed && settings && settings[0] == e.target) {
                settings.on('pointerdown.appbar', settingsDown).on('pointerup.appbar', settingsUp)
                setState('dialog', true)
            } else if (viewed && target.is('.plugin-info')) {
                info = target
                setState('dialog', true)
            } else if (viewed || settings && settings[0] == e.target) {
                dialogs = dialogs.add(e.target)
                makeRoom()
            }
        })
        $(document).on('windowclose', function (e) {
            if (settings && settings[0] == e.target) {
                settings[0].removeEventListener('click', closeClicked, true)
                settings.off('.appbar').removeClass('mod-flip-in mod-flip-out')
                settings = null
                // closed some other way than ours, all at once
                flipBack()
                setState('dialog', false)
            }
            if (info && info[0] == e.target) {
                info = null
                setState('dialog', false)
            }
            dialogs = dialogs.not(e.target)
            makeRoom()
        })

        self.appendTo('body')

        // the board lost its bars: it runs under the see-through title and the dock, and
        // grid mode's zoom keeps the cells above the dock
        options.pedalboard.pedalboard('setMargins', 0, 0, $(window).height() - self.offset().top + 12)

        return self
    },
})
