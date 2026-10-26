// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grid mode's application bar, a dock floating at the bottom center of the screen,
// where a thumb reaches on a tablet. It takes the place of the top and bottom bars, which are hidden, and grows
// into the app's whole menu one function at a time. For now: the constructor and
// performance switch, adding a plugin, the snapshots, the A/B comparer and saving the
// pedalboard.
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

        // the header's snapshots menu, opening upwards
        var snapshots = $('<div class="snapshots">').appendTo(tools)
        var menu = $('<ul class="menu">').appendTo(snapshots)
        var item = function (label, button) {
            $('<li>').text(label).click(function () {
                snapshots.removeClass('open')
                button.click()
                return false
            }).appendTo(menu)
        }
        item('Save', options.snapshotSaveButton)
        item('Save as', options.snapshotSaveAsButton)
        item('Load / Manage', options.snapshotManageButton)
        $('<div class="toggle">').text('Snapshots').click(function () {
            snapshots.toggleClass('open')
            return false
        }).appendTo(snapshots)
        // any other tap closes it
        $(document).on('click', function (e) {
            if (! $.contains(snapshots[0], e.target)) {
                snapshots.removeClass('open')
            }
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
