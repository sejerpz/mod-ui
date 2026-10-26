// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grid mode's application bar, a dock floating at the bottom center of the screen,
// where a thumb reaches on a tablet. It takes the place of the top and bottom bars,
// which are hidden: the menu, the constructor and performance switch, the snapshots,
// the A/B comparer, saving the pedalboard and adding a plugin are on it, and the menu
// leads to everything else the bars had.
// Every button drives the element that already does the job, so the app's own state
// and handlers stay where they are.

JqueryClass('appBar', {
    init: function (options) {
        var self = $(this)

        self.addClass('mod-app-bar')
        $('body').addClass('app-bar-mode')

        // the page itself never zooms: a double tap used to zoom it in with no way back,
        // since the board takes pinches for its own zoom. Still laid out 980 wide, as
        // mobile browsers do with no viewport given, which the dock fits in
        var viewport = $('meta[name=viewport]')
        if (! viewport.length) {
            viewport = $('<meta name="viewport">').appendTo('head')
        }
        viewport.attr('content', 'width=980, user-scalable=no')

        // A phone, by the short side of its screen, which the page's 980 wide layout does
        // not change: too small for the action icons above each plugin, see
        // dashboard.css. Tapping a plugin leads to its actions there. A screen of no
        // known size is not one
        var side = Math.min(screen.width, screen.height)
        $('body').toggleClass('phone', side > 0 && side < 600)

        // A button opening a menu upwards. `sections` are lists of [label, element]
        // pairs, the element being clicked when its label is, each list under its title
        // if it has one. Any other tap closes the menu.
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
                    $('<li>').text(item[0]).click(function () {
                        holder.removeClass('open')
                        item[1].click()
                        return false
                    }).appendTo(list)
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
        // dock while performing, in place of the board's tools.
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

        // the snapshot dialogs take the room the dock would cover: it slides away while
        // one is up. They open and close with show() and hide(), whatever opened them
        // and so do the windows of a plugin the board shows alone, see below
        var dialogs = $()
        // as does the plugins' CPU usage, see below
        var makeRoom = function () {
            self.toggleClass('away', options.snapshotDialogs.add(options.cpuLoadWindow).filter(':visible').length > 0 ||
                                     dialogs.length > 0)
        }
        options.snapshotDialogs.add(options.cpuLoadWindow).each(function () {
            new MutationObserver(makeRoom).observe(this, {
                attributes: true,
                attributeFilter: ['style', 'class']
            })
        })

        tools.append(options.abCompare)

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
