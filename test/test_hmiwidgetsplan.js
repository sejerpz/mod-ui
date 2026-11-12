// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Run with: node test/test_hmiwidgetsplan.js
//
// The plan the Display dialog proposes: where a widget goes on the HMI display and which controls its suggested
// ports get. A wrong answer here binds a footswitch the user did not expect, so the rules of the
// alabs-hmi-widgets README are checked one by one on the areas of the MOD Dwarf.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// html/js/utils/*.js are plain globals, no module system
eval(fs.readFileSync(path.join(__dirname, '..', 'html', 'js', 'utils', 'hmiwidgetsplan.js'), 'utf8'))
const Plan = HMIWidgetsPlan

const AREAS = [
    { id: 'col1',    name: 'Column 1',    rect: [2, 12, 40, 37],   cells: ['col1'],                 subpages: true },
    { id: 'col2',    name: 'Column 2',    rect: [44, 12, 40, 37],  cells: ['col2'],                 subpages: true },
    { id: 'col3',    name: 'Column 3',    rect: [86, 12, 40, 37],  cells: ['col3'],                 subpages: true },
    { id: 'col1-2',  name: 'Columns 1–2', rect: [2, 12, 82, 37],   cells: ['col1', 'col2'],         subpages: true },
    { id: 'col2-3',  name: 'Columns 2–3', rect: [44, 12, 82, 37],  cells: ['col2', 'col3'],         subpages: true },
    { id: 'col1-3',  name: 'Columns 1–3', rect: [2, 12, 124, 37],  cells: ['col1', 'col2', 'col3'], subpages: true },
    { id: 'footB',   name: 'Footer B',    rect: [24, 54, 53, 10],  cells: ['footB'],                subpages: false },
    { id: 'footC',   name: 'Footer C',    rect: [77, 54, 51, 10],  cells: ['footC'],                subpages: false },
    { id: 'footB-C', name: 'Footers B–C', rect: [24, 54, 104, 10], cells: ['footB', 'footC'],       subpages: false },
    { id: 'full',    name: 'Full screen', rect: [0, 0, 128, 64],
      cells: ['col1', 'col2', 'col3', 'footB', 'footC', 'index', 'title'], subpages: true },
]

const KNOBS = [{ uri: '/hmi/knob1' }, { uri: '/hmi/knob2' }, { uri: '/hmi/knob3' }]
const SWITCHES = [{ uri: '/hmi/footswitch1' }, { uri: '/hmi/footswitch2' }]

function model(options) {
    const taken = {}
    for (const slot of options.taken || []) {
        taken[Plan.slotKey(slot[0], slot[1], slot.length > 2 ? slot[2] : null)] = true
    }
    return {
        areas: AREAS,
        pages: options.pages || 8,
        subpages: 3,
        layout: options.layout || [],
        knobs: KNOBS,
        switches: SWITCHES,
        taken: taken,
        // on the Dwarf knobs take anything, footswitches only switch ports
        compatible: (port, uri) => uri.indexOf('knob') >= 0 || port.kind === 'switch',
    }
}

const switchPort = (symbol) => ({ symbol: symbol, kind: 'switch' })
const knobPort = (symbol) => ({ symbol: symbol, kind: 'knob' })
const target = (uri, page, subpage) => ({ uri: uri, page: page, subpage: subpage === undefined ? null : subpage })

// --- sizes -----------------------------------------------------------------------------------------------------

{
    // no minimum and no natural size: the smallest area first, footer C (51 × 10) before footer B (53 × 10)
    const fill = {}
    assert.deepStrictEqual(Plan.freeAreas(model({}), fill, 0, 0).slice(0, 3).map(a => a.id), ['footC', 'footB', 'col1'])
    assert.ok(Plan.fits(fill, AREAS[0]))
}
{
    // the closest to the natural size first (124 × 37 is 47 away from 104 × 10, 82 × 37 is 49), ties in device
    // order, and nothing smaller than the minimum
    const looper = { minWidth: 64, minHeight: 8, naturalWidth: 104, naturalHeight: 10 }
    assert.deepStrictEqual(Plan.freeAreas(model({}), looper, 0, 0).map(a => a.id), ['footB-C', 'col1-3', 'col1-2', 'col2-3', 'full'])
}

// --- cells -----------------------------------------------------------------------------------------------------

{
    assert.deepStrictEqual(Plan.drawableCells(model({})), ['col1', 'col2', 'col3', 'footB', 'footC'])
    assert.strictEqual(Plan.areaForCells(model({}), ['col2', 'col1']).id, 'col1-2')
    assert.strictEqual(Plan.areaForCells(model({}), ['col1', 'col3']), null)
    assert.strictEqual(Plan.areaForCells(model({}), ['col1', 'footB']), null)
    // the title band and the page index are not drawn: every drawn cell picks the full screen
    assert.strictEqual(Plan.areaForCells(model({}), ['col1', 'col2', 'col3', 'footB', 'footC']).id, 'full')
}

