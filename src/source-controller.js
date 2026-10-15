'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { webcrack } = require('webcrack');
const { js } = require('@ast-grep/napi');
const matchesQuery = require('./match-query');

/**
 * Controller for inspecting JavaScript sources, searching within bundles,
 * deobfuscating, unpacking Webpack/Browserify modules with webcrack,
 * and performing structural AST search via ast-grep.
 */
class SourceController extends EventEmitter {
  /**
   * @param {import('puppeteer').CDPSession} cdpSession
   */
  constructor(cdpSession) {
    super();
    if (!cdpSession) throw new TypeError('CDPSession is required for SourceController');

    this._cdp = cdpSession;
    /** @type {Map<string, object>} */
    this._scripts = new Map();
    this._isEnabled = false;

    this._onScriptParsed = this._onScriptParsed.bind(this);
    this._onContextsCleared = this._onContextsCleared.bind(this);
  }

  /**
   * Enables the Debugger domain and starts collecting parsed scripts.
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
   * Disables the Debugger domain.
   * @returns {Promise<void>}
   */
  async disable() {
    if (!this._isEnabled) return;

    this._cdp.off('Debugger.scriptParsed', this._onScriptParsed);
    this._cdp.off('Runtime.executionContextsCleared', this._onContextsCleared);

    await this._cdp.send('Debugger.disable');
    this._isEnabled = false;
  }

  /**
   * Clears in-memory script cache.
   */
  clear() {
    this._scripts.clear();
  }

  /**
   * Retrieves all loaded scripts with optional filtering.
   * @param {{
   *   url?: string | RegExp,
   *   excludeInternal?: boolean
   * }} [filter]
   * @returns {Array<object>}
   */
  getScripts(filter = {}) {
    const scripts = Array.from(this._scripts.values());
    return scripts.filter((s) => {
      if (
        filter.excludeInternal &&
        (!s.url || s.url.startsWith('pptr:') || s.url.startsWith('chrome-extension:'))
      ) {
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
   * Resolves a script ID from either a scriptId string, URL, or script object.
   * Searches newest scripts first.
   * @param {string} scriptIdOrUrl
   * @returns {string}
   * @private
   */
  _resolveScriptId(scriptIdOrUrl) {
    if (this._scripts.has(scriptIdOrUrl)) {
      return scriptIdOrUrl;
    }

    // Try finding by URL (reverse order to prioritize most recently loaded scripts)
    const reversedEntries = Array.from(this._scripts.entries()).reverse();
    for (const [id, script] of reversedEntries) {
      if (script.url === scriptIdOrUrl || script.url.includes(scriptIdOrUrl)) {
        return id;
      }
    }

    if (/^\d+$/.test(scriptIdOrUrl)) {
      return scriptIdOrUrl;
    }

    throw new Error(`Script not found for identifier: ${scriptIdOrUrl}`);
  }

  /**
   * Retrieves the raw source code of a script or bundle.
   * Uses CDP Debugger.getScriptSource with transparent HTTP fallback if script was discarded.
   * @param {string} scriptIdOrUrl
   * @returns {Promise<{ scriptId: string, url: string, source: string }>}
   */
  async getScriptSource(scriptIdOrUrl) {
    const scriptId = this._resolveScriptId(scriptIdOrUrl);
    const meta = this._scripts.get(scriptId) || { scriptId, url: '' };

    try {
      const result = await this._cdp.send('Debugger.getScriptSource', { scriptId });
      if (result && result.scriptSource) {
        return {
          scriptId,
          url: meta.url,
          source: result.scriptSource,
        };
      }
    } catch (cdpErr) {
      // If Debugger.getScriptSource fails (e.g. script discarded after navigation)
      // fallback to fetching via network if URL is valid
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
   * Searches for a string or regular expression inside loaded scripts/bundles.
   * Equivalent to Chrome DevTools Source panel search (Ctrl+Shift+F).
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

    const results = [];

    for (const target of targets) {
      try {
        const response = await this._cdp.send('Debugger.searchInContent', {
          scriptId: target.scriptId,
          query: searchQuery,
          caseSensitive: Boolean(options.caseSensitive),
          isRegex: isRegex || Boolean(options.isRegex),
        });

        if (response.result && response.result.length > 0) {
          const meta = this._scripts.get(target.scriptId);
          results.push({
            scriptId: target.scriptId,
            url: meta?.url || '',
            matches: response.result.map((m) => ({
              lineNumber: m.lineNumber,
              lineContent: m.lineContent,
            })),
          });
        }
      } catch {
        // Discarded or internal scripts are safely ignored
      }
    }

    return results;
  }

  /**
   * Downloads a script or bundle directly to local disk.
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
   * Deobfuscates, unminifies, and transforms React JSX components using webcrack.
   * @param {string} scriptIdOrUrl
   * @param {import('webcrack').Options} [options]
   * @returns {Promise<{ scriptId: string, url: string, code: string, bundle?: import('webcrack').Bundle }>}
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
   * Unpacks Webpack, Browserify, or other bundled modules into individual files on disk using webcrack.
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
   * @returns {Promise<Array<{ text: string, range: object, metaMatches: Record<string, string> }>>}
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

    const tree = js.parse(code);
    const root = tree.root();
    const matchedNodes = root.findAll(pattern);

    return matchedNodes.map((node) => {
      const metaMatches = {};
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
   * Internal handler for newly parsed scripts.
   * @private
   */
  _onScriptParsed(script) {
    const entry = {
      scriptId: script.scriptId,
      url: script.url || '',
      startLine: script.startLine,
      startColumn: script.startColumn,
      endLine: script.endLine,
      endColumn: script.endColumn,
      hash: script.hash,
      isContentScript: script.isContentScript || false,
      sourceMapURL: script.sourceMapURL || '',
    };
    this._scripts.set(script.scriptId, entry);
    this.emit('scriptParsed', entry);
  }

  /**
   * Internal handler for execution contexts cleared (navigation).
   * @private
   */
  _onContextsCleared() {
    this._scripts.clear();
  }
}

module.exports = SourceController;
