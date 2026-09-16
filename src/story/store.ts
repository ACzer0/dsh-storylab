/**
 * 剧本文件与运行日志的读写。
 *
 * 一个剧本 = 一个 JSON 文件，不引入数据库。
 * 这里直接用 node:fs —— 插件是宿主侧受信代码，不需要借道 ctx 的文件服务。
 */

import { readdir, readFile, mkdir, appendFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { parseStory, type ParseResult } from './model.ts';
import type { StoryLabConfig } from '../types.ts';

/**
 * 插件包根目录。
 *
 * 默认目录一律相对**插件包自己**，而不是 `process.cwd()`：cwd 取决于用户从哪个目录
 * 启动 dsh（实测从用户主目录启动时兜底会变成 %USERPROFILE%\stories，剧本列表就空了）。
 * src/story/store.ts 与 lib/story/store.js 的 ../../ 都正好是包根。
 */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 剧本目录：配置优先，否则 <插件包>/stories。 */
export function resolveStoryDir(config: StoryLabConfig): string {
  const configured = config.storyDir?.trim();
  return configured ? resolve(configured) : join(PACKAGE_ROOT, 'stories');
}

/** 运行日志目录：配置优先，否则 <插件包>/runs。 */
export function resolveRunLogDir(config: StoryLabConfig): string {
  const configured = config.runLogDir?.trim();
  return configured ? resolve(configured) : join(PACKAGE_ROOT, 'runs');
}

/** 把用户输入的路径解析成绝对路径：相对路径相对剧本目录解析。 */
export function resolveStoryPath(config: StoryLabConfig, input: string): string {
  const trimmed = input.trim().replace(/^"|"$/gu, '');
  if (isAbsolute(trimmed)) return trimmed;
  return join(resolveStoryDir(config), trimmed);
}

/** 列出剧本目录下的 .json 文件（按名字排序，输出裸文件名）。 */
export async function listStoryFiles(config: StoryLabConfig): Promise<string[]> {
  try {
    const entries = await readdir(resolveStoryDir(config), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 读取并校验一个剧本文件。 */
export async function loadStoryFile(
  config: StoryLabConfig,
  input: string,
): Promise<(ParseResult & { path: string }) | { ok: false; errors: string[]; path: string }> {
  const path = resolveStoryPath(config, input);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`读不到剧本文件：${path}（${message}）`], path };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`JSON 解析失败：${path}（${message}）`], path };
  }
  return { ...parseStory(raw), path };
}

/** 运行日志：一局一个 JSONL 文件。 */
export class RunLog {
  readonly #dir: string;
  readonly #file: string;

  constructor(config: StoryLabConfig, runId: string) {
    this.#dir = resolveRunLogDir(config);
    this.#file = join(this.#dir, `${runId}.jsonl`);
  }

  /** 文件绝对路径（用于在控制台里告诉用户日志落在哪）。 */
  get path(): string {
    return this.#file;
  }

  /** 追加一条事件；写日志失败不应影响游戏推进。 */
  async append(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      await appendFile(this.#file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch {
      // 忽略：日志是旁路，不影响剧情状态。
    }
  }
}

/** 元信息文件路径（供 /storylab list 显示目录位置）。 */
export function storyDirHint(config: StoryLabConfig): string {
  return resolveStoryDir(config);
}

/** 一个剧本文件名是否安全（save-as 用：只允许裸文件名，不允许路径分隔符）。 */
export function isSafeStoryFileName(name: string): boolean {
  return /^[\w\u4e00-\u9fa5.-]{1,80}\.json$/u.test(name) && !name.includes('/') && !name.includes('\\');
}

/** 读取一个 JSON 文件的原始内容（编辑用：保留未知字段，不做规范化）。 */
export async function readJsonFile(path: string): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 写剧本 JSON：先备份原文件到 `<文件>.bak`，再原子感较强地整体覆盖。
 *
 * 手工可编辑的 JSON 是作者的心血，覆盖前留一份上一版是很便宜的保险。
 */
export async function writeStoryFile(path: string, data: unknown, overwrite = true): Promise<{ backup: string | null }> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  if (!overwrite) {
    try { await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error('这个文件名已经存在，请换一个名字。另存为不会覆盖已有剧本。'), { code: 'EEXIST' });
      throw error;
    }
    return { backup: null };
  }
  let backup: string | null = null;
  const previous = await readFile(path, 'utf8').catch(() => null);
  if (previous !== null) {
    backup = `${path}.bak`;
    await writeFile(backup, previous, 'utf8');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { backup };
}
