import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const output = path.resolve("desktop/generated");
await mkdir(output, { recursive: true });
// All chat UI is compiled from React; the HTML file is only its document entry.
await build({
  entryPoints: ["desktop/renderer/chat/main.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  outfile: path.join(output, "chat.js"),
});
await copyFile("loom.html", path.join(output, "loom.html"));
// Remove the retired DOM adapters from development and packaged public assets.
for (const asset of [
  "loom.css",
  "vendor.js",
  "chat-index.js",
  "chat-activity.js",
  "chat-scene.js",
])
  await rm(path.join(output, asset), { force: true });
await copyFile(
  "node_modules/highlight.js/styles/github-dark.min.css",
  path.join(output, "highlight.css"),
);
await copyFile(
  "desktop/renderer/chat/styles.css",
  path.join(output, "chat.css"),
);
const notices = [];
for (const [name, file] of [
  ["marked", "LICENSE.md"],
  ["highlight.js", "LICENSE"],
  ["react", "LICENSE"],
  ["react-dom", "LICENSE"],
  ["scheduler", "LICENSE"],
]) {
  notices.push(
    `${name}\n${await readFile(path.join("node_modules", name, file), "utf8")}`,
  );
}
await writeFile(
  path.join(output, "THIRD-PARTY-LICENSES.txt"),
  notices.join("\n\n---\n\n"),
);
console.log("Built React chat assets in desktop/generated.");
