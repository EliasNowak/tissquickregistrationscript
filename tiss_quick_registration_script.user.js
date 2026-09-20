// ==UserScript==
// @name       TISS Quick Registration Script
// @namespace  http://www.manuelgeier.com/
// @version    2.0.1
// @description  Registers you for a TISS group/LVA/exam as fast as technically possible. Syncs to the TISS server clock, fires at the exact millisecond the registration opens and drives the whole register -> study code -> confirm -> ok chain with background requests instead of full page loads.
// @match      https://tiss.tuwien.ac.at/*
// @run-at     document-start
// @grant      none
// @noframes
// @copyright  2020 Manuel Geier, MIT License
// ==/UserScript==

/*
MIT License

Copyright (c) 2020 Manuel Geier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/*
 Changelog:

 v2.0.1 [20.09.2026]
 + Added: dryRun option. Runs the complete chain except the registration itself, so you can
   verify your setup days in advance instead of at 20:00:00.
 + Added: detection for a userscript manager that runs the script in a sandbox, where the
   background requests would go out without your TISS session cookie.
 + Added: the script checks itself that it runs in the top window, because Greasemonkey
   does not honour @noframes.
 + Added: a log note when the browser blocks the precise worker timer.

 v2.0.0 [17.09.2026]
 + Added: turbo mode. The whole registration chain (register -> study code -> confirm -> ok)
   now runs as background requests. No page is ever rendered in between, which removes
   roughly 3 full page loads of a heavy JSF page from the critical path.
 + Added: server clock synchronisation. The script measures the offset between your
   machine and the TISS server (via the HTTP Date header, interval-narrowing over several
   samples) and fires relative to *server* time, not your possibly skewed local clock.
 + Added: automatic lead time. Measures the round trip time to TISS and sends the first
   request early by rtt/2 so it *arrives* at the server exactly at the opening moment.
 + Added: precise scheduling. Timers run in a Web Worker (background tabs throttle window
   timers to 1s) and the final milliseconds are spin-waited, so the fire time is hit within ~1ms.
 + Added: parallel polling lanes, so the opening moment is not missed by up to one poll interval.
 + Added: keep-awake, prevents background tab throttling (needs one click on the page).
 + Changed: script now runs at document-start instead of document-idle. It no longer waits
   for images/CSS/TISS javascript before doing anything.
 + Removed: jQuery dependency. No more blocking http:// @require, everything is native DOM.
 + Removed: the 100ms sleep that was only needed to visually open the group panel.
 ~ Classic mode (the old click-the-buttons-in-the-page behaviour) is still available and is
   used automatically when you disable autoRegister/autoConfirm.

 v.1.6.3 [18.12.2020]
 + Added: date of exam support

 v.1.6.2 [09.01.2020]
 + Improve countdown format (Thanks @Heholord, #14)

 v.1.6.1 [13.10.2019]
 ~ Fix: Ignore multiple spaces on group label comparison. (@zarmonious, #13)

 v.1.6.0 [28.11.2018]
 + Added: exam-registration support (Thanks to @XtomtomX, #11)

 v1.5.3 [29.02.2016]
 ~ Added: .gitignore
 ~ Fix: missing reference to 'options' object
 ~ Fix: wrong option name ('semesterCheckEnabled' instead of 'lvaSemesterCheckEnabled')
 ~ String/Number compare with === instead of ==, and !== instead of !=
 ~ Fix #9: id no longer available for wrapper element. replace it by element itself and adjust selectors.
 ~ Fix: toggle for groups (now without id selector)
 ~ Fix: group name selector now matches the exact name and not only if it contains the name

 v1.5.2 [?]
 - went missing :P

 v1.5.1 [09.10.2015]
 ~ Fix: adjusts group label selector
 ~ Fix: Remove leading zero for month which leads to unintended octal interpretation

 v1.5 [04.10.2015]
 + allow to enter a study code, if you have multiple ones
 + add flags to en-/disable checks
 ~ Code cleanup

 v1.4 [07.09.2013]
 + show or hide logoutput on screen (option: showLog [true/false])
 + many improvements
 ~ Code refactoring

 v1.3 [01.03.2013]
 + Feature: automatically presses the Ok button at the final info page
 ~ Code refactoring

 v1.2 [27.02.2013]
 + Feature: ability to register to a LVA; just set 'isGroupRegistration' to 'false'
 + Feature: selected group label is now marked with light green
 ~ Bugfix/Quickfix: overflow in setTimeout causes an constant refresh of the page; now the page gets refreshed at least often if the specific start time is in the future

 v1.1
 + Feature: Let the script start at a specific time.

 v1.0 (2012)
 Initial release
 */

