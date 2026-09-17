TISS Quick Registration Script
===========================
by [Manuel Geier](https://geier.io "Manuel Geier")

⚠️ **IMPORTANT: This project is not maintained anymore. It might still work, but also might not anymore. Use at your own risk. Feel free to fork it. All the best for your studies!**

## What is it about?

It is always very hard to get into a limited group if many other students (>200) also try to get into the same group. You have to be faster than anyone else. It was always a very thrilling moment, when the registration slots got opened. And so the idea was born to to create a automatic script, lean back and watch it doing its job in a very relaxed way.


### A brief description of the script and its possibilities

The UserScript helps you to get into the group you want on TISS fully automatically. It waits for the exact moment the registration opens, registers and confirms your registration. If you don’t want the script to do everything automatically, the focus is already set on the right button, so you only need to confirm. You can also set a specific time when the script should start.


## How it gets you the slot (v2)

Everybody in the lecture hall is clicking at the same second, so the winner is decided by
milliseconds. Version 2 removes the places where those milliseconds used to be lost:

* **No page loads during the registration.** A TISS registration is a chain of four form posts
  (register → study code → confirm → ok). The script sends those posts itself and parses the
  answers in memory, so the browser never has to download, parse, style, render and script a heavy
  JSF page three times in the middle of your registration. This is by far the biggest win.
* **It fires on the TISS clock, not on yours.** The script measures the offset between your machine
  and the TISS server from the HTTP `Date` header, narrowing the possible offset with every sample.
  A laptop clock that is half a second late used to be an instant loss; now it does not matter.
* **It sends the first request early on purpose.** The round trip time to TISS is measured during the
  clock sync, and the first request leaves `rtt/2` early so it *arrives* at TISS exactly at the
  opening moment instead of being sent then.
* **Its timers are not throttled.** Browsers clamp `setTimeout` in background tabs to one second,
  which is enough to miss the opening completely. Timers run in a Web Worker, the last milliseconds
  are spin-waited, and an inaudible tone keeps the tab from being throttled at all.
* **It starts immediately.** The script now runs at `document-start` and has no jQuery dependency,
  so it no longer waits for images, stylesheets and TISS's own JavaScript before doing anything.
* **It does not miss the opening by a polling interval.** Two request lanes run interleaved, so the
  registration is picked up within ~125ms of opening, and only one of them can ever register you.

If the registration is not open yet, the script retries. After ten seconds it backs off to a slower
interval on purpose: if it did not open by then, it will not open in the next 100ms either, and
there is no point in hammering the university's server.


## Requirements

* Google Chrome with [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo "Tampermonkey"), or
* Firefox with [Greasemonkey](https://addons.mozilla.org/de/firefox/addon/greasemonkey "Greasemonkey")

No other dependencies. Version 2 no longer loads jQuery.


## Usage

1. Download the UserScript and install it to Tampermonkey/Greasemonkey.
1. Configure the script (see Configuration) to fulfill your requirements for a specific registration to a group.
1. Go to the specific LVA/Group registration webpage in TISS, where you want to register.
1. Enable the script.
1. Click once anywhere on the page. That allows the script to keep the tab from being throttled if
   you switch to another tab. (Staying on the tab works too.)
1. Lean back and let the script do its job.
1. Don’t forget to disable the UserScript if the registration is done.

### Getting the most out of it

* Open the registration page a few minutes early, so the clock synchronisation is done and the
  connection to TISS is warm before it matters.
* Use `startAtSpecificTime` with the exact opening time. It is more accurate than reloading
  manually, and the countdown shown in the top right corner is in TISS server time.
* Use a wired connection if you have one. The script compensates for your latency, but it cannot
  compensate for jitter.
* Make sure you are logged in to TISS. If your session expired the script tells you instead of
  silently failing.


## Configuration

All options are documented in the script itself, at the top. The ones you always set:

| Option | Meaning |
| --- | --- |
| `registrationType` | `group`, `lva` or `exam` |
| `nameOfGroup` | exact group name, e.g. `Gruppe 001` (extra spaces do not matter) |
| `nameOfExam` / `dateOfExam` | for `registrationType: "exam"`, the date disambiguates exams with the same name |
| `lvaNumber`, `lvaSemester` | safety checks so you cannot register for the wrong course |
| `studyCode` | only needed if you have more than one study code |
| `startAtSpecificTime`, `specificStartTime` | when the registration opens |

The speed related options below them (`turboMode`, `syncServerClock`, `leadTimeMs`,
`pollIntervalMs`, `parallelLanes`, `useWorkerTimer`, `keepAwake`, ...) already default to the fast
settings and normally need no changes.

If you set `autoRegister` or `autoConfirm` to `false` because you want to press the final button
yourself, the script automatically falls back to the classic in-page behaviour: it opens the panel,
highlights the button and puts the keyboard focus on it.


## Changelog

Can be found within the script.


## License

MIT (see LICENSE)


## Support

If you find any errors or bugs, or have ideas for improvement, please simply create a ticket in the issue tracker:
https://github.com/mangei/tissquickregistrationscript/issues

Thanks :)

## Disclaimer

By utilizing this script, you acknowledge and agree that I, the author, bear no responsibility for any consequences, damages, losses, or liabilities incurred as a result of its usage. This script is provided "as is," without any warranties or guarantees of any kind, expressed or implied. Users are solely responsible for assessing the suitability, accuracy, and safety of the script for their intended purposes. I disclaim all responsibility for any errors, omissions, or inaccuracies within the script. It is recommended that users exercise caution and diligence when employing this script, and they do so at their own risk.
