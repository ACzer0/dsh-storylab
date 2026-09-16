/**
 * HTTP 层：把图形界面的静态页与 JSON API 挂到 DSH 自带的 web server 上。
 *
 * 注册方式（dsh-host-webserver）：
 *   ctx.webServer.register({ kind: 'prefix', path: '/storylab', handler })
 * 于是页面就在 DSH GUI 的**同一个端口、同一个源**上：
 *   http://127.0.0.1:3080/storylab/
 *
 * 这一层只做 HTTP 细节（方法、路径、JSON、静态文件），不含业务判断。
 */

import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, type StoryLabApi } from './api.ts';

/** 允许对外提供的静态文件后缀。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 1024 * 1024;

/** 创建路由处理器。 */
export function createStoryLabRouter(api: StoryLabApi, publicDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/u, '') || '/storylab';

      if (url.pathname === '/storylab' || url.pathname === '/storylab/') {
        await sendStatic(res, publicDir, 'index.html');
        return;
      }

      if (path.startsWith('/storylab/api')) {
        await handleApi(api, req, res, path.slice('/storylab/api'.length) || '/', url);
        return;
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/storylab/')) {
        await sendStatic(res, publicDir, path.slice('/storylab/'.length));
        return;
      }

      sendJson(res, 404, { ok: false, error: '找不到该资源。' });
    } catch (error) {
      // 永远自己收尾：绝不把异常抛回 web server。
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: `Story Lab 内部错误：${message}` });
    }
  };
}

async function handleApi(
  api: StoryLabApi,
  req: IncomingMessage,
  res: ServerResponse,
  action: string,
  url: URL,
  locked = false,
): Promise<void> {
  const method = req.method ?? 'GET';

  try {
    if (method === 'POST' && !locked) {
      await api.mutate(() => handleApi(api, req, res, action, url, true));
      return;
    }
    // 注意：读 body 也要在 try 里 —— 坏 JSON 是 ApiError(400)，不是 500。
    const body = method === 'POST' ? await readJsonBody(req) : {};
    switch (`${method} ${action}`) {
      case 'GET /state':
        sendJson(res, 200, { ok: true, data: api.state() });
        return;
      case 'GET /stories':
        sendJson(res, 200, { ok: true, data: await api.stories() });
        return;
      case 'GET /graph': {
        const file = url.searchParams.get('file') ?? '';
        sendJson(res, 200, { ok: true, data: await api.preview(file) });
        return;
      }
      case 'GET /spike':
        sendJson(res, 200, { ok: true, data: await api.spike() });
        return;
      case 'GET /story':
        sendJson(res, 200, { ok: true, data: api.document() });
        return;
      case 'POST /validate':
        sendJson(res, 200, { ok: true, data: api.validate(body['story']) });
        return;
      case 'POST /save':
        sendJson(res, 200, { ok: true, data: await api.save(body['story']) });
        return;
      case 'POST /save-as':
        sendJson(res, 200, { ok: true, data: await api.saveAs(body['story'], asString(body['name'])) });
        return;
      case 'POST /autolayout':
        sendJson(res, 200, { ok: true, data: api.autolayout(body['story']) });
        return;
      case 'POST /load':
        sendJson(res, 200, { ok: true, data: await api.load(asString(body['file'])) });
        return;
      case 'POST /start':
        sendJson(res, 200, { ok: true, data: await api.start() });
        return;
      case 'POST /go':
        sendJson(res, 200, { ok: true, data: await api.go() });
        return;
      case 'POST /choose':
        sendJson(res, 200, { ok: true, data: await api.choose(asString(body['id'])) });
        return;
      case 'POST /ai':
        sendJson(res, 200, { ok: true, data: await api.ai() });
        return;
      case 'POST /auto':
        sendJson(res, 200, { ok: true, data: await api.auto(typeof body['count'] === 'number' ? body['count'] : undefined) });
        return;
      case 'POST /recover':
        sendJson(res, 200, { ok: true, data: await api.recover(asString(body['nodeId'])) });
        return;
      default:
        sendJson(res, 404, { ok: false, error: `未知接口：${method} ${action}` });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, { ok: false, error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, error: message });
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('请求体过大。', 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ApiError('请求体不是合法 JSON。');
  }
}

/** 提供 public 目录下的静态文件；越界路径一律拒绝。 */
async function sendStatic(res: ServerResponse, publicDir: string, relative: string): Promise<void> {
  const root = resolve(publicDir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, 404, { ok: false, error: '找不到该资源。' });
    return;
  }
  const extension = target.slice(target.lastIndexOf('.')).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) {
    sendJson(res, 404, { ok: false, error: '找不到该资源。' });
    return;
  }
  try {
    const content = await readFile(target);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: '找不到该资源。' });
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}
