// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * "Learn from Dwarf" in the addressing dialog's Device tab -- the way to a learn on a
 * touchscreen, where a long press on a control is left to the control. Driven against the
 * REAL html/js/hardware.js and html/include/addressing.html. The learn itself (the ajax,
 * the ring, the device) is pedalboard.js's and the host's; here it is the hand-off.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { makeWindow, HTML } = require('./harness')

const FORM = fs.readFileSync(path.join(HTML, 'include', 'addressing.html'), 'utf8')

let ctx, $, learned

function gainPort() {
    return {
        symbol: 'gain', name: 'Gain', shortName: 'Gain', value: 0.5,
        ranges: { minimum: 0, maximum: 1, default: 0.5 },
        properties: [], scalePoints: [], units: {},
    }
}

function manager(profile) {
    ctx.window.HARDWARE_PROFILE = profile
    return new ctx.window.HardwareManager({
        renderForm: () => ctx.window.Mustache.render(FORM, { label: 'Amp', name: 'Gain' }),
        // Array.from: the window's arrays are another realm's, which deepStrictEqual tells apart
        hmiLearn: (instance, symbol, actuators) => learned.push({ instance, symbol, actuators: Array.from(actuators) }),
    })
}

const KNOB = { uri: '/hmi/knob1', name: 'Knob 1', modes: ':float:integer:', steps: [], max_assigns: 1 }

beforeEach(() => {
    ctx = makeWindow()
    $ = ctx.$
    ctx.window.eval('var PLATFORM = "dwarf"; var ADDRESSING_PAGES = 0; var PREFERENCES = {};')
    ctx.load('js/utils/tempo.js')
    ctx.load('js/hardware.js')
    learned = []
})

test('the Device tab offers Learn from Dwarf, which closes the dialog and starts the learn', () => {
    manager([KNOB]).open('/graph/amp', gainPort(), 'Amp')

    const learn = $('.js-hmi-learn')
    assert.strictEqual(learn.length, 1)
    assert.match(learn.text(), /Learn from Dwarf/)

    $('.js-type[data-value="/hmi"]').click()
    assert.notStrictEqual(learn.closest('.dynamic-field').css('display'), 'none', 'shown on Device')
    $('.js-type[data-value="null"]').click()
    assert.strictEqual(learn.closest('.dynamic-field').css('display'), 'none', 'hidden elsewhere')

    learn.click()
    assert.strictEqual($('.mod-pedal-settings-address').length, 0, 'the dialog is closed')
    assert.deepStrictEqual(learned, [{ instance: '/graph/amp', symbol: 'gain', actuators: ['/hmi/knob1'] }])
})

test('no Learn button when the device has nothing the control can go on', () => {
    manager([]).open('/graph/amp', gainPort(), 'Amp')
    assert.strictEqual($('.js-hmi-learn').length, 0)
})

test('no Learn button for the transport, which the host cannot learn', () => {
    manager([KNOB]).open('/pedalboard', gainPort(), 'Pedalboard')
    assert.strictEqual($('.js-hmi-learn').length, 0)
})
