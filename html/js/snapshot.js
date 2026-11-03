// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// From how many snapshots the list has a field to find one by its name
var SNAPSHOTS_FILTER_MIN = 8
// How far a row moves before it is a swipe rather than a tap, and how far it opens to
// show its Delete, as wide as in dashboard.css, in px
var SNAPSHOTS_SWIPE_START = 8
var SNAPSHOTS_DELETE_WIDTH = 96
// A mouse rather than a finger, as in dashboard.css
var MOUSE_FIRST = '(hover: hover) and (pointer: fine)'

// The pedalboard's snapshots: a row each, a tap loads it. Its pencil renames it in its
// row. Swiped to the left by a finger it shows Delete under it, which deletes it when
// tapped; with a mouse, see MOUSE_FIRST, its bin after the pencil asks first, in the
// dock
function SnapshotsManager(options) {
    var self = this;

    options = $.extend({
        pedalPresetsWindow: $('<div>'),
        pedalPresetsList: $('<div>'),
        renamedCallback: function (name) {},
        saveAsCallback: function () {},
        // asks whether to go on, `what` as for the dock's tasks, see confirm in appbar.js
        confirm: askFirst,
        hardwareManager: null,
    }, options)

    var win = options.pedalPresetsWindow
    var list = options.pedalPresetsList
    var filter = win.find('.js-filter')

    // names by id, as /snapshot/list gives them
    var presets = {}
    var currentId = -1
    // the snapshot swiped open, showing its Delete, and the one being renamed
    var swipedId = -1
    var renamingId = -1
    // the snapshots addressed to an actuator, which may not give the loaded one back
    var addressed = false
    var canFeedback = true

    $('body').keydown(function (e) {
        if (e.keyCode == 27 && win.is(':visible')) { // esc
            self.close()
        }
    })

    win.find('.js-cancel').click(function () {
        self.close()
        return false
    })

    filter.on('input', function () {
        swipedId = -1
        self.render()
    })

    // A finger on a row: moving sideways first it drags the row, which
    // stays open over its Delete when let go past half of it, and closes otherwise.
    // Moving up or down first it scrolls the list, see touch-action in dashboard.css
    var drag = null
    list.on('pointerdown', '.snapshot', function (e) {
        // jQuery 1.9 leaves out what is a pointer's own
        var p = e.originalEvent
        if (p.pointerType == 'mouse' || renamingId >= 0 ||
            $(e.target).closest('input, .js-rename, .js-ask-delete').length) {
            return
        }
        var row = $(this)
        drag = {
            row: row,
            // the finger moves in the page's px, the row in the dialog's, see --touch-zoom
            zoom: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--touch-zoom')) || 1,
            id: row.closest('.snapshot-item').data('id'),
            pointerId: p.pointerId,
            x: p.clientX,
            y: p.clientY,
            from: row.closest('.snapshot-item').hasClass('swiped') ? -SNAPSHOTS_DELETE_WIDTH : 0,
            swiping: false,
            moved: false,
        }
    })

    list.on('pointermove', '.snapshot', function (e) {
        var p = e.originalEvent
        if (!drag || p.pointerId != drag.pointerId) {
            return
        }
        var dx = (p.clientX - drag.x) / drag.zoom
        var dy = (p.clientY - drag.y) / drag.zoom

        if (!drag.swiping) {
            if (Math.abs(dy) > SNAPSHOTS_SWIPE_START && Math.abs(dy) > Math.abs(dx)) {
                drag = null
                return
            }
            if (Math.abs(dx) < SNAPSHOTS_SWIPE_START) {
                return
            }
            drag.swiping = drag.moved = true
            this.setPointerCapture(p.pointerId)
            drag.row.addClass('dragging')
            // only one open at a time
            if (swipedId >= 0 && swipedId != drag.id) {
                self.unswipe()
            }
        }

        var width = SNAPSHOTS_DELETE_WIDTH
        var x = Math.min(0, drag.from + dx)
        // past its Delete, the row follows less and less
        if (x < -width) {
            x = -width - Math.sqrt(-width - x) * 4
        }
        drag.row.css('transform', 'translateX(' + x + 'px)')
    })

    list.on('pointerup pointercancel', '.snapshot', function (e) {
        var p = e.originalEvent
        if (!drag || p.pointerId != drag.pointerId) {
            return
        }
        var d = drag
        drag = null
        if (!d.swiping) {
            return
        }
        // the click this ends with is not a tap on the row
        list.data('swiped', true)
        setTimeout(function () { list.removeData('swiped') }, 0)

        d.row.removeClass('dragging').css('transform', '')
        var width = SNAPSHOTS_DELETE_WIDTH
        var x = d.from + (p.clientX - d.x) / d.zoom
        self.unswipe()
        if (e.type == 'pointerup' && x < -width / 2) {
            swipedId = d.id
            d.row.closest('.snapshot-item').addClass('swiped')
        }
    })

    list.on('click', '.snapshot', function (e) {
        if (list.data('swiped') || $(e.target).closest('input, .js-rename, .js-ask-delete').length) {
            return
        }
        // a tap anywhere closes the one open first
        if (swipedId >= 0) {
            self.unswipe()
            return
        }
        var id = $(this).closest('.snapshot-item').data('id')
        if (id != currentId) {
            self.loadPreset(id, e)
        }
    })

    list.on('click', '.js-rename', function (e) {
        if (addressed) {
            return self.prevent(e)
        }
        swipedId = -1
        renamingId = $(this).closest('.snapshot-item').data('id')
        self.render()
        list.find('.snapshot input').focus().select()
        return false
    })

    list.on('keydown', '.snapshot input', function (e) {
        if (e.keyCode == 27) { // esc, the rename only
            renamingId = -1
            self.render()
            return false
        }
        if (e.keyCode == 13) { // enter
            self.renamed($(this).val())
            return false
        }
    })

    // also when the field is gone, as render() takes it out
    list.on('blur', '.snapshot input', function () {
        self.renamed($(this).val())
    })

    list.on('click', '.js-delete', function (e) {
        if (self.preventDelete(e)) {
            return false
        }
        self.remove($(this).closest('.snapshot-item').data('id'))
        return false
    })

    list.on('click', '.js-ask-delete', function (e) {
        if (self.preventDelete(e)) {
            return false
        }
        var id = $(this).closest('.snapshot-item').data('id')
        options.confirm({
            title: 'Delete snapshot?',
            label: 'Snapshot ' + (id + 1),
            port: presets[id],
            go: 'Delete',
        }, function () {
            self.remove(id)
        })
        return false
    })

    win.find('.js-assign-all').click(function (e) {
        if ($(this).hasClass("disabled")) {
            return self.prevent(e, "Cannot assign list with only 1 snapshot")
        }

        var port = {
            name: 'Snapshots',
            symbol: ':presets',
            ranges: {
                minimum: -1,
                maximum: 0,
                default: -1,
            },
            comment: "",
            designation: "",
            properties: ["enumeration", "integer"],
            value: -1,
            format: null,
            scalePoints: [],
        }
        self.close()
        options.hardwareManager.open("/pedalboard", port, "Pedalboard")
        return false
    })

    win.find('.js-save-as').click(function () {
        self.close()
        options.saveAsCallback()
        return false
    })

    this.start = function (presetId, currentlyAddressed, feedback) {
        addressed = currentlyAddressed
        canFeedback = feedback

        self.getPedalPresetList(function (resp) {
            if (Object.keys(resp).length == 0) {
                return new Notification("error", "No pedalboard snapshots available")
            }

            presets = resp
            currentId = presetId
            swipedId = renamingId = -1
            filter.val('')
            self.render()

            win.show()
            list.scrollTop(0)
            var current = list.find('.snapshot-item.current')
            if (current.length) {
                current[0].scrollIntoView({ block: 'nearest' })
            }
        })
    }

    this.close = function () {
        renamingId = -1
        // nor is a delete asked about any longer, see confirm in appbar.js
        $('.mod-app-bar.confirming .task .cancel').click()
        win.hide()
    }

    // the snapshot loaded elsewhere, from the actuators or another window
    this.setCurrent = function (id) {
        if (id == currentId) {
            return
        }
        currentId = id
        if (win.is(':visible') && renamingId < 0 && !drag) {
            self.render()
        }
    }

    // whether a snapshot cannot be deleted, saying why
    this.preventDelete = function (e) {
        if (Object.keys(presets).length <= 1) {
            return self.prevent(e, "Cannot delete last remaining snapshot")
        }
        if (addressed) {
            return self.prevent(e)
        }
        return false
    }

    this.remove = function (id) {
        $.ajax({
            url: '/snapshot/remove',
            type: 'GET',
            data: {
                id: id,
            },
            success: function () {
                // the server numbers them again from 0, without the gap
                var names = []
                for (var i in presets) {
                    if (i != id) {
                        names.push(presets[i])
                    }
                }
                presets = $.extend({}, names)

                if (currentId == id) {
                    currentId = -1
                    options.renamedCallback()
                } else if (currentId > id) {
                    currentId -= 1
                }
                swipedId = -1
                self.render()
            },
            error: function () {
                new Notification('error', "Failed to delete snapshot", 5000)
            },
            cache: false,
        })
    }

    this.unswipe = function () {
        swipedId = -1
        list.find('.snapshot-item.swiped').removeClass('swiped')
    }

    this.render = function () {
        var count = Object.keys(presets).length
        var query = filter.val().trim().toLowerCase()
        var deletable = !addressed && count > 1

        win.find('.js-count').text(count)
        win.find('.hint').text(window.matchMedia(MOUSE_FIRST).matches
                               ? 'Click a snapshot to load it.'
                               : 'Tap a snapshot to load it, swipe it to the left to delete it.')
        win.find('.js-assign-all').toggleClass('disabled', count <= 1)
        filter.toggle(count >= SNAPSHOTS_FILTER_MIN)

        list.empty()
        for (var i in presets) {
            var id = parseInt(i)
            var name = presets[i]

            if (query && id != renamingId && name.toLowerCase().indexOf(query) < 0) {
                continue
            }

            var item = $('<div class="snapshot-item">').data('id', id)
                .toggleClass('current', id == currentId)
                .toggleClass('swiped', id == swipedId)
                .appendTo(list)
            $('<button class="js-delete delete">').text('Delete')
                .toggleClass('disabled', !deletable)
                .appendTo(item)

            var row = $('<div class="snapshot">').appendTo(item)
                .append($('<span class="number">').text(id + 1))
            var text = $('<div class="text">').appendTo(row)

            if (id == renamingId) {
                $('<input type="text" autocomplete="off">').val(name).appendTo(text)
            } else {
                $('<span class="name">').text(name).appendTo(text)
                if (id == currentId) {
                    $('<span class="sub">').text('Loaded').appendTo(text)
                }
                $('<button class="js-rename rename" title="Rename">')
                    .toggleClass('disabled', addressed)
                    .appendTo(row)
                $('<button class="js-ask-delete ask-delete" title="Delete">')
                    .toggleClass('disabled', !deletable)
                    .appendTo(row)
            }
        }

        if (list.is(':empty')) {
            $('<div class="empty">').text('No snapshot matches “' + filter.val() + '”').appendTo(list)
        }
    }

    this.prevent = function (e, customMessage) {
        var img = $('<img>').attr('src', 'img/icn-blocked.png')
        $('body').append(img)
        img.css({
            position: 'absolute',
            top: e.pageY - img.height() / 2,
            left: e.pageX - img.width() / 2,
            zIndex: 99999
        })
        setTimeout(function () {
            img.remove()
        }, 500)
        new Notification("warn", customMessage || "Cannot change snapshots while addressed to hardware", 3000)
        return false
    }

    /*
     * Load a snapshot on the mod
     */
    this.loadPreset = function (presetId, e) {
        if (addressed && !canFeedback) {
            return self.prevent(e)
        }

        var presetName = presets[presetId]

        $.ajax({
            url: '/snapshot/load',
            type: 'GET',
            data: {
                id: presetId,
            },
            success: function () {
                self.setCurrent(presetId)
                new Notification("info", "Snapshot " + presetName + " loaded", 2000)
            },
            error: function () {
                new Notification('error', "Failed to load snapshot", 5000)
            },
            cache: false,
        })
    }

    this.renamed = function (text) {
        var id = renamingId
        if (id < 0) {
            return
        }
        renamingId = -1
        text = text.trim()

        if (text == "" || text == presets[id]) {
            return self.render()
        }

        $.ajax({
            url: '/snapshot/rename',
            type: 'GET',
            data: {
                id   : id,
                title: text,
            },
            success: function (resp) {
                if (!resp.ok) {
                    return
                }
                presets[id] = resp.title
                if (id == currentId) {
                    options.renamedCallback(resp.title)
                }
                self.render()
            },
            error: function () {
                new Notification('error', "Failed to rename snapshot", 5000)
            },
            cache: false,
        })

        self.render()
    }

    this.getPedalPresetList = function (callback) {
        $.ajax({
            url: '/snapshot/list',
            type: 'GET',
            success: function (resp) {
                callback(resp)
            },
            error: function () {
                new Bug("Failed to get pedalboard snapshot list")
            },
            cache: false,
            dataType: 'json'
        })
    }
}
