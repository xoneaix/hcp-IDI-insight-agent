#!/usr/bin/env node
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function usage() {
  console.log(`腾讯会议 MP4 音频提取工具\n\n用法：\n  node scripts/extract-meeting-audio.mjs <MP4文件或文件夹...> [--out 输出目录] [--overwrite]\n\n示例：\n  node scripts/extract-meeting-audio.mjs ~/Downloads/访谈.mp4\n  node scripts/extract-meeting-audio.mjs ~/Downloads/腾讯会议访谈 --out ~/Downloads/medvoice-audio\n\n输出：单声道 64kbps .m4a，适合上传到 MedVoice 做转录。`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(args.length ? 0 : 1);
}

let outDir = "";
let overwrite = false;
const inputs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--out") {
    outDir = args[++i] || "";
  } else if (args[i] === "--overwrite") {
    overwrite = true;
  } else {
    inputs.push(args[i]);
  }
}
if (!inputs.length) {
  usage();
  process.exit(1);
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function findMp4s(input) {
  const path = resolve(input.replace(/^~/, process.env.HOME || "~"));
  const info = await stat(path);
  if (info.isFile()) return /\.mp4$/i.test(path) ? [path] : [];
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (/\.mp4$/i.test(entry.name)) found.push(child);
    }
  }
  await walk(path);
  return found;
}

async function commandAvailable(command) {
  try { await execFileAsync(command, ["-version"], { timeout: 5000, maxBuffer: 100_000 }); return true; } catch { return false; }
}

async function convert(input, output, useFfmpeg) {
  if (useFfmpeg) {
    await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", input,
      "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k",
      output
    ], { timeout: 90 * 60 * 1000, maxBuffer: 2_000_000 });
    return;
  }
  await execFileAsync("/usr/bin/avconvert", [
    "--source", input,
    "--preset", "PresetAppleM4A",
    "--output", output,
    "--replace"
  ], { timeout: 90 * 60 * 1000, maxBuffer: 2_000_000 });
}

const useFfmpeg = await commandAvailable(process.env.FFMPEG_BIN || "ffmpeg");
const useAvconvert = !useFfmpeg && process.platform === "darwin" && await exists("/usr/bin/avconvert");
if (!useFfmpeg && !useAvconvert) {
  console.error("未找到 ffmpeg 或 macOS avconvert。建议先安装 ffmpeg：brew install ffmpeg");
  process.exit(1);
}

const allFiles = [];
for (const input of inputs) allFiles.push(...await findMp4s(input));
if (!allFiles.length) {
  console.error("没有找到 .mp4 文件。");
  process.exit(1);
}

const targetRoot = outDir ? resolve(outDir.replace(/^~/, process.env.HOME || "~")) : join(process.cwd(), "data", "extracted-audio");
await mkdir(targetRoot, { recursive: true });

console.log(`找到 ${allFiles.length} 个 MP4，输出目录：${targetRoot}`);
for (const file of allFiles) {
  const output = join(targetRoot, `${basename(file, extname(file))}.m4a`);
  if (!overwrite && await exists(output)) {
    console.log(`跳过：${output} 已存在（如需覆盖请加 --overwrite）`);
    continue;
  }
  console.log(`提取音频：${file}`);
  await mkdir(dirname(output), { recursive: true });
  await convert(file, output, useFfmpeg);
  console.log(`完成：${output}`);
}
