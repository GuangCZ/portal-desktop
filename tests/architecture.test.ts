import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const root = path.resolve("desktop");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sources(file)
      : /\.(?:ts|tsx|js)$/.test(file)
        ? [file]
        : [];
  });
}
const edges = ["main", "preload", "renderer", "shared"].flatMap((layer) =>
  sources(path.join(root, layer)).flatMap((file) => {
    const imports: string[] = [];
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === "require") &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imports.push(node.argument.literal.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    return imports.map((specifier) => ({
      layer,
      source: path.relative(root, file).replaceAll(path.sep, "/"),
      specifier,
      target: specifier.startsWith(".")
        ? path
            .relative(root, path.resolve(path.dirname(file), specifier))
            .replaceAll(path.sep, "/")
        : specifier,
    }));
  }),
);
const nodeImport = (specifier: string) =>
  specifier.startsWith("node:") || builtinModules.includes(specifier);

test("renderer cannot import privileged process code or Node/Electron APIs", () => {
  expect(
    edges.filter(
      (edge) =>
        edge.layer === "renderer" &&
        (/^(?:main|preload)\//.test(edge.target) ||
          edge.specifier === "electron" ||
          nodeImport(edge.specifier)),
    ),
  ).toEqual([]);
});

test("main and preload do not depend on renderer implementation", () => {
  expect(
    edges.filter(
      (edge) =>
        ["main", "preload"].includes(edge.layer) &&
        edge.target.startsWith("renderer/"),
    ),
  ).toEqual([]);
});

test("shared contracts and renderer utilities do not depend on feature implementations", () => {
  expect(
    edges.filter(
      (edge) =>
        edge.layer === "shared" &&
        (/^(?:main|preload|renderer)\//.test(edge.target) ||
          edge.specifier === "electron" ||
          nodeImport(edge.specifier)),
    ),
  ).toEqual([]);
  expect(
    edges.filter(
      (edge) =>
        edge.source.startsWith("renderer/shared/") &&
        edge.target.startsWith("renderer/") &&
        !edge.target.startsWith("renderer/shared/"),
    ),
  ).toEqual([]);
});

test("the retired chat page is gone from the renderer", () => {
  // renderer/chat was the sandboxed Loom document the React conversation
  // replaced on 2026-09-16; it and the main-process request proxy behind
  // `beings://chat` were deleted together. Its services fetched from a Being in
  // the renderer, which is exactly what the native layer exists to stop doing:
  // every byte the conversation shows now arrives over IPC. Assert the absence
  // rather than a rule about it, so re-creating the directory fails here.
  expect(
    sources(path.join(root, "renderer")).filter((file) =>
      path
        .relative(root, file)
        .replaceAll(path.sep, "/")
        .startsWith("renderer/chat/"),
    ),
  ).toEqual([]);
});

// The claim in README.md, README_CN.md and MIGRATION.md is that the renderer
// makes no request of its own: every byte it shows arrived over IPC from the
// main process, which is the only layer holding the connection. The import
// rules above do not cover it — `fetch` and `WebSocket` are globals, not
// imports — so name the globals themselves. Identifiers are read from the
// syntax tree rather than the text, so a mention in a comment or a string is
// not a violation and a shadowed local name still is.
const network = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon"]);
test("the renderer cannot reach the network on its own", () => {
  const uses = sources(path.join(root, "renderer")).flatMap((file) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const hits: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && network.has(node.text))
        hits.push(
          `${path.relative(root, file).replaceAll(path.sep, "/")}: ${node.text}`,
        );
      ts.forEachChild(node, visit);
    }
    visit(source);
    return hits;
  });
  expect(uses).toEqual([]);
});

test("feature models and services remain independent of React components and hooks", () => {
  expect(
    edges.filter(
      (edge) =>
        edge.layer === "renderer" &&
        /\/(?:models|services)\//.test(edge.source) &&
        (/\/(?:components|hooks)\//.test(edge.target) ||
          ["react", "react-dom"].includes(edge.specifier)),
    ),
  ).toEqual([]);
});