// --- overlaps --------------------------------------------------------------------------------------------------

{
    // a footer is on every subpage of its page: it takes the full screen away from all of them
    const m = model({ layout: [{ page: 0, area: 'footC', instance: 'a', symbol: 'x' }] })
    const full = Plan.areaById(m, 'full')
    assert.ok(!Plan.isFree(m, full, 0, 2))
    assert.ok(Plan.isFree(m, full, 1, 2))
    // a column only on its own subpage
    const m2 = model({ layout: [{ page: 0, subpage: 1, area: 'col1', instance: 'a', symbol: 'x' }] })
    assert.ok(Plan.isFree(m2, Plan.areaById(m2, 'col1-2'), 0, 0))
    assert.ok(!Plan.isFree(m2, Plan.areaById(m2, 'col1-2'), 0, 1))
    // and nothing it does not share a cell with
    assert.ok(Plan.isFree(m2, Plan.areaById(m2, 'footB'), 0, 1))
}

// --- ports -----------------------------------------------------------------------------------------------------

{
    // two switch ports take two contiguous footswitches of one page: page 1 has only C free, so page 2
    const m = model({ taken: [['/hmi/footswitch1', 0]] })
    const plan = Plan.planPorts(m, [switchPort('loop'), switchPort('stop')], 0, 0, false)
    assert.deepStrictEqual(plan.targets, { loop: target('/hmi/footswitch1', 1), stop: target('/hmi/footswitch2', 1) })
    assert.deepStrictEqual(plan.unbound, [])
}
{
    // knobs: the widget's subpage first, then the other subpages of the page
    const m = model({ taken: [['/hmi/knob1', 0, 2], ['/hmi/knob2', 0, 2], ['/hmi/knob3', 0, 2]] })
    const plan = Plan.planPorts(m, [knobPort('a')], 0, 2, false)
    assert.deepStrictEqual(plan.targets, { a: target('/hmi/knob1', 0, 0) })
}
{
    // a group longer than a row fills whole rows: four knob ports, three on subpage 1 and one on subpage 2
    const plan = Plan.planPorts(model({}), ['a', 'b', 'c', 'd'].map(knobPort), 0, 0, false)
    assert.deepStrictEqual(plan.targets.c, target('/hmi/knob3', 0, 0))
    assert.deepStrictEqual(plan.targets.d, target('/hmi/knob1', 0, 1))
}
{
    // contiguous: knobs 1 and 3 free on every subpage of every page leave no room for two in a row,
    // so the plan binds what it can, one at a time
    const taken = []
    for (let page = 0; page < 2; page++) {
        for (let sub = 0; sub < 3; sub++) {
            taken.push(['/hmi/knob2', page, sub])
        }
    }
    const plan = Plan.planPorts(model({ pages: 2, taken: taken }), [knobPort('a'), knobPort('b')], 0, 0, false)
    assert.deepStrictEqual(plan.targets, { a: target('/hmi/knob1', 0, 0), b: target('/hmi/knob3', 0, 0) })
}
{
    // switch ports go to knobs only when no footswitch is free on any page from the widget's on
    const taken = [['/hmi/footswitch1', 0], ['/hmi/footswitch2', 0]]
    const plan = Plan.planPorts(model({ pages: 1, taken: taken }), [switchPort('fire')], 0, 0, false)
    assert.deepStrictEqual(plan.targets, { fire: target('/hmi/knob1', 0, 0) })
}
{
    // never earlier pages
    const taken = [['/hmi/footswitch1', 1], ['/hmi/footswitch2', 1]]
    const plan = Plan.planPorts(model({ pages: 2, taken: taken }), [switchPort('fire')], 1, 0, false)
    assert.deepStrictEqual(plan.targets, { fire: target('/hmi/knob1', 1, 0) })
}

// --- assign automatically --------------------------------------------------------------------------------------

