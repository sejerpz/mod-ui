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

console.log('hmiwidgetsplan: all checks passed')