(function () {
    'use strict';

    // Only run in the top window. @noframes is not honoured by every userscript manager,
    // and a second instance inside an iframe would start its own registration.
    if (window.top !== window.self) {
        return;
    }

    ///////////////////////////////////////////////////////////////////////
    // Configurate the script here
    //

    var options = {
        // global option to enable or disable the script [true,false]
        scriptEnabled: true,

        // define here the type of registration [lva,group,exam]
        registrationType: "group",

        // name of you the group you want to join (only for registrationType 'group') [String]
        nameOfGroup: "Gruppe 001",

        // name of the exam which you want to join (only for registrationType 'exam') [String]
        nameOfExam: "Name Of Exam",

        // date of the exam which you want to join, especially when there are multiple exams with the same name (only for registrationType 'exam') [String]
        dateOfExam: '',

        // checks if you are at the correct lva page
        lvaCheckEnabled: true,

        // only if the number is right, the script is enabled [String]
        lvaNumber: "123.456",

        // if you have multiple study codes, enter here the study code number you want
        // to register for eg. '123456' (no blanks). Otherwise leave empty. [String]
        studyCode: '',

        // checks if you are at the correct semester
        lvaSemesterCheckEnabled: true,

        // only if the semester is right, the script is enabled [String]
        lvaSemester: "2019W",

        // automatically opens the detail panel of a group [true,false]
        // (only relevant in classic mode, turbo mode does not need the panel at all)
        openPanel: true,

        // automatically presses the register button if it is available [true,false]
        autoRegister: true,

        // automatically presses the confirm button for your registration [true,false]
        autoConfirm: true,

        // keep trying until the script can register you [true,false]
        autoRefresh: true,

        // automatically presses the ok button on the confirmation info page [true,false]
        autoOkPressAtEnd: true,

        // a delay on the confirm info page, until the ok button gets pressed
        // this is useful if you want to continuously cycle through the registration process
        // until you are registered and with this parameter you can define a "cycle delay" at the end.
        // This could happen, if (for some reason) you are not on the whitelist for this course.
        // [Integer]
        okPressAtEndDelayInMs: 1000,

        // let the script start at a specific time [true,false]
        startAtSpecificTime: true,

        // define the specific time the script should start [Date]
        // new Date(year, month, day, hours, minutes, seconds, milliseconds)
        // note: months start with 0
        specificStartTime: new Date(2020, 1 - 1, 9, 20, 27, 0, 0),

        // show log output of the script on screen [true,false]
        showLog: true,

        ///////////////////////////////////////////////////////////////////
        // Speed settings. The defaults are already the fast ones,
        // you normally do not have to touch anything below this line.
        //

        // Turbo mode: run the whole registration chain
        // (register -> study code -> confirm -> ok) with background requests
        // instead of loading and rendering a page for every single step.
        // This is the single biggest speedup, keep it on. [true,false]
        turboMode: true,

        // Align to the TISS server clock instead of trusting your own machine.
        // Your local clock being 400ms late is the classic reason for losing a slot. [true,false]
        syncServerClock: true,

        // How many samples to use for the clock synchronisation. More samples = more
        // accurate, ~16 is already enough to get well below 100ms. [Integer]
        clockSyncSamples: 20,

        // How many milliseconds before the target time the first request is sent, so that it
        // *arrives* at TISS exactly at the opening moment.
        // 'auto' measures your round trip time and derives it. [Integer or 'auto']
        leadTimeMs: 'auto',

        // Kept for compatibility with older configs. If you set this to something
        // other than 300 it is used as leadTimeMs. [Integer]
        delayAdjustmentInMs: 300,

        // Delay between two attempts while the registration is not open yet. With the
        // default 2 lanes this means an attempt every ~125ms during the hot moment.
        // Going lower gains you nothing and just hammers TISS. [Integer]
        pollIntervalMs: 250,

        // If the registration did not open within this many ms after the target time, it is
        // not going to open in the next 100ms either, so the script backs off to
        // slowPollIntervalMs. [Integer]
        fastPollWindowMs: 10000,

        // Polling interval after fastPollWindowMs has passed. [Integer]
        slowPollIntervalMs: 1500,

        // How long to keep hammering after the target time before giving up, in ms.
        // Only relevant when autoRefresh is on. [Integer]
        attackWindowMs: 120000,

        // Number of overlapping request lanes around the opening moment. With 1 lane you can
        // be up to one poll interval late, 2-3 lanes close that gap. Please keep this small. [Integer]
        parallelLanes: 2,

        // Open the TCP/TLS connection to TISS before the opening moment, so the handshake
        // is not part of your first request. [true,false]
        preconnect: true,

        // The last few milliseconds before the fire time are spin-waited for precision. [Integer]
        precisionSpinMs: 25,

        // Run timers in a Web Worker. Window timers get throttled to 1/second in
        // background tabs, which can make you miss the opening entirely. [true,false]
        useWorkerTimer: true,

        // Play an inaudible tone to stop the browser from throttling this tab when it is in
        // the background. Needs one click anywhere on the page to be allowed to start. [true,false]
        keepAwake: true,

        // Reload the page after a successful registration so you see the real TISS state. [true,false]
        reloadAfterSuccess: true,

        // Dry run: do everything (clock sync, fetch the page, run the checks, find the
        // register button) but stop right before actually registering. Use this a few days
        // before the real registration to verify that your browser and userscript manager
        // work, instead of finding out at 20:00:00. [true,false]
        dryRun: false,

        // verbose console output [true,false]
        debug: false
    };

    //
    // End of configuration
    ///////////////////////////////////////////////////////////////////////


    ///////////////////////////////////////////////////////////////////////
    // Small native DOM / string helpers (this script has no jQuery on purpose:
    // an @require is an extra blocking download before the script may run).
    //

    var REGISTER_VALUES = ['Anmelden', 'Voranmelden', 'Voranmeldung'];
    var LIST_TABS = ['LVA-Anmeldung', 'Gruppen', 'Prüfungen'];

    function qs(selector, root) {
        return (root || document).querySelector(selector);
    }

    function qsa(selector, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    }

    function textOf(element) {
        return element ? element.textContent.trim() : '';
    }

    // collapses runs of whitespace, so "Gruppe  001" and "Gruppe 001" compare equal
    function norm(value) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    }

    // text of the element itself, without the text of its children (former jQuery.justtext)
    function ownText(element) {
        if (!element) {
            return '';
        }
        var out = '';
        for (var i = 0; i < element.childNodes.length; i++) {
            var node = element.childNodes[i];
            if (node.nodeType === 3) {
                out += node.nodeValue;
            }
        }
        return out.trim();
    }

    function contains(haystack, needle) {
        var h = norm(haystack);
        var n = norm(needle);
        if (n === '') {
            return true;
        }
        if (h.indexOf(n) !== -1) {
            return true;
        }
        // the old version matched with a regex, keep that working for existing configs
        try {
            return new RegExp(needle).test(h);
        } catch (e) {
            return false;
        }
    }

    function ready(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    }

    function debug() {
        if (options.debug) {
            console.log.apply(console, ['[TQR]'].concat(Array.prototype.slice.call(arguments)));
        }
    }


    ///////////////////////////////////////////////////////////////////////
    // Timer. Window timers are clamped to >= 1 second in background tabs, which is
    // enough to miss the registration opening completely. A worker is not clamped
    // nearly as hard, and the last milliseconds are spin-waited for precision.
    //

    var Timer = (function () {
        var worker = null;
        var seq = 0;
        var pending = {};

        function getWorker() {
            if (worker !== null || !options.useWorkerTimer) {
                return worker;
            }
            try {
                var source = 'onmessage=function(e){var d=e.data;setTimeout(function(){postMessage(d.id);},d.ms);};';
                var url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
                worker = new Worker(url);
                worker.onmessage = function (event) {
                    var resolve = pending[event.data];
                    if (resolve) {
                        delete pending[event.data];
                        resolve();
                    }
                };
            } catch (e) {
                debug('worker timer unavailable', e);
                worker = false;
            }
            return worker;
        }

        function sleep(ms) {
            if (!(ms > 0)) {
                return Promise.resolve();
            }
            var w = getWorker();
            return new Promise(function (resolve) {
                if (w) {
                    var id = ++seq;
                    pending[id] = resolve;
                    w.postMessage({ id: id, ms: ms });
                } else {
                    setTimeout(resolve, ms);
                }
            });
        }

        // Waits until Clock.now() reaches targetServerTime. onTick gets the remaining ms.
        async function waitUntil(targetServerTime, onTick) {
            var spin = Math.max(0, options.precisionSpinMs | 0);
            for (;;) {
                var remaining = targetServerTime - Clock.now();
                if (remaining <= spin) {
                    break;
                }
                if (onTick) {
                    onTick(remaining);
                }
                // small chunks close to the target, so a throttled or drifting timer
                // gets corrected instead of overshooting
                var chunk = remaining < 5000 ? 200 : 1000;
                await sleep(Math.min(remaining - spin, chunk));
            }
            while (Clock.now() < targetServerTime) {
                // busy wait, at most options.precisionSpinMs
            }
        }

        return {
            sleep: sleep,
            waitUntil: waitUntil,
            // false means we fell back to window timers, which browsers throttle in
            // background tabs (a strict Content-Security-Policy can cause this)
            usesWorker: function () { return !!getWorker(); }
        };
    })();


    ///////////////////////////////////////////////////////////////////////
    // Clock. Your local clock is very likely not the TISS clock. We derive the offset
    // from the HTTP Date header: it only has second resolution, but every response
    // narrows the possible offset interval, and after a handful of samples spread
    // across a second boundary the remaining uncertainty is small.
    //

    var Clock = (function () {
        var state = {
            offset: 0,
            uncertainty: Infinity,
            rtt: 0,
            synced: false
        };

        function now() {
            return Date.now() + state.offset;
        }

        async function sync() {
            if (!options.syncServerClock) {
                return state;
            }
            var samples = Math.max(4, options.clockSyncSamples | 0);
            var url = location.origin + '/favicon.ico';
            var low = -Infinity;
            var high = Infinity;
            var rtts = [];

            for (var i = 0; i < samples; i++) {
                var before = Date.now();
                var header;
                try {
                    var response = await fetch(url + '?_tqr=' + before, {
                        method: 'GET',
                        cache: 'no-store',
                        credentials: 'omit'
                    });
                    header = response.headers.get('Date');
                } catch (e) {
                    debug('clock sync request failed', e);
                    break;
                }
                var after = Date.now();
                if (!header) {
                    break;
                }
                var serverSecond = Date.parse(header);
                if (isNaN(serverSecond)) {
                    break;
                }

                // the response was produced somewhere in [before, after] local time, and the
                // real server time then was somewhere in [serverSecond, serverSecond + 1000)
                var sampleLow = serverSecond - after;
                var sampleHigh = serverSecond + 1000 - before;
                rtts.push(after - before);

                if (sampleLow > high || sampleHigh < low) {
                    // inconsistent (clock stepped?) - restart from this sample
                    low = sampleLow;
                    high = sampleHigh;
                } else {
                    low = Math.max(low, sampleLow);
                    high = Math.min(high, sampleHigh);
                }

                // spread the samples so they cover a server second boundary
                await Timer.sleep(110);
            }

            if (low > -Infinity && high < Infinity && low <= high) {
                state.offset = Math.round((low + high) / 2);
                state.uncertainty = Math.round((high - low) / 2);
                rtts.sort(function (a, b) { return a - b; });
                state.rtt = rtts.length ? rtts[Math.floor(rtts.length / 2)] : 0;
                state.synced = true;
            }
            return state;
        }

        return {
            now: now,
            sync: sync,
            get offset() { return state.offset; },
            get uncertainty() { return state.uncertainty; },
            get rtt() { return state.rtt; },
            get synced() { return state.synced; }
        };
    })();


    ///////////////////////////////////////////////////////////////////////
    // Keep the tab from being throttled while it is in the background.
    // An inaudible tone makes the browser treat the tab as "playing audio".
    //

    function keepAwake() {
        if (!options.keepAwake) {
            return;
        }
        var start = function () {
            try {
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) {
                    return;
                }
                var ctx = new Ctx();
                var gain = ctx.createGain();
                gain.gain.value = 0.0001;
                var osc = ctx.createOscillator();
                osc.frequency.value = 20;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start();
                ctx.resume();
                UI.log('Background throttling protection active.');
            } catch (e) {
                debug('keepAwake failed', e);
            }
        };
        // autoplay policies require a gesture, so arm it on the first interaction
        document.addEventListener('click', start, { once: true });
        document.addEventListener('keydown', start, { once: true });
    }


    ///////////////////////////////////////////////////////////////////////
    // On screen output. Kept as a fixed overlay so it never reflows the TISS page.
    //

    var UI = (function () {
        var box = null;
        var countdownField = null;
        var outputField = null;
        var logField = null;
        var pendingLogs = [];
        var lines = 0;

        function build() {
            if (box || !document.body) {
                return;
            }
            box = document.createElement('div');
            box.id = 'TQRScript';
            box.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;max-width:420px;' +
                'max-height:90vh;overflow:auto;background:#FFFCD9;border:1px solid #c9c48f;' +
                'border-radius:0 0 0 6px;padding:8px 10px;font-family:monospace;font-size:11pt;' +
                'color:#000;box-shadow:0 2px 8px rgba(0,0,0,.25);';

            countdownField = document.createElement('div');
            countdownField.id = 'TQRScriptCountdown';
            countdownField.style.cssText = 'color:blue;font-weight:bold;font-size:14pt;padding:2px 0;';

            outputField = document.createElement('div');
            outputField.id = 'TQRScriptOutput';
            outputField.style.cssText = 'color:red;font-weight:bold;font-size:14pt;padding:2px 0;';

            logField = document.createElement('div');
            logField.id = 'TQRScriptLog';
            logField.style.cssText = 'font-size:10pt;padding-top:4px;';
            logField.style.display = options.showLog ? 'block' : 'none';
            var title = document.createElement('b');
            title.textContent = 'Information Log:';
            logField.appendChild(title);

            box.appendChild(countdownField);
            box.appendChild(outputField);
            box.appendChild(logField);
            document.body.appendChild(box);

            while (pendingLogs.length) {
                append(pendingLogs.shift());
            }
        }

        function append(text) {
            var line = document.createElement('div');
            line.textContent = text;
            logField.appendChild(line);
            if (++lines > 300) {
                logField.removeChild(logField.childNodes[1]);
                lines--;
            }
        }

        function log(text) {
            console.log('[TQR] ' + text);
            if (!logField) {
                pendingLogs.push(text);
                return;
            }
            append(text);
        }

        function out(text) {
            log(text);
            if (outputField) {
                outputField.textContent = text;
            }
        }

        function countdown(text) {
            if (countdownField) {
                countdownField.textContent = text;
            }
        }

        function success(text) {
            log(text);
            if (outputField) {
                outputField.style.color = 'green';
                outputField.textContent = text;
            }
        }

        return { build: build, log: log, out: out, countdown: countdown, success: success };
    })();

    function formatDuration(ms) {
        var total = Math.max(0, ms) / 1000;
        var out = '';
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        var seconds = total % 60;
        if (hours > 0) {
            out += hours + ' hours, ';
        }
        if (hours > 0 || minutes > 0) {
            out += minutes + ' minutes and ';
        }
        out += (total < 10 ? seconds.toFixed(1) : Math.floor(seconds)) + ' seconds';
        return out;
    }

    function formatDate(date) {
        return date.getDate() + '.' + (date.getMonth() + 1) + '.' + date.getFullYear() + ' ' +
            date.getHours() + ':' + ('0' + date.getMinutes()).slice(-2) + ':' +
            ('0' + date.getSeconds()).slice(-2) + '.' + ('00' + date.getMilliseconds()).slice(-3);
    }


    ///////////////////////////////////////////////////////////////////////
    // Page inspection. Every one of these takes a Document, so the exact same logic
    // runs against the live page (classic mode) and against a document that was
    // fetched in the background and parsed (turbo mode).
    //

    function getLVANumber(doc) {
        return textOf(qs('#contentInner h1 span', doc));
    }

    function getLVAName(doc) {
        return ownText(qs('#contentInner h1', doc));
    }

    function getSubHeader(doc) {
        return textOf(qs('#contentInner #subHeader', doc));
    }

    function getSelectedTab(doc) {
        return textOf(qs('li.ui-tabs-selected', doc));
    }

    function submitButtons(scope) {
        return qsa('input[type="submit"]', scope);
    }

    function findButtonByValue(scope, values) {
        var buttons = submitButtons(scope);
        // values are ordered by preference ('Anmelden' before 'Voranmelden')
        for (var i = 0; i < values.length; i++) {
            for (var j = 0; j < buttons.length; j++) {
                if (buttons[j].value.trim() === values[i]) {
                    return buttons[j];
                }
            }
        }
        return null;
    }

    function getRegistrationButton(wrapper) {
        return findButtonByValue(wrapper, REGISTER_VALUES);
    }

    function getCancelButton(wrapper) {
        var buttons = submitButtons(wrapper).filter(function (button) {
            return button.value.trim() === 'Abmelden';
        });
        if (options.registrationType === 'lva') {
            buttons = buttons.filter(function (button) {
                return button.id !== 'registrationForm:confirmOkBtn';
            });
        }
        return buttons.length ? buttons[0] : null;
    }

    function getConfirmButton(doc) {
        var form = qs('form#regForm', doc);
        return form ? findButtonByValue(form, REGISTER_VALUES) : null;
    }

    function getOkButton(doc) {
        var form = qs('form#confirmForm', doc);
        return form ? findButtonByValue(form, ['Ok']) : null;
    }

    function getStudyCodeSelect(doc) {
        var form = qs('form#regForm', doc);
        return form ? qs('select', form) : null;
    }

    function getGroupWrapper(doc, name) {
        var wanted = norm(name);
        var labels = qsa('.groupWrapper .header_element span', doc);
        for (var i = 0; i < labels.length; i++) {
            if (norm(labels[i].textContent) === wanted) {
                return { wrapper: labels[i].closest('.groupWrapper'), label: labels[i] };
            }
        }
        return null;
    }

    function getExamWrapper(doc) {
        var headers = qsa('.groupWrapper .header_element', doc);
        for (var i = 0; i < headers.length; i++) {
            var nameSpan = qs('span', headers[i]);
            if (!nameSpan || !contains(nameSpan.textContent, options.nameOfExam)) {
                continue;
            }
            // the rest of the header line is the date of the exam
            var rest = norm(headers[i].textContent).replace(norm(nameSpan.textContent), '');
            if (!contains(rest, options.dateOfExam)) {
                continue;
            }
            return { wrapper: headers[i].closest('.groupWrapper'), label: headers[i] };
        }
        return null;
    }

    // The thing we want to register for, whatever registrationType says.
    function findTarget(doc) {
        if (options.registrationType === 'exam') {
            return getExamWrapper(doc);
        }
        var name = options.registrationType === 'lva' ? 'LVA-Anmeldung' : options.nameOfGroup;
        return getGroupWrapper(doc, name);
    }

    function targetName() {
        if (options.registrationType === 'exam') {
            return options.nameOfExam + (options.dateOfExam ? ' (' + options.dateOfExam + ')' : '');
        }
        return options.registrationType === 'lva' ? 'LVA-Anmeldung' : options.nameOfGroup;
    }

    // Both checks return null when everything is fine, and the error message otherwise,
    // so the caller decides how to report it.
    function checkLva(doc) {
        if (!options.lvaCheckEnabled) {
            return null;
        }
        var found = getLVANumber(doc).replace(/[^\d]/g, '');
        var wanted = String(options.lvaNumber).replace(/[^\d]/g, '');
        if (found !== wanted) {
            return 'wrong lva number error: expected: ' + wanted + ', got: ' + found;
        }
        return null;
    }

    function checkSemester(doc) {
        if (!options.lvaSemesterCheckEnabled) {
            return null;
        }
        var subHeader = getSubHeader(doc);
        if (subHeader.indexOf(options.lvaSemester) === -1) {
            return 'wrong semester error: expected: ' + options.lvaSemester + ', got: ' + subHeader.substring(0, 5);
        }
        return null;
    }

    function checkPage(doc) {
        return checkLva(doc) || checkSemester(doc);
    }

    function isLoginPage(doc, url) {
        if (/login\.xhtml/i.test(url || '')) {
            return true;
        }
        return !!qs('input[type="password"]', doc);
    }

    // If the page you are looking at is logged in but the page we fetched in the background
    // is not, then the request went out without your session cookie. That is what a
    // userscript manager running the script in a sandbox instead of in the page looks like.
    function sessionWasCarriedOver(fetched) {
        var liveLogout = qs('a[href*="logout"]', document);
        if (!liveLogout) {
            return true; // cannot tell, do not cry wolf
        }
        return !!qs('a[href*="logout"]', fetched);
    }

    function highlight(element) {
        if (element && element.style) {
            element.style.backgroundColor = 'lightgreen';
        }
    }


    ///////////////////////////////////////////////////////////////////////
    // Turbo mode: talk to TISS directly instead of loading and rendering pages.
    //
    // A registration step in TISS is a plain JSF form post. We can build and send that
    // post ourselves and parse the answer, which skips the browser's whole
    // navigate -> parse -> css -> render -> run page scripts cycle for every step.
    // The ViewState always comes from the response we are answering, so it is never stale.
    //

    var parser = new DOMParser();

    function parseDocument(html) {
        return parser.parseFromString(html, 'text/html');
    }

    // Same URL we are on, minus the per-request JSF id that must not be replayed.
    function registrationPageUrl() {
        try {
            var url = new URL(location.href);
            url.searchParams.delete('dsrid');
            url.hash = '';
            return url.href;
        } catch (e) {
            return location.href;
        }
    }

    function serializeForm(form, submitter) {
        var params = new URLSearchParams();
        var elements = form.elements;
        for (var i = 0; i < elements.length; i++) {
            var element = elements[i];
            var type = (element.type || '').toLowerCase();
            if (!element.name || element.disabled) {
                continue;
            }
            if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') {
                continue;
            }
            if ((type === 'checkbox' || type === 'radio') && !element.checked) {
                continue;
            }
            if (element.tagName === 'SELECT') {
                var selected = qsa('option', element).filter(function (option) { return option.selected; });
                if (!selected.length && element.options.length) {
                    selected = [element.options[0]];
                }
                selected.forEach(function (option) { params.append(element.name, option.value); });
                continue;
            }
            params.append(element.name, element.value);
        }
        // a form post carries the name/value of the button that submitted it, and JSF
        // decides what to do from exactly that
        if (submitter && submitter.name) {
            params.append(submitter.name, submitter.value == null ? '' : submitter.value);
        }
        return params;
    }

    async function httpGet(url) {
        var response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
        });
        var html = await response.text();
        return { doc: parseDocument(html), url: response.url || url, status: response.status };
    }

    async function submitForm(button, baseUrl) {
        var form = button.form || button.closest('form');
        if (!form) {
            throw new Error('button without form');
        }
        var action = form.getAttribute('action') || baseUrl;
        var target = new URL(action, baseUrl).href;
        var response = await fetch(target, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'text/html,application/xhtml+xml'
            },
            body: serializeForm(form, button).toString()
        });
        var html = await response.text();
        return { doc: parseDocument(html), url: response.url || target, status: response.status };
    }

    function selectStudyCode(select) {
        if (!options.studyCode) {
            return;
        }
        var options_ = qsa('option', select);
        var hit = null;
        for (var i = 0; i < options_.length; i++) {
            if (options_[i].value === options.studyCode || contains(options_[i].textContent, options.studyCode)) {
                hit = options_[i];
                break;
            }
        }
        if (!hit) {
            UI.log('study code ' + options.studyCode + ' not offered, keeping the preselected one');
            return;
        }
        options_.forEach(function (option) { option.selected = false; });
        hit.selected = true;
    }

    function classifyPage(doc) {
        var tab = getSelectedTab(doc);
        if (LIST_TABS.indexOf(tab) !== -1) {
            return 'list';
        }
        if (getStudyCodeSelect(doc)) {
            return 'studyCode';
        }
        if (getConfirmButton(doc)) {
            return 'confirm';
        }
        if (getOkButton(doc)) {
            return 'done';
        }
        if (findTarget(doc)) {
            return 'list';
        }
        return 'unknown';
    }

    // Walks the whole register -> study code -> confirm -> ok chain without
    // ever handing control back to the browser's navigation.
    async function runRegistrationChain(page) {
        for (var step = 0; step < 8; step++) {
            var kind = classifyPage(page.doc);
            debug('chain step', step, kind, page.url);

            if (kind === 'list') {
                var target = findTarget(page.doc);
                if (!target) {
                    return { ok: false, retry: false, reason: targetName() + ' not found on the page' };
                }
                if (getCancelButton(target.wrapper)) {
                    return { ok: true, reason: 'you are registered in: ' + targetName() };
                }
                var registerButton = getRegistrationButton(target.wrapper);
                if (!registerButton) {
                    return { ok: false, retry: true, reason: 'not open yet' };
                }
                UI.log('found "' + registerButton.value.trim() + '" -> submitting (+' +
                    (Clock.now() - windowOpenedAt) + 'ms)');
                page = await submitForm(registerButton, page.url);
                continue;
            }

            if (kind === 'studyCode') {
                var select = getStudyCodeSelect(page.doc);
                selectStudyCode(select);
                var studyConfirm = getConfirmButton(page.doc);
                if (!studyConfirm) {
                    return { ok: false, retry: true, reason: 'study code page without confirm button' };
                }
                page = await submitForm(studyConfirm, page.url);
                continue;
            }

            if (kind === 'confirm') {
                var confirmButton = getConfirmButton(page.doc);
                page = await submitForm(confirmButton, page.url);
                continue;
            }

            if (kind === 'done') {
                if (options.autoOkPressAtEnd) {
                    await submitForm(getOkButton(page.doc), page.url);
                }
                return { ok: true, reason: 'registration confirmed for: ' + targetName() };
            }

            return { ok: false, retry: true, reason: 'unexpected page in the registration chain' };
        }
        return { ok: false, retry: true, reason: 'registration chain did not finish' };
    }

    var windowOpenedAt = 0;
    var checksDone = false;

    // One polling lane: fetch the page, and the moment the register button is there,
    // grab it. Several lanes run interleaved so the opening is not missed by a
    // whole poll interval.
    async function pollingLane(laneIndex, state) {
        var stagger = Math.round(options.pollIntervalMs / Math.max(1, options.parallelLanes)) * laneIndex;
        await Timer.sleep(stagger);

        while (!state.finished && Clock.now() < state.deadline) {
            var startedAt = Clock.now();
            try {
                var page = await httpGet(registrationPageUrl());
                if (state.finished) {
                    return;
                }
                state.attempts++;

                if (isLoginPage(page.doc, page.url)) {
                    state.finished = true;
                    state.result = { ok: false, reason: 'your TISS session expired, please log in again' };
                    return;
                }

                if (!sessionWasCarriedOver(page.doc)) {
                    state.finished = true;
                    state.result = { ok: false, reason: 'background requests are going out without your TISS ' +
                        'session. Make sure "@grant none" is still in the script header, or set turboMode: false.' };
                    return;
                }

                if (!checksDone) {
                    var problem = checkPage(page.doc);
                    if (problem) {
                        state.finished = true;
                        state.result = { ok: false, reason: problem };
                        return;
                    }
                    checksDone = true;
                }

                var target = findTarget(page.doc);
                if (target && getCancelButton(target.wrapper)) {
                    state.finished = true;
                    state.result = { ok: true, reason: 'you are already registered in: ' + targetName() };
                    return;
                }

                if (target && getRegistrationButton(target.wrapper)) {
                    // claim it before any other lane can start a second registration
                    if (state.claimed) {
                        return;
                    }
                    state.claimed = true;
                    var result = await runRegistrationChain(page);
                    if (result.ok) {
                        state.finished = true;
                        state.result = result;
                        return;
                    }
                    UI.log('attempt failed: ' + result.reason);
                    state.result = result;
                    state.claimed = false;
                    if (!result.retry || !options.autoRefresh) {
                        state.finished = true;
                        return;
                    }
                }
            } catch (error) {
                debug('lane error', error);
                state.errors++;
            }

            if (!options.autoRefresh) {
                state.finished = true;
                return;
            }
            var interval = (Clock.now() - windowOpenedAt) < options.fastPollWindowMs
                ? options.pollIntervalMs
                : options.slowPollIntervalMs;
            await Timer.sleep(interval - (Clock.now() - startedAt));
        }
    }

    // Everything the real run does, except the part that actually registers you.
    async function runDryRun() {
        UI.log('--- DRY RUN, nothing will be registered ---');
        var startedAt = Date.now();
        var page;
        try {
            page = await httpGet(registrationPageUrl());
        } catch (error) {
            UI.out('DRY RUN FAILED: the background request did not go through (' + error.message + ')');
            return;
        }
        UI.log('background request ok, ' + (Date.now() - startedAt) + 'ms, status ' + page.status);

        if (isLoginPage(page.doc, page.url)) {
            UI.out('DRY RUN FAILED: TISS answered with the login page. Log in to TISS first.');
            return;
        }
        if (!sessionWasCarriedOver(page.doc)) {
            UI.out('DRY RUN FAILED: the request went out without your TISS session. Check that ' +
                '"@grant none" is in the script header, or set turboMode: false.');
            return;
        }
        UI.log('your TISS session is used by the background requests: ok');

        var problem = checkPage(page.doc);
        if (problem) {
            UI.out('DRY RUN FAILED: ' + problem);
            return;
        }
        UI.log('lva number and semester: ok');

        var target = findTarget(page.doc);
        if (!target) {
            UI.out('DRY RUN FAILED: "' + targetName() + '" was not found on this page. Check the name.');
            return;
        }
        UI.log('found "' + targetName() + '" on the page: ok');

        if (getCancelButton(target.wrapper)) {
            UI.success('DRY RUN: you are already registered here. Everything works.');
            return;
        }
        var registerButton = getRegistrationButton(target.wrapper);
        if (registerButton) {
            UI.success('DRY RUN: registration is open right now. The real run would press "' +
                registerButton.value.trim() + '" immediately. Everything works.');
        } else {
            UI.success('DRY RUN: everything works. Registration is not open yet, so there is no ' +
                'button to press - that is expected.');
        }
    }

    async function runTurbo() {
        windowOpenedAt = Clock.now();
        var state = {
            finished: false,
            claimed: false,
            attempts: 0,
            errors: 0,
            result: null,
            deadline: options.autoRefresh ? Clock.now() + options.attackWindowMs : Infinity
        };

        var lanes = [];
        var laneCount = options.autoRefresh ? Math.max(1, options.parallelLanes | 0) : 1;
        for (var i = 0; i < laneCount; i++) {
            lanes.push(pollingLane(i, state));
        }
        await Promise.all(lanes);

        var took = Clock.now() - windowOpenedAt;
        var result = state.result || { ok: false, reason: 'gave up after ' + formatDuration(options.attackWindowMs) };

        if (result.ok) {
            UI.success(result.reason + ' (' + took + 'ms, ' + state.attempts + ' attempts)');
            if (options.reloadAfterSuccess) {
                await Timer.sleep(Math.max(0, options.okPressAtEndDelayInMs));
                location.reload();
            }
        } else {
            UI.out(result.reason);
        }
    }


    ///////////////////////////////////////////////////////////////////////
    // Classic mode: the original behaviour, clicking the real buttons in the page.
    // Used when you did not allow the script to register/confirm on its own, so
    // you can do the final click yourself.
    //

    function classicRefresh() {
        location.reload();
    }

    function onListPage() {
        var problem = checkPage(document);
        if (problem) {
            UI.out(problem);
            return;
        }
        var target = findTarget(document);
        if (!target) {
            UI.out(targetName() + ' not found');
            return;
        }
        highlight(target.label);

        var wrapper = target.wrapper;
        if (options.openPanel) {
            qsa(':scope > *', wrapper).forEach(function (child) { child.style.display = ''; });
        }

        var registerButton = getRegistrationButton(wrapper);
        if (registerButton) {
            highlight(registerButton);
            registerButton.focus();
            if (options.autoRegister) {
                registerButton.click();
            }
            return;
        }

        if (getCancelButton(wrapper)) {
            UI.out('you are registered in: ' + targetName());
            return;
        }

        UI.out('no registration button found');
        if (options.autoRefresh) {
            classicRefresh();
        }
    }

    function onStudyCodeSelectPage() {
        var select = getStudyCodeSelect(document);
        var confirmButton = getConfirmButton(document);
        if (!confirmButton) {
            return;
        }
        highlight(confirmButton);
        if (select) {
            selectStudyCode(select);
        }
        confirmButton.focus();
        if (options.autoConfirm) {
            confirmButton.click();
        }
    }

    function onConfirmPage() {
        var confirmButton = getConfirmButton(document);
        highlight(confirmButton);
        confirmButton.focus();
        if (options.autoConfirm) {
            confirmButton.click();
        }
    }

    function onConfirmInfoPage() {
        var okButton = getOkButton(document);
        highlight(okButton);
        if (options.autoOkPressAtEnd) {
            setTimeout(function () {
                var button = getOkButton(document);
                if (button) {
                    button.click();
                }
            }, options.okPressAtEndDelayInMs);
        }
    }

    function runClassic() {
        var kind = classifyPage(document);
        UI.log('page type: ' + kind);
        if (kind === 'list') {
            onListPage();
        } else if (kind === 'studyCode') {
            onStudyCodeSelectPage();
        } else if (kind === 'confirm') {
            onConfirmPage();
        } else if (kind === 'done') {
            onConfirmInfoPage();
        }
    }


    ///////////////////////////////////////////////////////////////////////
    // Startup
    //

    function useTurbo() {
        if (!options.turboMode) {
            return false;
        }
        // turbo means "do the whole chain for me". If you want to press something
        // yourself, the classic in-page flow is the right one.
        if (!options.autoRegister || !options.autoConfirm) {
            UI.log('autoRegister/autoConfirm disabled -> using classic mode');
            return false;
        }
        if (typeof fetch !== 'function' || typeof DOMParser !== 'function' || typeof URLSearchParams !== 'function') {
            UI.log('browser too old for turbo mode -> using classic mode');
            return false;
        }
        return true;
    }

    function resolveLeadTime() {
        var configured = options.leadTimeMs;
        // old configs only had delayAdjustmentInMs
        if (configured === 'auto' && options.delayAdjustmentInMs !== 300) {
            configured = options.delayAdjustmentInMs;
        }
        if (configured !== 'auto' && isFinite(configured)) {
            return Math.max(0, configured | 0);
        }
        var uncertainty = isFinite(Clock.uncertainty) ? Clock.uncertainty : 150;
        var lead = Math.ceil(Clock.rtt / 2) + uncertainty + 20;
        return Math.min(1000, Math.max(20, lead));
    }

    function preconnect() {
        if (!options.preconnect) {
            return;
        }
        try {
            var link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = location.origin;
            (document.head || document.documentElement).appendChild(link);
        } catch (e) {
            debug('preconnect failed', e);
        }
    }

    async function main() {
        if (!options.scriptEnabled) {
            UI.log('TISS Quick Registration Script disabled');
            return;
        }

        UI.log('TISS Quick Registration Script v2.0.1 enabled');
        UI.log('LVA: ' + getLVANumber(document) + ' ' + getLVAName(document));
        UI.log('Target: ' + targetName());
        UI.log('Tab: ' + getSelectedTab(document));

        keepAwake();

        if (!Timer.usesWorker()) {
            UI.log('Note: precise worker timers are not available here, keep this tab in the ' +
                'foreground so the browser does not throttle the countdown.');
        }

        // highlight what we are going to register for, so you can see it is the right one
        var target = findTarget(document);
        if (target) {
            highlight(target.label);
        }

        if (!useTurbo()) {
            if (options.startAtSpecificTime) {
                var classicStart = options.specificStartTime.getTime() - options.delayAdjustmentInMs;
                UI.log('Script starts at: ' + formatDate(options.specificStartTime));
                await Timer.waitUntil(classicStart, function (remaining) {
                    UI.countdown('Refresh in: ' + formatDuration(remaining));
                });
                UI.countdown('');
                classicRefresh();
                return;
            }
            runClassic();
            return;
        }

        // Clock sync runs while you are still waiting, it costs nothing in the hot path.
        if (options.startAtSpecificTime || options.syncServerClock) {
            await Clock.sync();
            if (Clock.synced) {
                UI.log('Server clock: your machine is ' + (Clock.offset > 0 ? 'behind' : 'ahead') + ' by ' +
                    Math.abs(Clock.offset) + 'ms (+/-' + Clock.uncertainty + 'ms), rtt ' + Clock.rtt + 'ms');
            } else {
                UI.log('Server clock sync not available, using the local clock');
            }
        }

        if (options.dryRun) {
            await runDryRun();
            return;
        }

        if (options.startAtSpecificTime) {
            var lead = resolveLeadTime();
            var fireAt = options.specificStartTime.getTime() - lead;
            UI.log('Registration opens at: ' + formatDate(options.specificStartTime));
            UI.log('Firing ' + lead + 'ms early so the request arrives on time');

            var preconnected = false;
            await Timer.waitUntil(fireAt, function (remaining) {
                UI.countdown('Go in: ' + formatDuration(remaining));
                if (!preconnected && remaining < 5000) {
                    preconnected = true;
                    preconnect();
                }
            });
            UI.countdown('GO');
        }

        await runTurbo();
    }

    ready(function () {
        UI.build();
        main().catch(function (error) {
            UI.out('script error: ' + (error && error.message ? error.message : error));
            console.error(error);
        });
    });
})();