{
    // the Looper: both footers and both footswitches of page 1
    const looper = { minWidth: 64, minHeight: 8, naturalWidth: 104, naturalHeight: 10 }
    const result = Plan.autoAssign(model({}), looper, [switchPort('loop'), switchPort('stop')])
    assert.strictEqual(result.page, 0)
    assert.strictEqual(result.area.id, 'footB-C')
    assert.strictEqual(result.subpage, null)
    assert.deepStrictEqual(result.targets, { loop: target('/hmi/footswitch1', 0), stop: target('/hmi/footswitch2', 0) })
}
{
    // Bricks needs the full screen. Pages 1 and 3 have a widget on a footer, which is there on every subpage and
    // takes the full screen away from all of them; page 2 has no free footswitch. No page fits the widget and both
    // ports, so the widget goes to page 2 and Fire follows to page 3
    const bricks = { minWidth: 128, minHeight: 64 }
    const m = model({
        pages: 3,
        layout: [
            { page: 0, area: 'footB', instance: 'meter', symbol: 'meter' },
            { page: 2, area: 'footC', instance: 'x', symbol: 'y' },
        ],
        taken: [['/hmi/footswitch1', 1], ['/hmi/footswitch2', 1]],
    })
    const result = Plan.autoAssign(m, bricks, [switchPort('FIRE'), knobPort('MOVE')])
    assert.strictEqual(result.page, 1)
    assert.strictEqual(result.area.id, 'full')
    assert.strictEqual(result.subpage, 0)
    assert.deepStrictEqual(result.targets, { FIRE: target('/hmi/footswitch1', 2), MOVE: target('/hmi/knob1', 1, 0) })
    assert.deepStrictEqual(result.unbound, [])
}
{
    // with room for everything later on, the first page that fits it all wins
    const bricks = { minWidth: 128, minHeight: 64 }
    const m = model({ pages: 3, taken: [['/hmi/footswitch1', 0], ['/hmi/footswitch2', 0]] })
    const result = Plan.autoAssign(m, bricks, [switchPort('FIRE')])
    assert.strictEqual(result.page, 1)
}
{
    // no footswitch free on any page: a switch port takes a knob, and the widget goes to the first page that has
    // one free, rather than to page 1 with Fire following to page 2
    const taken = []
    for (let page = 0; page < 2; page++) {
        taken.push(['/hmi/footswitch1', page], ['/hmi/footswitch2', page])
    }
    for (let sub = 0; sub < 3; sub++) {
        taken.push(['/hmi/knob1', 0, sub], ['/hmi/knob2', 0, sub], ['/hmi/knob3', 0, sub])
    }
    const result = Plan.autoAssign(model({ pages: 2, taken: taken }), { minWidth: 128, minHeight: 64 }, [switchPort('FIRE')])
    assert.strictEqual(result.page, 1)
    assert.deepStrictEqual(result.targets, { FIRE: target('/hmi/knob1', 1, 0) })
}
{
    // a switch free on a later page keeps the switch port off the knobs of this one
    const plan = Plan.planPorts(model({ pages: 2, taken: [['/hmi/footswitch1', 0], ['/hmi/footswitch2', 0]] }),
                                [switchPort('fire')], 0, 0, true)
    assert.deepStrictEqual(plan.unbound, ['fire'])
}
{
    // no free area anywhere
    const m = model({ pages: 1, layout: [{ page: 0, area: 'footB', instance: 'a', symbol: 'b' }] })
    assert.strictEqual(Plan.autoAssign(m, { minWidth: 128, minHeight: 64 }, []), null)
}
{
    // a widget that draws only in gray is not offered on a mono display
    assert.ok(!Plan.fits({ formats: 2 }, AREAS[0]))
    assert.ok(Plan.fits({ formats: 3 }, AREAS[0]))
}

// --- two displays: the Duo X ----------------------------------------------------------------------------------

// the areas of one display of the Duo X, with the cells the server makes its own (display/cell); the Duo X has no
// subpages
function duoxAreas(display) {
    const c = (cells) => cells.map((cell) => display + '/' + cell).sort()
    const a = (id, name, rect, cells) => ({ id: display + '-' + id, name: name, display: display, rect: rect,
                                            cells: c(cells), subpages: true, format: 0 })
    return [
        a('k1', 'Knob 1', [0, 25, 64, 16], ['k1']), a('k2', 'Knob 2', [0, 41, 64, 14], ['k2']),
        a('k3', 'Knob 3', [65, 25, 63, 16], ['k3']), a('k4', 'Knob 4', [65, 41, 63, 14], ['k4']),
        a('k12', 'Knobs 1–2', [0, 25, 64, 30], ['k1', 'k2']), a('k34', 'Knobs 3–4', [65, 25, 63, 30], ['k3', 'k4']),
        a('enc', 'Encoder', [0, 8, 128, 16], ['enc']),
        a('b1', 'Button 1', [0, 56, 64, 8], ['b1']), a('b2', 'Button 2', [65, 56, 63, 8], ['b2']),
        a('full', 'Full screen', [0, 0, 128, 64], ['title', 'enc', 'k1', 'k2', 'k3', 'k4', 'b1', 'b2']),
    ]
}

