// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// The MIDI devices the board uses: a row each with its switch, its ins and outs under
// its name. How they show up on the board, aggregated or a port each, and the virtual
// loopback, if there is one. Nothing changes until saved
function MidiPortsWindow(options) {
    var self = this;

    options = $.extend({
        midiPortsWindow: $('<div>'),
        midiPortsList: $('<div>'),
    }, options)

    var win = options.midiPortsWindow
    var list = options.midiPortsList
    var modes = win.find('.js-midi-mode button')
    var loopback = win.find('.js-loopback')

    $('body').keydown(function (e) {
        if (e.keyCode == 27 && win.is(':visible')) { // esc
            win.hide()
        }
    })

    win.find('.js-cancel').click(function () {
        win.hide()
        return false
    })

    win.on('click', '.row', function () {
        $(this).find('.switch').toggleClass('on')
        $(this).toggleClass('off', ! $(this).find('.switch').hasClass('on'))
    })

    modes.click(function () {
        modes.removeClass('on')
        $(this).addClass('on')
    })

    win.find('.js-submit').click(function () {
        var devs = []

        list.find('.row').each(function () {
            if ($(this).find('.switch').hasClass('on')) {
                devs.push($(this).data('dev'))
            }
        })

        self.selectDevices(devs,
                           modes.filter('.on').data('mode') === "aggregated",
                           loopback.find('.switch').hasClass('on'))
        win.hide()
        return false
    })

    // a row, with a switch on or off at its end
    function row(name, sub, on) {
        return $('<div class="row">' +
                 '<div class="text"><span class="name"></span><span class="sub"></span></div>' +
                 '<div class="switch"></div></div>')
            .toggleClass('off', ! on)
            .find('.name').text(name).end()
            .find('.sub').html(sub).end()
            .find('.switch').toggleClass('on', on).end()
    }

    this.start = function () {
        self.getDeviceList(function (devsInUse, devList, names, midiAggregatedMode) {
            var hasMidiLoopback = false

            list.empty()

            for (var i in devList) {
                var dev  = devList[i]
                var name = names[dev]
                var used = devsInUse.indexOf(dev) >= 0

                if (name === "MIDI Loopback") {
                    hasMidiLoopback = true
                    loopback.find('.switch').toggleClass('on', used)
                    loopback.toggleClass('off', ! used)
                    continue
                }

                // the name ends with what the device has, as get_midi_ports in host.py
                // gives it: " (in)" or " (in+out)"
                var dirs = ['in']
                var m = name.match(/^(.*) \((in|in\+out)\)$/)
                if (m) {
                    name = m[1]
                    dirs = m[2].split('+')
                }

                row(name, '<span class="dir">' + dirs.map(function (d) { return '<i>' + d + '</i>' }).join('') + '</span>', used)
                    .data('dev', dev)
                    .appendTo(list)
            }

            if (! list.children().length) {
                list.append('<div class="empty">No MIDI device is connected</div>')
            }

            modes.removeClass('on')
                 .filter('[data-mode=' + (midiAggregatedMode ? 'aggregated' : 'separated') + ']').addClass('on')

            if (! hasMidiLoopback) {
                loopback.find('.switch').removeClass('on')
            }
            win.find('.js-loopback-section').toggle(hasMidiLoopback)

            win.show()
        })
    }

    this.getDeviceList = function (callback) {
        $.ajax({
            url: '/jack/get_midi_devices',
            type: 'GET',
            success: function (resp) {
                callback(resp.devsInUse, resp.devList, resp.names, resp.midiAggregatedMode)
            },
            error: function () {
                new Bug("Failed to get list of MIDI devices")
            },
            cache: false,
            dataType: 'json'
        })
    }

    this.selectDevices = function (devs, midiAggregatedMode, midiLoopback) {
        $.ajax({
            url: '/jack/set_midi_devices',
            type: 'POST',
            data: JSON.stringify({
                devs: devs,
                midiAggregatedMode: midiAggregatedMode,
                midiLoopback: midiLoopback,
            }),
            error: function () {
                new Bug("Failed to enable some MIDI devices")
            },
            cache: false,
            dataType: 'json'
        })
    }
}
