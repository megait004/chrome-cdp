'use strict';
// Commands that read the scripts a page loaded: search, download, deobfuscate, unpack, and AST search.
// cli.js passes in its attach, output, and cleanup helpers, so these commands behave the same as the rest.
const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {InstanceType<typeof import('../chrome-client')>} Client
 * @typedef {{ args: string[], port: number, outFile: string | null }} Ctx
 * @typedef {{
 *   attach: (port: number) => Promise<Client>,
 *   emit: (result: object, outFile: string | null) => Promise<void>,
 *   release: (client: Client) => Promise<void>,
 *   isHttpUrl: (s: string | undefined) => boolean,
 *   T: { CLI_NAV_TIMEOUT_MS: number },
 * }} BundleDeps
 */

/** @param {BundleDeps} deps */
function createBundleCommands({ attach, emit, release, isHttpUrl, T }) {
  /** @param {Ctx} ctx */
  async function cmdSearchSources({ args, port, outFile }) {
    // Strip --re first so it can sit on either side of the query.
    const useRegex = args.includes('--re');
    const rest = args.filter((a) => a !== '--re');
    const url = rest[1] && isHttpUrl(rest[1]) ? rest[1] : null;
    const query = url ? rest[2] : rest[1];
    if (!query) {
      throw new Error('Search query required: node cli.js search-sources [url] <query>');
    }

    const client = await attach(port);
    // networkidle2: scripts register with the debugger asynchronously, so searching right after
    // domcontentloaded can miss inline scripts (same reason traffic waits for network idle)
    if (url) await client.goto(url, { waitUntil: 'networkidle2', timeout: T.CLI_NAV_TIMEOUT_MS });

    // CLI args are plain strings; the API needs a RegExp instance for regex search.
    // A leading '/' gets path-mangled by Git Bash (MSYS), so regex is opt-in via --re.
    const searchQuery = useRegex ? new RegExp(query) : query;

    const results = await client.sources.searchInSources(searchQuery);
    await emit({ query, count: results.length, matches: results }, outFile);

    await release(client);
  }

  /** @param {Ctx} ctx */
  async function cmdDownloadBundle({ args, port }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const queryOrId = url ? args[2] : args[1];
    const destFile = url ? args[3] : args[2];
    if (!queryOrId || !destFile) {
      throw new Error('Usage: node cli.js download-bundle [url] <queryOrId> <destFile>');
    }

    const client = await attach(port);
    if (url) await client.goto(url);

    const downloadRes = await client.sources.downloadBundle(queryOrId, destFile);
    console.log(`Successfully downloaded bundle: ${downloadRes.filePath} (${downloadRes.bytesWritten} bytes)`);

    await release(client);
  }

  /** @param {Ctx} ctx */
  async function cmdDeobfuscate({ args, port }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const queryOrId = url ? args[2] : args[1];
    const destArg = url ? args[3] : args[2];
    const destFile = destArg && !destArg.startsWith('--') ? destArg : null;
    if (!queryOrId) {
      throw new Error('Usage: node cli.js deobfuscate [url] <queryOrId> [destFile]');
    }

    const client = await attach(port);
    if (url) await client.goto(url);

    const deobf = await client.sources.deobfuscateBundle(queryOrId);
    if (destFile) {
      await fs.promises.writeFile(path.resolve(destFile), deobf.code, 'utf8');
      console.log(`Saved deobfuscated code to: ${path.resolve(destFile)}`);
    } else {
      console.log(deobf.code);
    }

    await release(client);
  }

  /** @param {Ctx} ctx */
  async function cmdUnpack({ args, port }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const queryOrId = url ? args[2] : args[1];
    const destDir = url ? args[3] : args[2];
    if (!queryOrId || !destDir) {
      throw new Error('Usage: node cli.js unpack [url] <queryOrId> <destDir>');
    }

    const client = await attach(port);
    if (url) await client.goto(url);

    const unpackRes = await client.sources.unpackBundle(queryOrId, destDir);
    if (unpackRes.moduleCount === 0) {
      // webcrack found no webpack/browserify structure; it still wrote the deobfuscated code to the folder
      console.log(`No bundle structure found; saved the deobfuscated code as one file in: ${unpackRes.outputDirectory}`);
    } else {
      console.log(`Successfully unpacked ${unpackRes.moduleCount} modules to: ${unpackRes.outputDirectory}`);
    }

    await release(client);
  }

  /** @param {Ctx} ctx */
  async function cmdAstSearch({ args, port, outFile }) {
    const url = args[1] && isHttpUrl(args[1]) ? args[1] : null;
    const queryOrId = url ? args[2] : args[1];
    const pattern = url ? args[3] : args[2];
    if (!queryOrId || !pattern) {
      throw new Error('Usage: node cli.js ast-search [url] <queryOrId> <pattern>');
    }

    const client = await attach(port);
    if (url) await client.goto(url);

    const astMatches = await client.sources.searchAst(queryOrId, pattern);
    await emit({ pattern, count: astMatches.length, matches: astMatches }, outFile);

    await release(client);
  }

  return { cmdSearchSources, cmdDownloadBundle, cmdDeobfuscate, cmdUnpack, cmdAstSearch };
}

module.exports = { createBundleCommands };