const DUOX_KNOBS = ['/hmi/knob1', '/hmi/knob2'].concat([1, 2, 3, 4, 5, 6, 7, 8].map((n) => '/hmi/potentiometer' + n))
const DUOX_SWITCHES = [1, 2, 3, 4].map((n) => '/hmi/footswitch' + n)

function duox(options) {
    const taken = {}
    for (const slot of options.taken || []) {
        taken[Plan.slotKey(slot[0], slot[1], null)] = true
    }
    return {
        areas: duoxAreas('left').concat(duoxAreas('right')),
        displays: [
            { id: 'left', controls: [['/hmi/knob1'], ['/hmi/potentiometer1', '/hmi/potentiometer3'],
                                     ['/hmi/potentiometer2', '/hmi/potentiometer4'], ['/hmi/footswitch1', '/hmi/footswitch2']] },
            { id: 'right', controls: [['/hmi/knob2'], ['/hmi/potentiometer5', '/hmi/potentiometer7'],
                                      ['/hmi/potentiometer6', '/hmi/potentiometer8'], ['/hmi/footswitch3', '/hmi/footswitch4']] },
        ],
        pages: options.pages || 6,
        subpages: 1,
        layout: options.layout || [],
        knobs: DUOX_KNOBS.map((uri) => ({ uri: uri })),
        switches: DUOX_SWITCHES.map((uri) => ({ uri: uri })),
        taken: taken,
        compatible: (port, uri) => uri.indexOf('footswitch') < 0 || port.kind === 'switch',
    }
}

{
    // the cells of a display are its own: the full screen on the left leaves the right one free
    const m = duox({ layout: [{ page: 0, subpage: 0, area: 'left-full', instance: 'a', symbol: 'x' }] })
    assert.ok(!Plan.isFree(m, Plan.areaById(m, 'left-k1'), 0, 0))
    assert.ok(Plan.isFree(m, Plan.areaById(m, 'right-full'), 0, 0))
    assert.deepStrictEqual(Plan.drawableCells(m, 'right'),
                           ['right/k1', 'right/k2', 'right/k3', 'right/k4', 'right/enc', 'right/b1', 'right/b2'])
    assert.strictEqual(Plan.displayOfCell(m, 'right/b2'), 'right')
    // a selection across the displays makes no area
    assert.strictEqual(Plan.areaForCells(m, ['left/k1', 'right/k2']), null)
    assert.strictEqual(Plan.areaForCells(m, ['right/k2', 'right/k1']).id, 'right-k12')
}
{
    // the ports take the controls of the widget's display first: the right one has the endless knob 2 and the
    // buttons 3 and 4
    const plan = Plan.planPorts(duox({}), [switchPort('fire'), knobPort('move')], 0, 0, false, 'right')
    assert.deepStrictEqual(plan.targets, { fire: target('/hmi/footswitch3', 0), move: target('/hmi/knob2', 0) })
    // and the left display for a widget on the left
    const left = Plan.planPorts(duox({}), [switchPort('fire')], 0, 0, false, 'left')
    assert.deepStrictEqual(left.targets, { fire: target('/hmi/footswitch1', 0) })
}
{
    // the other display of the same page comes before the next page
    const m = duox({ taken: [['/hmi/footswitch3', 0], ['/hmi/footswitch4', 0]] })
    const plan = Plan.planPorts(m, [switchPort('fire')], 0, 0, false, 'right')
    assert.deepStrictEqual(plan.targets, { fire: target('/hmi/footswitch1', 0) })
}
{
    // two switch ports take the two buttons of one display, never one per display
    const m = duox({ taken: [['/hmi/footswitch4', 0]] })
    const plan = Plan.planPorts(m, [switchPort('a'), switchPort('b')], 0, 0, false, 'right')
    assert.deepStrictEqual(plan.targets, { a: target('/hmi/footswitch1', 0), b: target('/hmi/footswitch2', 0) })
}
{
    // Bricks: the left full screen is taken on page 1, so the right one, with the controls of the right display
    const m = duox({ layout: [{ page: 0, subpage: 0, area: 'left-full', instance: 'stars', symbol: 'stars' }] })
    const result = Plan.autoAssign(m, { minWidth: 128, minHeight: 64 }, [switchPort('FIRE'), knobPort('MOVE')])
    assert.strictEqual(result.page, 0)
    assert.strictEqual(result.area.id, 'right-full')
    assert.deepStrictEqual(result.targets, { FIRE: target('/hmi/footswitch3', 0), MOVE: target('/hmi/knob2', 0) })
}

console.log('hmiwidgetsplan: all checks passed')
