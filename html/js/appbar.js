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
        // The performance view fades in as it opens, and out before it closes when Edit
        // closes it
        var mode = $('<div class="mode">').appendTo(self)
        var edit = $('<div class="segment">').text('Edit').click(function () {
            var view = options.performanceBox
            if (! view.is(':visible') || options.places.filter(':visible').length) {
                options.constructorTrigger.click()
                return
            }
            if (view.hasClass('leaving')) {
                return
            }
            edit.addClass('selected')
            live.removeClass('selected')
            view.addClass('leaving')
            setTimeout(function () {
                view.removeClass('leaving')
                options.constructorTrigger.click()
            }, 250)
        }).appendTo(mode)
        var live = $('<div class="segment">').text('Live').click(function () {
            options.performanceTrigger.click()
        }).appendTo(mode)
        // In one of the places the menu leads to, like the plugin store, the board and
        // its tools are not there: the dock keeps the menu and the way back to either
        // mode, neither of which is the one shown
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
            var view = options.performanceBox.removeClass('entering')
            view[0].getBoundingClientRect()
            view.addClass('entering')
        })
        showMode()

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
        var makeRoom = function () {
            self.toggleClass('away', options.snapshotDialogs.filter(':visible').length > 0 ||
                                     dialogs.length > 0)
        }
        options.snapshotDialogs.each(function () {
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
        // its settings and info, wherever they were opened from
        $(document).on('windowopen', function (e) {
            if (viewed) {
                dialogs = dialogs.add(e.target)
                makeRoom()
            }
        })
        $(document).on('windowclose', function (e) {
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
