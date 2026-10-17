'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { webcrack } = require('webcrack');
const { parse, Lang } = require('@ast-grep/napi');
const matchesQuery = require('./match-query');
const { safeDecode, messageOf } = require('./util');


/**
 * A loaded script, as Debugger.scriptParsed reports it, plus the fields this controller adds.
 * @typedef {Pick<import('devtools-protocol').Protocol.Debugger.ScriptParsedEvent, 'scriptId' | 'startLine' | 'startColumn' | 'endLine' | 'endColumn' | 'hash' | 'sourceMapURL' | 'length'> & { url: string }} ScriptInfo
 */

/**
 * Controller for inspecting JavaScript sources, searching within bundles,
 * deobfuscating, unpacking Webpack/Browserify modules with webcrack,
 * and performing structural AST search via ast-grep.
 */
class SourceController extends EventEmitter {
  /**
   * @param {import('puppeteer-core').CDPSession} cdpSession
   */
  constructor(cdpSession) {
    super();
    if (!cdpSession) throw new TypeError('CDPSession is required for SourceController');

    this._cdp = cdpSession;
    /** @type {Map<string, ScriptInfo>} */
    this._scripts = new Map();
    this._isEnabled = false;

    this._onScriptParsed = this._onScriptParsed.bind(this);
    this._onContextsCleared = this._onContextsCleared.bind(this);
  }

  /**
   * @returns {Promise<void>}
   */
  async enable() {
    if (this._isEnabled) return;

    this._cdp.on('Debugger.scriptParsed', this._onScriptParsed);
    this._cdp.on('Runtime.executionContextsCleared', this._onContextsCleared);

    await Promise.all([
      this._cdp.send('Debugger.enable'),
      this._cdp.send('Runtime.enable'),
    ]);
    this._isEnabled = true;
  }

  /**
   * @returns {Promise<void>}
   */
  async disable() {
    if (!this._isEnabled) return;

    this._cdp.off('Debugger.scriptParsed', this._onScriptParsed);
    this._cdp.off('Runtime.executionContextsCleared', this._onContextsCleared);

    await this._cdp.send('Debugger.disable');
    this._isEnabled = false;
  }

  clear() {
    this._scripts.clear();
  }

  /**
   * @param {{
   *   url?: string | RegExp,
   *   excludeInternal?: boolean
   * }} [filter]
   * @returns {ScriptInfo[]}
   */
  getScripts(filter = {}) {
    const scripts = Array.from(this._scripts.values());
    return scripts.filter((s) => {
      // Keep runtime scripts (empty url); only browser internals go.
      if (filter.excludeInternal && /^(pptr:|chrome-extension:)/.test(s.url)) {
        return false;
      }
      if (filter.url) {
        const matches = matchesQuery(s.url, filter.url);
        if (!matches) return false;
      }
      return true;
    });
  }

  /**
   * Scripts with an empty URL: created at runtime (eval, Function). Inline HTML blocks carry the page URL,
   * so they are not listed here. `length` comes from Debugger.scriptParsed, so it costs no transfer.
   * @returns {Promise<Array<{ scriptId: string, startLine: number, lines: number, length: number | null, head: string | null, error?: string }>>}
   */
  async listDynamicScripts() {
    const rows = this.getScripts().filter((s) => !s.url);
    return Promise.all(rows.map(async (s) => {
      const base = { scriptId: s.scriptId, startLine: s.startLine, lines: s.endLine - s.startLine + 1, length: s.length ?? null };
      try {
        const { source } = await this.getScriptSource(s.scriptId);
        return { ...base, head: source.slice(0, 100).replace(/\s+/g, ' ') };
      } catch (err) {
        // A script can be unreadable when its context was cleared (WebAssembly never lands here: it is
        // listed under wasm://wasm/<hash>, so it is not one of the URL-less scripts this method lists);
        // report that per row
        // instead of failing the whole listing.
        return { ...base, head: null, error: messageOf(err) };
      }
    }));
  }

