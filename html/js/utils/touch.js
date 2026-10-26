// SPDX-FileCopyrightText: 2012-2026 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Turns a finger (or pen) into a mouse for the parts of the UI that only speak mouse:
// the jQuery UI draggables (plugins, jacks, the plugin bar) and the pedalboard pan.
// Replaces jquery.ui.touch-punch, which had two problems on tablets:
//  - it only switches on when the browser exposes touch events ('ontouchend' in
//    document), which desktop Chrome/Firefox on a touchscreen often do not;
//  - it starts a drag on the first pixel of movement, so the jitter of a finger turns
//    every tap on a jack into a tiny drag that reverts, and tap-to-connect never starts.
// Built on Pointer Events, and a touch only becomes a mouse press once it has moved
// TOUCH_SLOP pixels. A touch released before that is left alone, and the browser's own
// click is what reaches the page, so a tap stays a tap.

var TOUCH_SLOP = 10

;(function ($) {
    if (! window.PointerEvent) {
        return
    }

    // the gesture being translated, one at a time
    var current = null

    var isMouseWidget = function (el) {
        var data = $.data(el)
        for (var key in data) {
            if (data[key] instanceof $.ui.mouse) {
                return true
            }
        }
        return false
    }

    // Whether a touch landing on `target` should be translated. Walks up from the target:
    // anything that handles touchstart itself (the modgui knobs and switches) or takes
    // text keeps the touch, a jQuery UI mouse widget or an element marked with
    // data-touch-mouse gets the translation, and anything else is left to the browser.
    var wantsMouse = function (target) {
        for (var el = target; el && el.nodeType === 1; el = el.parentNode) {
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) {
                return false
            }
            var events = $._data(el, 'events')
            if (events && events.touchstart) {
                return false
            }
            if (el.hasAttribute('data-touch-mouse') || isMouseWidget(el)) {
                return true
            }
        }
        return false
    }

    var dispatch = function (type, target, ev) {
        var mouse = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: 1,
            screenX: ev.screenX,
            screenY: ev.screenY,
            clientX: ev.clientX,
            clientY: ev.clientY,
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1,
        })
        target.dispatchEvent(mouse)
    }

    var end = function () {
        if (current && current.pressed) {
            dispatch('mouseup', current.target, current.last)
        }
        current = null
    }

    document.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType === 'mouse') {
            return
        }
        // a second finger ends the translation, the pedalboard reads two fingers as a pinch
        if (! ev.isPrimary) {
            end()
            return
        }
        if (! wantsMouse(ev.target)) {
            return
        }
        // keeps the browser from sending its own mousedown/mouseup after the touch, which
        // would arrive late and press things twice. The click is not affected by this.
        ev.preventDefault()
        current = {
            id: ev.pointerId,
            target: ev.target,
            start: ev,
            last: ev,
            pressed: false,
        }
    }, true)

    document.addEventListener('pointermove', function (ev) {
        if (! current || ev.pointerId !== current.id) {
            return
        }
        current.last = ev
        if (! current.pressed) {
            var dx = ev.clientX - current.start.clientX
            var dy = ev.clientY - current.start.clientY
            if (dx * dx + dy * dy < TOUCH_SLOP * TOUCH_SLOP) {
                return
            }
            // pressed where the finger went down, so a dragged jack does not jump by the slop
            current.pressed = true
            dispatch('mousedown', current.target, current.start)
        }
        dispatch('mousemove', current.target, ev)
    }, true)

    document.addEventListener('pointerup', function (ev) {
        if (current && ev.pointerId === current.id) {
            end()
        }
    }, true)

    document.addEventListener('pointercancel', function (ev) {
        if (current && ev.pointerId === current.id) {
            end()
        }
    }, true)
})(jQuery)
