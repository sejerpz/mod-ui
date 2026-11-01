// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the HMI display shows above the knobs, column by column: the knob addressing as always, or a widget one
// of the plugins draws. A widget wider than a column takes the columns after it too.
function HMIWidgetsWindow(options) {
    var self = this

    options = $.extend({
        window: $('<div>'),
    }, options)

    var win = options.window
    var state = null   // what the server last said: columns, pages, subpages, layout, available
    var layout = []    // the layout being edited
    var subpage = 0    // the subpage in view, picked with the switch

    function instanceLabel(instance) {
        return instance.replace(/^\/graph\//, '')
    }

    function widgetKey(entry) {
        return entry.instance + '|' + entry.symbol
    }

    function findAvailable(key) {
        for (var i in state.available) {
            if (widgetKey(state.available[i]) === key) {
                return state.available[i]
            }
        }
        return null
    }

    function currentPage() {
        return parseInt(win.find('.js-page').val())
    }

    function currentSubpage() {
        return subpage
    }

    // the widget starting at, or spanning over, a column of the page in view
    function widgetAt(column) {
        var page = currentPage(), subpage = currentSubpage()
        for (var i in layout) {
            var entry = layout[i]
            if (entry.page === page && entry.subpage === subpage &&
                column >= entry.column && column < entry.column + entry.columns) {
                return entry
            }
        }
        return null
    }

    function removeWidgetAt(column) {
        var entry = widgetAt(column)
        if (entry) {
            layout.splice(layout.indexOf(entry), 1)
        }
    }

    function render() {
        var list = win.find('.js-columns').empty()

        for (var column = 0; column < state.columns;) {
            var entry = widgetAt(column)
            var span = entry ? entry.columns : 1
            var title = span > 1 ? 'Columns ' + (column + 1) + '-' + (column + span) : 'Column ' + (column + 1)
            if (entry && entry.fullscreen) {
                title = 'Full screen'
            }

            // a widget wider than a column is one box as wide as all the columns it takes
            var cell = $('<div class="hmi-widgets-column">')
                .css('flex', span + ' ' + span + ' 0')
                .toggleClass('hmi-widgets-column-widget', !!entry)
                .append($('<h5>').text(title))
                .appendTo(list)

            var select = $('<select>').attr('data-column', column)
            select.append($('<option value="">').text('Knob ' + (column + 1)))

            // grouped by how much room they take, and sorted by plugin and name in each group
            var groups = [1, 2, 3, 'full']
            for (var g in groups) {
                var group = groups[g]
                var widgets = state.available.filter(function (widget) {
                    if (group === 'full') {
                        // chosen in the first column, it takes all of them
                        return widget.fullscreen && column === 0
                    }
                    return !widget.fullscreen && widget.columns === group && column + widget.columns <= state.columns
                }).sort(function (a, b) {
                    var la = instanceLabel(a.instance) + ': ' + a.name, lb = instanceLabel(b.instance) + ': ' + b.name
                    return la < lb ? -1 : la > lb ? 1 : 0
                })
                if (widgets.length === 0) {
                    continue
                }
                var optgroup = $('<optgroup>').attr('label', group === 'full' ? 'Full screen'
                                                                            : group === 1 ? '1 column' : group + ' columns')
                for (var i in widgets) {
                    optgroup.append($('<option>').val(widgetKey(widgets[i]))
                                                 .text(instanceLabel(widgets[i].instance) + ': ' + widgets[i].name))
                }
                select.append(optgroup)
            }

            select.val(entry ? widgetKey(entry) : '')
            select.change(function () {
                var col = parseInt($(this).attr('data-column'))
                var widget = findAvailable($(this).val())

                removeWidgetAt(col)

                if (widget) {
                    var span = widget.fullscreen ? state.columns : widget.columns
                    // whatever sat in the columns the new widget takes goes back to the knob
                    for (var c = col; c < col + span; c++) {
                        removeWidgetAt(c)
                    }
                    layout.push({
                        page      : currentPage(),
                        subpage   : currentSubpage(),
                        column    : col,
                        columns   : span,
                        fullscreen: widget.fullscreen,
                        instance  : widget.instance,
                        symbol    : widget.symbol,
                    })
                }
                render()
            })
            cell.append(select)

            if (entry && entry.fullscreen) {
                cell.append($('<p class="hmi-widgets-note">')
                    .text('Takes the whole display: title, columns and footer. The knobs and footswitches keep working.'))
            }

            column += span
        }
    }

    // a segmented switch like the A/B compare one: one segment per subpage, the one in view highlighted
    function fillSubpages(count) {
        var switcher = win.find('.js-subpages').empty().toggle(count > 1)

        for (var i = 0; i < count; i++) {
            $('<div class="hmi-widgets-subpage">')
                .text('Subpage ' + (i + 1))
                .attr('data-subpage', i)
                .toggleClass('selected', i === subpage)
                .click(function () {
                    subpage = parseInt($(this).attr('data-subpage'))
                    switcher.children().removeClass('selected')
                    $(this).addClass('selected')
                    render()
                })
                .appendTo(switcher)
        }
    }

    function fillSelect(select, count, label) {
        select.empty()
        for (var i = 0; i < count; i++) {
            select.append($('<option>').val(i).text(label(i)))
        }
    }

    win.find('.js-page').change(render)

    win.find('.js-cancel').click(function () {
        win.hide()
        return false
    })

    win.find('.js-submit').click(function () {
        $.ajax({
            url: '/pedalboard/hmi-widgets',
            type: 'POST',
            data: {
                widgets: JSON.stringify(layout),
            },
            success: function () {
                win.hide()
            },
            error: function () {
                new Notification('error', "Could not save the display widgets")
            },
            cache: false,
            dataType: 'json',
        })
        return false
    })

    this.start = function () {
        $.ajax({
            url: '/pedalboard/hmi-widgets',
            type: 'GET',
            success: function (data) {
                state = data
                layout = JSON.parse(JSON.stringify(data.layout))

                if (state.columns === 0) {
                    new Notification('info', "This device has no display columns for widgets")
                    return
                }

                subpage = 0
                fillSelect(win.find('.js-page'), state.pages, function (i) { return 'Page ' + (i + 1) })
                fillSubpages(state.subpages)
                win.find('.js-empty').toggle(state.available.length === 0)

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
