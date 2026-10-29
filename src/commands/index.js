'use strict';
// The command surface: cli.js looks a verb up in COMMANDS and calls it with one Ctx, so this file is the only
// place that knows which verb maps to which implementation.
const T = require('../timeouts');
const { isHttpUrl } = require('../cli/args');
const { emit } = require('../cli/output');
const { attach, release } = require('../cli/session');

const { createBundleCommands } = require('./bundles');
const { createLayoutCommands } = require('./layout');
const { createRuntimeCommands } = require('./runtime');
const { createRevealCommands } = require('./reveal');
const debug = require('./debug');
const traffic = require('./traffic');
const visual = require('./visual');
const dom = require('./dom');
const lifecycle = require('./lifecycle');

// The script, layout, runtime and reveal commands are still built by a factory: they predate src/cli/* and take
// the same four helpers this file used to hand them one by one.
const shared = { attach, emit, release, isHttpUrl, T };
const { cmdSearchSources, cmdDownloadBundle, cmdDeobfuscate, cmdUnpack, cmdAstSearch, cmdVmScripts, cmdFindFunction, cmdSnippet } = createBundleCommands(shared);
const { cmdLayout } = createLayoutCommands(shared);
const { cmdCatchScript } = createRevealCommands(shared);
const { cmdEvents, cmdProfile } = createRuntimeCommands(shared);

/**
 * Command table: one lookup instead of a 52-case switch. Every command in HELP_TEXT has an entry here.
 * @type {Record<string, (ctx: import('../cli/session').Ctx) => Promise<unknown>>}
 */
const COMMANDS = {
  'start': lifecycle.cmdStart,
  'dump-forms': dom.cmdDumpForms,
  'dump-storage': dom.cmdDumpStorage,
  'listeners': dom.cmdListeners,
  'search-sources': cmdSearchSources,
  'download-bundle': cmdDownloadBundle,
  'deobfuscate': cmdDeobfuscate,
  'unpack': cmdUnpack,
  'ast-search': cmdAstSearch,
  'vm-scripts': cmdVmScripts,
  'find-function': cmdFindFunction,
  'snippet': cmdSnippet,
  'layout': cmdLayout,
  'catch-script': cmdCatchScript,
  'events': cmdEvents,
  'profile': cmdProfile,
  'mirror': lifecycle.cmdMirror,
  'mirror-run': lifecycle.cmdMirrorRun,
  'index-site': lifecycle.cmdIndexSite,
  'traffic': traffic.cmdTraffic,
  'console': traffic.cmdConsole,
  'raw': traffic.cmdRaw,
  'search-bodies': traffic.cmdSearchBodies,
  'ws-frames': traffic.cmdWsFrames,
  'globals': traffic.cmdGlobals,
  'objects': traffic.cmdObjects,
  'eval': debug.cmdEval,
  'break': debug.cmdBreak,
  'close': lifecycle.cmdClose,
  'snapshot': dom.cmdSnapshot,
  'click': dom.cmdInteract,
  'type': dom.cmdInteract,
  'fill': dom.cmdInteract,
  'press': dom.cmdInteract,
  'tabs': lifecycle.cmdTabs,
  'frames': lifecycle.cmdFrames,
  'status': lifecycle.cmdStatus,
  'step': debug.cmdStep,
  'postmessage': traffic.cmdPostMessage,
  'replay': traffic.cmdReplay,
  'search-traffic': traffic.cmdSearchTraffic,
  'ws-search': traffic.cmdWsSearch,
  'inspect': traffic.cmdInspect,
  'workers': lifecycle.cmdWorkers,
  'purge': lifecycle.cmdPurge,
  'doctor': traffic.cmdDoctor,
  'resume': debug.cmdResume,
  'goto': lifecycle.cmdGoto,
  'click-at': visual.cmdClickAt,
  'drag': visual.cmdDrag,
  'wheel': visual.cmdWheel,
  'key': visual.cmdKey,
  'canvas': visual.cmdCanvas,
  'wait': dom.cmdWait,
  'clean': lifecycle.cmdClean,
};

module.exports = { COMMANDS };