  /**
   * A window of one script's source around a line and column, with `>>>` marking the column.
   * A minified file puts a whole module on one line, so reading a position there means reading a window.
   * @param {string} scriptIdOrUrl
   * @param {number} lineNumber 0-based line, counted as the script's own (document line for inline blocks)
   * @param {number} [columnNumber]
   * @param {number} [before] characters of context kept before the column
   * @param {number} [after] characters kept after it
   */
  async readAround(scriptIdOrUrl, lineNumber, columnNumber = 0, before = 200, after = 300) {
    const { source, url, scriptId } = await this.getScriptSource(scriptIdOrUrl);
    const lines = source.split('\n');
    const line = lines[lineNumber];
    if (line === undefined) {
      throw new Error(`Script ${scriptId} has ${lines.length} line(s): line ${lineNumber} does not exist.`);
    }
    const from = Math.max(0, columnNumber - before);
    return {
      scriptId,
      url,
      lineNumber,
      column: columnNumber,
      lineLength: line.length,
      totalLines: lines.length,
      text: `${line.slice(from, columnNumber)}>>>${line.slice(columnNumber, columnNumber + after)}`,
    };
  }

  /**
   * Lines where a function is defined in one script: `function NAME(` or `NAME = function`.
   * A match is text, not a parse: a string or a comment with the same shape also matches.
   * @param {string} scriptIdOrUrl
   * @param {string} name
   * @returns {Promise<Array<{ lineNumber: number, column: number, lineContent: string }>>}
   */
  async findFunction(scriptIdOrUrl, name) {
    if (!name) throw new TypeError('Function name must not be empty');
    const scriptId = this._resolveScriptId(scriptIdOrUrl);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const query = String.raw`(?<![\w$])(function\s+${escaped}\s*\(|${escaped}\s*=\s*function\b)`;
    const response = await this._cdp.send('Debugger.searchInContent', { scriptId, query, caseSensitive: true, isRegex: true });
    // searchInContent returns no column, and a minified line is the whole module, so derive the offset from the
    // line text: the definition reads `function NAME` or `NAME = function`. Report the start of the declaration,
    // so `async function NAME` reports the `async` rather than the `function` (a hand measurement sees the same).
    /** @param {string} lineContent */
    const columnOf = (lineContent) => {
      const at = [`function ${name}`, `${name} = function`, `${name}=function`]
        .map((needle) => lineContent.indexOf(needle))
        .filter((index) => index >= 0);
      const start = at.length ? Math.min(...at) : lineContent.indexOf(name);
      return lineContent.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start;
    };
    return (response.result ?? []).map((m) => ({
      lineNumber: m.lineNumber,
      column: columnOf(m.lineContent),
      lineContent: m.lineContent,
    }));
  }

  /**
   * @param {string} scriptIdOrUrl
   * @returns {string}
   * @private
   */
  _resolveScriptId(scriptIdOrUrl) {
    if (this._scripts.has(scriptIdOrUrl)) {
      return scriptIdOrUrl;
    }

    // A bare number is a scriptId, so it must not fall through to URL matching: "13" would otherwise match every
    // URL containing 13. Ids are only valid for the page that produced them.
    if (/^\d+$/.test(scriptIdOrUrl)) {
      throw new Error(`Script ${scriptIdOrUrl} is not in this page (scriptIds change on navigation, so list them again with: node cli.js vm-scripts). Known ids: ${Array.from(this._scripts.keys()).slice(0, 20).join(', ')}`);
    }

    // URLs are stored percent-encoded (a space is %20), so compare decoded forms too.
    // Several hits is an error, not a silent first match: the first one may be an inline script.
    const want = safeDecode(scriptIdOrUrl);
    const hits = Array.from(this._scripts.entries()).filter(([, s]) => s.url === scriptIdOrUrl || safeDecode(s.url).includes(want));
    if (hits.length === 1) return hits[0][0];
    if (hits.length > 1) {
      const exact = hits.filter(([, s]) => safeDecode(s.url) === want);
      if (exact.length === 1) return exact[0][0];
      const listing = hits.map(([id, s]) => `${id} ${s.url || '(inline)'}`).join(' | ');
      throw new Error(`"${scriptIdOrUrl}" matches ${hits.length} scripts. Pass the scriptId instead: ${listing}`);
    }

    throw new Error(`Script not found for identifier: ${scriptIdOrUrl}`);
  }

