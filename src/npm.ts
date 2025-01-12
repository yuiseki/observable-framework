import {existsSync} from "node:fs";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path/posix";
import type {CallExpression} from "acorn";
import {simple} from "acorn-walk";
import {rsort, satisfies} from "semver";
import {isEnoent} from "./error.js";
import type {ExportNode, ImportNode, ImportReference} from "./javascript/imports.js";
import {findImports, isImportMetaResolve} from "./javascript/imports.js";
import {parseProgram} from "./javascript/parse.js";
import type {StringLiteral} from "./javascript/source.js";
import {getStringLiteralValue, isStringLiteral} from "./javascript/source.js";
import {relativePath} from "./path.js";
import {Sourcemap} from "./sourcemap.js";
import {faint} from "./tty.js";

export interface NpmSpecifier {
  name: string;
  range?: string;
  path?: string;
}

export function parseNpmSpecifier(specifier: string): NpmSpecifier {
  const parts = specifier.split("/");
  const namerange = specifier.startsWith("@") ? [parts.shift()!, parts.shift()!].join("/") : parts.shift()!;
  const ranged = namerange.indexOf("@", 1);
  return {
    name: ranged > 0 ? namerange.slice(0, ranged) : namerange,
    range: ranged > 0 ? namerange.slice(ranged + 1) : undefined,
    path: parts.length > 0 ? parts.join("/") : undefined
  };
}

export function formatNpmSpecifier({name, range, path}: NpmSpecifier): string {
  return `${name}${range ? `@${range}` : ""}${path ? `/${path}` : ""}`;
}

