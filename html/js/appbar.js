// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grid mode's application bar, a dock floating at the bottom center of the screen,
// where a thumb reaches on a tablet. It takes the place of the top and bottom bars,
// which are hidden: the menu, the constructor and performance switch, adding a plugin,
// the snapshots, the A/B comparer and saving the pedalboard are on it, and the menu
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

        // the gateway to whatever the hidden bars had and the dock has no room for
        popup('main', 'Menu', options.menu).appendTo(self)

        // Edit is the constructor, Live the performance view: two states of one switch
        var mode = $('<div class="mode">').appendTo(self)
        var edit = $('<div class="segment">').text('Edit').click(function () {
            options.constructorTrigger.click()
        }).appendTo(mode)
        var live = $('<div class="segment">').text('Live').click(function () {
            options.performanceTrigger.click()
        }).appendTo(mode)
        var showMode = function () {
            var performing = options.performanceBox.is(':visible')
            edit.toggleClass('selected', ! performing)
            live.toggleClass('selected', performing)
            self.toggleClass('performing', performing)
        }
        options.performanceBox.on('windowopen windowclose', showMode)
        showMode()

        // the library's tab, see effectBox's setGridLibrary
        $('<div class="add">').append(options.addButton).appendTo(self)

        var tools = $('<div class="tools">').appendTo(self)

        // the header's snapshots menu
        popup('snapshots', 'Snapshots', [{ items: [
            ['Save', options.snapshotSaveButton],
            ['Save as', options.snapshotSaveAsButton],
            ['Load / Manage', options.snapshotManageButton],
        ]}]).appendTo(tools)

        // the snapshot dialogs take the room the dock would cover: it slides away while
        // one is up. They open and close with show() and hide(), whatever opened them
        var makeRoom = function () {
            self.toggleClass('away', options.snapshotDialogs.filter(':visible').length > 0)
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

        self.appendTo('body')

        // the board lost its bars: it runs under the see-through title and the dock, and
        // grid mode's zoom keeps the cells above the dock
        options.pedalboard.pedalboard('setMargins', 0, 0, $(window).height() - self.offset().top + 12)

        return self
    },
})