  /**
   * @param {string} scriptIdOrUrl
   * @returns {Promise<{ scriptId: string, url: string, source: string }>}
   */
  async getScriptSource(scriptIdOrUrl) {
    const scriptId = this._resolveScriptId(scriptIdOrUrl);
    const meta = this._scripts.get(scriptId) || { scriptId, url: '' };

    try {
      const result = await this._cdp.send('Debugger.getScriptSource', { scriptId });
      if (typeof result?.scriptSource === 'string') {
        return {
          scriptId,
          url: meta.url,
          source: result.scriptSource,
        };
      }
    } catch (cdpErr) {
      if (meta.url && (meta.url.startsWith('http://') || meta.url.startsWith('https://'))) {
        try {
          const res = await fetch(meta.url);
          if (res.ok) {
            const source = await res.text();
            return {
              scriptId,
              url: meta.url,
              source,
            };
          }
        } catch {}
      }
      throw cdpErr;
    }

    throw new Error(`Failed to retrieve source for script: ${scriptId}`);
  }

  /**
   * Searches the text of loaded scripts, like the DevTools Source panel search.
   * @param {string | RegExp} query
   * @param {{
   *   scriptId?: string,
   *   caseSensitive?: boolean,
   *   isRegex?: boolean,
   *   excludeInternal?: boolean
   * }} [options]
   * @returns {Promise<Array<{ scriptId: string, url: string, matches: Array<{ lineNumber: number, lineContent: string }> }>>}
   */
  async searchInSources(query, options = {}) {
    if (!query) throw new TypeError('Search query must not be empty');

    const isRegex = query instanceof RegExp;
    const searchQuery = isRegex ? query.source : query;
    const targets = options.scriptId
      ? [{ scriptId: this._resolveScriptId(options.scriptId) }]
      : this.getScripts({ excludeInternal: options.excludeInternal !== false });

    const caseSensitive = options.caseSensitive !== undefined
      ? Boolean(options.caseSensitive)
      : (isRegex ? !query.ignoreCase : false);

    const found = await Promise.all(targets.map(async (target) => {
      try {
        const response = await this._cdp.send('Debugger.searchInContent', {
          scriptId: target.scriptId,
          query: searchQuery,
          caseSensitive,
          isRegex: isRegex || Boolean(options.isRegex),
        });

        if (!response.result || response.result.length === 0) return null;
        const meta = this._scripts.get(target.scriptId);
        return {
          scriptId: target.scriptId,
          url: meta?.url || '',
          matches: response.result.map((m) => ({
            lineNumber: m.lineNumber,
            lineContent: m.lineContent,
          })),
        };
      } catch {
        return null;
      }
    }));
    return found.filter((hit) => hit !== null);
  }

  /**
   * @param {string} scriptIdOrUrl
   * @param {string} outputPath
   * @returns {Promise<{ filePath: string, bytesWritten: number, url: string }>}
   */
  async downloadBundle(scriptIdOrUrl, outputPath) {
    if (!outputPath) throw new TypeError('Output path is required');

    const { source, url } = await this.getScriptSource(scriptIdOrUrl);
    const resolvedPath = path.resolve(outputPath);

    await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.promises.writeFile(resolvedPath, source, 'utf8');

    const stats = await fs.promises.stat(resolvedPath);
    return {
      filePath: resolvedPath,
      bytesWritten: stats.size,
      url,
    };
  }

