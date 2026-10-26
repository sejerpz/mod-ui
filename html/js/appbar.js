// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grid mode's application bar, a dock floating at the bottom center of the screen,
// where a thumb reaches on a tablet. It takes the place of the top and bottom bars, which are hidden, and grows
// into the app's whole menu one function at a time. For now: the constructor and
// performance switch, the A/B comparer, adding a plugin and saving the pedalboard.
// Every button drives the element that already does the job, so the app's own state
// and handlers stay where they are.

JqueryClass('appBar', {
    init: function (options) {
        var self = $(this)

        self.addClass('mod-app-bar')
        $('body').addClass('app-bar-mode')

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

        // the board lost its bars: it runs under the see-through title and the dock
        options.pedalboard.pedalboard('setMargins', 0, 0)

        return self
    },
})
