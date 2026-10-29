'use strict';
// The usage text is data, so it lives apart from the code that dispatches on it.
const HELP_TEXT = `
Usage: node cli.js <command> [options] [arguments]

Commands:
  start                         Start Chrome with remote debugging on port 9222
  dump-forms [url]              Audit all forms, methods, actions, and inputs (inc. hidden)
  dump-storage [url]            Dump localStorage, sessionStorage, and cookies (a URL navigates
                                there first; omit it to read the tab as it is)
  listeners [url] [selector]    Audit event listeners on target selector or 'window'
  search-sources [url] <query>  Search across all loaded script bundles. Plain query =
                                case-insensitive substring; use --re for regex
  download-bundle [url] <queryOrId> <destFile>
                                Download matching script bundle to local file
  deobfuscate [url] <queryOrId> [destFile]
                                Deobfuscate & unminify script using webcrack
  unpack [url] <queryOrId> <destDir>
                                Unpack Webpack/Browserify modules into folder
  ast-search [url] <queryOrId> <pattern>
                                Structural AST search using ast-grep (e.g. 'fetch($U, $$$)')
  vm-scripts [url]              List scripts with no URL (created by eval/Function):
                                scriptId, start line, line count, and the first 100 characters
  find-function [url] <queryOrId> <name>
                                Lines where a function is defined ("function NAME(" or "NAME = function"),
                                with the column of the definition; each line cut to 300 characters
  snippet [url] <queryOrId> <line> [--col N] [--before N] [--after N]
                                Read a window of a script's source around a position, marking the column
                                with >>>. Use it after find-function or catch-script: a minified script is one
                                huge line, so a position in it can only be read as a window
  layout [url] [--wait S]       Record style, layout, pre-paint and paint for S seconds (default 5; interact
                                meanwhile) and report totals and the script location that caused each stage
  events [url]                  Every event listener registered on the window and the document tree
                                (and iframes), grouped by event type and handler location
  catch-script [url] [--min-bytes N] [--max-bytes N] [--only-runtime] [--break-line N] [--break-col N]
                                [--eval <expr>] [--frame N] [--timeout S]
                                Pause before a script runs, report the script and the stack, then (with
                                --break-line) stop inside that script, list the variables of the frame and of
                                its caller, and run --eval (--frame picks the frame, default 0). Reaches code
                                with no URL that the break command cannot name. Narrows the target with
                                --min-bytes/--max-bytes (script characters) and --only-runtime (scripts with
                                no URL, which skips inline HTML blocks)
  profile [url] [--wait S]      CPU profile for S seconds (default 5; interact meanwhile): functions by
                                self time, with the two callers that called them most
  mirror start <url> [outDir]   Load the URL with the cache off and start recording in the
                                background: every request and response (raw headers, cookies
                                included), WebSocket frames, and bodies, until you stop it.
                                Lazy loads and API calls after your interaction are kept.
                                Writes outDir/<host>/<timestamp>/ (default .tmp/mirror)
  mirror stop [outDir]          Stop the active recording; writes cookies.json, storage.json,
                                rendered.html and manifest.json. LATEST names the newest run
  index-site <stampDir>         Unpack every JS file of a mirror run with webcrack
                                into <stampDir>/unpacked
  traffic [url] [--bodies] [--wait S] [--headers] [--full] [--no-redact]
                                Record network + WebSocket frames. With a URL: navigate,
                                wait for network idle, then for the first WS frame.
                                Without: attach to the live tab and record --wait S
                                (default 5) while the user interacts. --bodies drains
                                each response body into the result
  eval [url] <expression> [--frame U] [--file script.js]   (--file: read the expression from a file)
  console [url] [--level error|warning|info|debug] [--filter text] [--limit N] [--wait S]
                                Console messages and uncaught exceptions from this
                                invocation (a URL navigates first; otherwise listen --wait S)
  raw [url] <id|url-part> [--response] [--wait S] [--no-redact]
                                Raw HTTP request (or --response) with unnormalized headers,
                                ready to paste into Burp Repeater
  search-bodies [url] <text|/regex/> [--wait S]
                                Search recorded response bodies (native search + fallback)
  ws-frames [url] [--direction sent|received] [--query text] [--hex] [--limit N] [--wait S]
                                WebSocket frames; --hex decodes binary frames
  globals [--frame U] [--filter text] [--limit N]
                                Global names on window (state, engines, tokens), with type/ctor
  objects <SomeClass.prototype> [--limit N]
                                Live instances of a class in the V8 heap
  doctor                        Diagnose node, Chrome, tab, page, debugger and mirror state
                                Evaluate JavaScript in the page. Passing a URL navigates
                                first; without one it evaluates on the current tab.
                                --frame U runs it inside the iframe whose URL contains U
  break [url] <scriptQuery> <line>
                                Set a Debugger breakpoint (URL substring match) and wait
                                for the hit. Line is SCRIPT-relative and 0-based: line N
                                of the source as shown by search-sources/getScriptSource
                                (inline <script> blocks are auto-offset). Flags:
                                --col N, --condition <expr>, --eval <expr> (runs on the
                                top call frame), --timeout S (default 15), --hold
                                (ignored: Chrome resumes when the command exits),
                                --exceptions (also pause on exceptions),
                                --trigger <js> (run this JavaScript after arming, in the same
                                session: the action that loads the script goes here)
  goto <url>                    Navigate the tab to a URL and report the final url and title
  resume                        Resume the page if it is paused in the debugger (for example
                                after a breakpoint was left armed by another command)
  close                         Close the current tab (tabs are otherwise left open —
                                you close them by hand)

Interaction loop — operate the live tab one step at a time, like a person:
  snapshot [url] [selector]     List interactive elements currently visible (buttons,
                                links, inputs...). READ THIS before every action
  click [url] <sel|text=Text>   Click, then report what changed (url, added/removed
                                elements). selector looks like CSS; text=Click Me
                                matches by visible text instead
  type [url] <sel> <text>       Keystroke-by-keystroke into an input, reports the value
  fill [url] <sel> <value>      Set an input value directly (fires input/change)
  press [url] <key>             Press a key on the focused element (Enter, Tab, Escape)
  tabs                          List open tabs (index, url, title). Every command uses
                                tab 0 unless --tab N selects another one
  frames                        List child iframes: index, canvas count, element count, url.
                                --frame takes a substring of the url or this index
  status                        Is Chrome reachable on --port, and is a mirror recording running?
  step [url] <query> <line> [--trigger "<js>"] [--into|--out] [--times N] [--eval expr]
                                Pause once, then step N times, reporting each stop with its
                                frames. Step across calls is impossible (each call is its own
                                CDP session), so the breakpoint and trigger live here
  step --pause [--times N]      Pause whatever is running now, then step
  postmessage [url] [--wait S]  Record window.postMessage traffic (the hook applies to
                                documents created after it, so pass a URL)
  replay [url] <id|url-part>    Re-send a recorded XHR/fetch with Chrome's own replayXHR
  search-traffic [url] <text|/re/>
                                Find a recorded request by url, body or headers
  ws-search [url] <text|/re/> [--direction sent|received]
                                Find recorded WebSocket frames by payload
  inspect [url] <expression>    Deep property dump (cycles, DOM nodes, functions)
  workers                       Dedicated/service/shared workers and their URLs
  purge --cache --cookies       Delete the browser cache and/or the profile's cookies
  mirror-run <url> <runDir>     Record a page into a mirror run directory (internal: used by
                                mirror's worker; records every request, response and lazy load)
  clean                         Delete the scratch folder .tmp/ inside the skill (this also deletes
                                mirror runs and anything else under .tmp/; copy what you need first)
  click-at <x> <y> [--frame U] [--canvas] [--index N] [--button left|right|middle]
                                Mouse click at a coordinate. With --frame, x/y are relative
                                to that iframe; --canvas adds the canvas offset and converts
                                bitmap pixels to CSS pixels (a scaled canvas is handled).
                                --settle waits for network idle first (only after a load)
  drag <x1> <y1> <x2> <y2> [--frame U] [--canvas] [--index N] [--button left|right|middle] [--steps N]
                                Press, move in steps, release: aiming, sliders, map pans.
                                --canvas converts bitmap pixels like click-at
  wheel <dx> <dy> [--frame U] [--canvas] [--index N] [--x N --y N]
                                Real mouse wheel at the frame centre (or the canvas centre
                                with --canvas) unless x/y are given
  key <code...> [--hold MS]     Hold one key or a chord (KeyW+ShiftLeft) on the focused
                                element. Click the game first so its frame has focus
  canvas [--list] [--frame U] [--index N] [--out F.png] [--screen] [--record S --fps N] [--preserve]
                                --list every canvas (index, bitmap, css, visible). Without
                                --index the largest visible canvas is used, which is the game
                                one when ads draw their own. --out saves the pixels,
                                --screen the composited pixels (WebGL, no reload),
                                --record S --out <dir> a PNG sequence
  wait [url] <selector> [--timeout S]
                                Wait for a selector to appear (default 5s)

Tabs are never closed automatically: every command attaches to the live tab (re-
navigating only when you pass a URL) and leaves it open on exit, so page state —
logins, SPA routes, WebSocket sessions — survives between commands.

Options:
  --port <number>               CDP port (default: 9222)
  --json                        Format output as structured JSON (traffic default: table)
  --out <file>                  Write the JSON result to a file instead of stdout;
                                prints the path plus a short summary (every command
                                that produces structured output)
  --help                        Display this help message
  --version                     Print the version
`;

module.exports = { HELP_TEXT };