  /**
   * @param {string} scriptIdOrUrl
   * @param {import('webcrack').Options} [options]
   * @returns {Promise<{ scriptId: string, url: string, code: string, bundle?: import('webcrack').WebcrackResult['bundle'] }>}
   */
  async deobfuscateBundle(scriptIdOrUrl, options = {}) {
    const { source, url, scriptId } = await this.getScriptSource(scriptIdOrUrl);
    const result = await webcrack(source, options);

    return {
      scriptId,
      url,
      code: result.code,
      bundle: result.bundle,
    };
  }

  /**
   * @param {string} scriptIdOrUrl
   * @param {string} outputDirectory
   * @param {import('webcrack').Options} [options]
   * @returns {Promise<{ scriptId: string, url: string, outputDirectory: string, moduleCount: number }>}
   */
  async unpackBundle(scriptIdOrUrl, outputDirectory, options = {}) {
    if (!outputDirectory) throw new TypeError('Output directory is required');

    const { source, url, scriptId } = await this.getScriptSource(scriptIdOrUrl);
    const resolvedDir = path.resolve(outputDirectory);

    const result = await webcrack(source, {
      unpack: true,
      deobfuscate: true,
      unminify: true,
      ...options,
    });

    await fs.promises.mkdir(resolvedDir, { recursive: true });
    await result.save(resolvedDir);

    const moduleCount = result.bundle?.modules.size || (result.bundle ? 1 : 0);

    return {
      scriptId,
      url,
      outputDirectory: resolvedDir,
      moduleCount,
    };
  }

  /**
   * Searches code structurally using Abstract Syntax Tree (AST) patterns via ast-grep.
   * Enables finding precise syntax structures (e.g. `fetch($URL, { $$$OPTS })`, `localStorage.setItem($K, $V)`).
   * @param {string} scriptIdOrUrl
   * @param {string} pattern - AST pattern (e.g. "console.log($ARG)" or "fetch($URL, $$$)")
   * @param {{ deobfuscateFirst?: boolean }} [options]
   * @returns {Promise<Array<{ text: string, range: import('@ast-grep/napi').Range, metaMatches: Record<string, string> }>>}
   */
  async searchAst(scriptIdOrUrl, pattern, options = {}) {
    if (!pattern) throw new TypeError('AST pattern is required');

    let code;
    if (options.deobfuscateFirst) {
      const deobf = await this.deobfuscateBundle(scriptIdOrUrl);
      code = deobf.code;
    } else {
      const src = await this.getScriptSource(scriptIdOrUrl);
      code = src.source;
    }

    const tree = parse(Lang.JavaScript, code);
    const root = tree.root();
    const matchedNodes = root.findAll(pattern);

    return matchedNodes.map((node) => {
      const metaMatches = /** @type {Record<string, string>} */ ({});
      const variableNames = pattern.match(/\$[A-Z0-9_]+/g) || [];
      for (const v of variableNames) {
        const cleanName = v.replace(/^\$/, '');
        const matchedVar = node.getMatch(cleanName);
        if (matchedVar) {
          metaMatches[cleanName] = matchedVar.text();
        }
      }

      return {
        text: node.text(),
        range: node.range(),
        metaMatches,
      };
    });
  }

  /**
   * @private
   */
  /** @param {import('devtools-protocol').Protocol.Debugger.ScriptParsedEvent} script */
  _onScriptParsed(script) {
    const entry = {
      scriptId: script.scriptId,
      url: script.url || '',
      startLine: script.startLine,
      startColumn: script.startColumn,
      endLine: script.endLine,
      endColumn: script.endColumn,
      hash: script.hash,
      sourceMapURL: script.sourceMapURL || '',
      length: script.length,
    };
    this._scripts.set(script.scriptId, entry);
    this.emit('scriptParsed', entry);
  }

  /**
   * @private
   */
  _onContextsCleared() {
    this._scripts.clear();
  }
}

module.exports = SourceController;
