import { access, lstat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localModules = join(projectRoot, "node_modules");
const bundledModules = process.env.CODEX_NODE_MODULES || join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");

try {
  await lstat(localModules);
} catch {
  try {
    await access(bundledModules);
    await symlink(bundledModules, localModules, "junction");
  } catch {
    throw new Error("未找到 Codex 工作区依赖。请在 Codex 桌面应用工作区中运行，或设置 CODEX_NODE_MODULES。 ");
  }
}

await import("../server.js");