/** Rewrites /npm/ import specifiers to be relative paths to /_npm/. */
export function rewriteNpmImports(input: string, resolve: (specifier: string) => string = String): string {
  const body = parseProgram(input);
  const output = new Sourcemap(input);

  simple(body, {
    ImportDeclaration: rewriteImport,
    ImportExpression: rewriteImport,
    ExportAllDeclaration: rewriteImport,
    ExportNamedDeclaration: rewriteImport,
    CallExpression: rewriteImportMetaResolve
  });

  function rewriteImport(node: ImportNode | ExportNode) {
    if (node.source && isStringLiteral(node.source)) {
      rewriteImportSource(node.source);
    }
  }

  function rewriteImportMetaResolve(node: CallExpression) {
    if (isImportMetaResolve(node) && isStringLiteral(node.arguments[0])) {
      rewriteImportSource(node.arguments[0]);
    }
  }

  function rewriteImportSource(source: StringLiteral) {
    const value = getStringLiteralValue(source);
    const resolved = resolve(value);
    if (value !== resolved) output.replaceLeft(source.start, source.end, JSON.stringify(resolved));
  }

  // TODO Preserve the source map, but download it too.
  return String(output).replace(/^\/\/# sourceMappingURL=.*$\n?/m, "");
}

const npmRequests = new Map<string, Promise<string>>();

/** Note: path must start with "/_npm/". */
export async function populateNpmCache(root: string, path: string): Promise<string> {
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  const filePath = join(root, ".observablehq", "cache", path);
  if (existsSync(filePath)) return filePath;
  let promise = npmRequests.get(path);
  if (promise) return promise; // coalesce concurrent requests
  promise = (async function () {
    const specifier = resolveNpmSpecifier(path);
    const href = `https://cdn.jsdelivr.net/npm/${specifier}`;
    process.stdout.write(`npm:${specifier} ${faint("→")} `);
    const response = await fetch(href);
    if (!response.ok) throw new Error(`unable to fetch: ${href}`);
    process.stdout.write(`${filePath}\n`);
    await mkdir(dirname(filePath), {recursive: true});
    if (/^application\/javascript(;|$)/i.test(response.headers.get("content-type")!)) {
      const source = await response.text();
      const resolver = await getDependencyResolver(root, path, source);
      await writeFile(filePath, rewriteNpmImports(source, resolver), "utf-8");
    } else {
      await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    }
    return filePath;
  })();
  promise.catch(() => {}).then(() => npmRequests.delete(path));
  npmRequests.set(path, promise);
  return promise;
}

/**
 * Returns an import resolver for rewriting an npm module from jsDelivr,
 * replacing /npm/ import specifiers with relative paths, and re-resolving
 * versions against the module’s package.json file. (jsDeliver bakes-in the
 * exact version the first time a module is built and doesn’t update it when a
 * new version of a dependency is published; we always want to import the latest
 * version to ensure that we don’t load duplicate copies of transitive
 * dependencies at different versions.)
 */
export async function getDependencyResolver(
  root: string,
  path: string,
  input: string
): Promise<(specifier: string) => string> {
  const body = parseProgram(input);
  const dependencies = new Set<string>();
  const {name, range} = parseNpmSpecifier(resolveNpmSpecifier(path));

  simple(body, {
    ImportDeclaration: findImport,
    ImportExpression: findImport,
    ExportAllDeclaration: findImport,
    ExportNamedDeclaration: findImport,
    CallExpression: findImportMetaResolve
  });

  function findImport(node: ImportNode | ExportNode) {
    if (node.source && isStringLiteral(node.source)) {
      findImportSource(node.source);
    }
  }

  function findImportMetaResolve(node: CallExpression) {
    if (isImportMetaResolve(node) && isStringLiteral(node.arguments[0])) {
      findImportSource(node.arguments[0]);
    }
  }

  function findImportSource(source: StringLiteral) {
    const value = getStringLiteralValue(source);
    if (value.startsWith("/npm/")) {
      const {name: depName, range: depRange} = parseNpmSpecifier(value.slice("/npm/".length));
      if (depName === name) return; // ignore self-references, e.g. mermaid plugin
      if (existsSync(join(root, ".observablehq", "cache", "_npm", `${depName}@${depRange}`))) return; // already resolved
      dependencies.add(value);
    }
  }

  const resolutions = new Map<string, string>();

  // If there are dependencies to resolve, load the package.json and use the semver
  // range there instead of the (stale) resolution that jsDelivr provides.
  if (dependencies.size > 0) {
    const pkgPath = await populateNpmCache(root, `/_npm/${name}@${range}/package.json`);
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    for (const dependency of dependencies) {
      const {name: depName, path: depPath = "+esm"} = parseNpmSpecifier(dependency.slice("/npm/".length));
      const range =
        (name === "arquero" || name === "@uwdata/mosaic-core" || name === "@duckdb/duckdb-wasm") && depName === "apache-arrow" // prettier-ignore
          ? "latest" // force Arquero, Mosaic & DuckDB-Wasm to use the (same) latest version of Arrow
          : name === "@uwdata/mosaic-core" && depName === "@duckdb/duckdb-wasm"
          ? "1.28.0" // force Mosaic to use the latest (stable) version of DuckDB-Wasm
          : pkg.dependencies?.[depName] ?? pkg.devDependencies?.[depName] ?? pkg.peerDependencies?.[depName];
      if (range === undefined) continue; // only resolve if we find a range
      resolutions.set(dependency, await resolveNpmImport(root, `${depName}@${range}/${depPath}`));
    }
  }

  return (specifier: string) => {
    if (!specifier.startsWith("/npm/")) return specifier;
    if (resolutions.has(specifier)) specifier = resolutions.get(specifier)!;
    else specifier = `/_npm/${specifier.slice("/npm/".length)}${specifier.endsWith("/+esm") ? ".js" : ""}`;
    return relativePath(path, specifier);
  };
}

let npmVersionCache: Promise<Map<string, string[]>>;

async function initializeNpmVersionCache(root: string): typeof npmVersionCache {
  const cache = new Map<string, string[]>();
  const cacheDir = join(root, ".observablehq", "cache", "_npm");
  try {
    for (const entry of await readdir(cacheDir)) {
      if (entry.startsWith("@")) {
        for (const subentry of await readdir(join(cacheDir, entry))) {
          const {name, range} = parseNpmSpecifier(`${entry}/${subentry}`);
          const versions = cache.get(name);
          if (versions) versions.push(range!);
          else cache.set(name, [range!]);
        }
      } else {
        const {name, range} = parseNpmSpecifier(entry);
        const versions = cache.get(name);
        if (versions) versions.push(range!);
        else cache.set(name, [range!]);
      }
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  for (const [key, value] of cache) {
    cache.set(key, rsort(value));
  }
  return cache;
}

const npmVersionRequests = new Map<string, Promise<string>>();

async function resolveNpmVersion(root: string, specifier: NpmSpecifier): Promise<string> {
  const {name, range} = specifier;
  if (range && /^\d+\.\d+\.\d+([-+].*)?$/.test(range)) return range; // exact version specified
  const cache = await (npmVersionCache ??= initializeNpmVersionCache(root));
  const versions = cache.get(specifier.name);
  if (versions) for (const version of versions) if (!range || satisfies(version, range)) return version;
  const href = `https://data.jsdelivr.com/v1/packages/npm/${name}/resolved${range ? `?specifier=${range}` : ""}`;
  let promise = npmVersionRequests.get(href);
  if (promise) return promise; // coalesce concurrent requests
  promise = (async function () {
    process.stdout.write(`npm:${formatNpmSpecifier(specifier)} ${faint("→")} `);
    const response = await fetch(href);
    if (!response.ok) throw new Error(`unable to fetch: ${href}`);
    const {version} = await response.json();
    if (!version) throw new Error(`unable to resolve version: ${formatNpmSpecifier({name, range})}`);
    const spec = formatNpmSpecifier({name, range: version});
    process.stdout.write(`npm:${spec}\n`);
    cache.set(specifier.name, versions ? rsort(versions.concat(version)) : [version]);
    mkdir(join(root, ".observablehq", "cache", "_npm", spec), {recursive: true}); // disk cache
    return version;
  })();
  promise.catch(() => {}).then(() => npmVersionRequests.delete(href));
  npmVersionRequests.set(href, promise);
  return promise;
}

export async function resolveNpmImport(root: string, specifier: string): Promise<string> {
  const {
    name,
    range = name === "@duckdb/duckdb-wasm"
      ? "1.28.0" // https://github.com/duckdb/duckdb-wasm/issues/1561
      : name === "parquet-wasm"
      ? "0.5.0" // https://github.com/observablehq/framework/issues/733
      : undefined,
    path = name === "mermaid"
      ? "dist/mermaid.esm.min.mjs/+esm"
      : name === "echarts"
      ? "dist/echarts.esm.min.js"
      : "+esm"
  } = parseNpmSpecifier(specifier);
  return `/_npm/${name}@${await resolveNpmVersion(root, {name, range})}/${path.replace(/\+esm$/, "+esm.js")}`;
}

const npmImportsCache = new Map<string, Promise<ImportReference[]>>();

/**
 * Resolves the direct dependencies of the specified npm path, such as
 * "/_npm/d3@7.8.5/+esm.js", returning the corresponding set of npm paths.
 */
export async function resolveNpmImports(root: string, path: string): Promise<ImportReference[]> {
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  let promise = npmImportsCache.get(path);
  if (promise) return promise;
  promise = (async function () {
    try {
      const filePath = await populateNpmCache(root, path);
      if (!/\.(m|c)?js$/i.test(path)) return []; // not JavaScript; TODO traverse CSS, too
      const source = await readFile(filePath, "utf-8");
      const body = parseProgram(source);
      return findImports(body, path, source);
    } catch (error: any) {
      console.warn(`unable to fetch or parse ${path}: ${error.message}`);
      return [];
    }
  })();
  npmImportsCache.set(path, promise);
  return promise;
}

export function resolveNpmSpecifier(path: string): string {
  return path.replace(/^\/_npm\//, "").replace(/\/\+esm\.js$/, "/+esm");
}
