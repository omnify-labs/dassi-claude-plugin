import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CLI_PROTOCOL_VERSION } from './dassi-shared.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function stat(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function prepareResultDirectory(directory, taskId) {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true });
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Output directory must be a directory, not a symlink.');
  const entries = await fs.readdir(root);
  if (!entries.length) return root;
  const file = path.join(root, 'result.json');
  if (!(await stat(file))?.isFile()) throw new Error('Output directory is not empty. Choose an empty directory.');
  const previous = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!taskId || previous.taskId !== taskId || previous.schemaVersion !== 1)
    throw new Error('Output directory belongs to another task. Choose an empty directory.');
  return root;
}

function assetPath(asset) {
  const id = digest(asset.id).slice(0, 24);
  if (asset.kind === 'screenshot') {
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[asset.mimeType] ?? 'bin';
    return `screenshots/${id}.${extension}`;
  }
  const name = path.basename(String(asset.name).replaceAll('\\', '/')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
  return `files/${id}-${name}`;
}

async function atomicWrite(destination, contents) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function recordAcceptedTask(result, directory) {
  const root = await prepareResultDirectory(directory, result.taskId);
  const manifest = path.join(root, 'result.json');
  const previous = await stat(manifest) ? JSON.parse(await fs.readFile(manifest, 'utf8')) : {};
  await atomicWrite(manifest, JSON.stringify({ ...previous, ...result, schemaVersion: 1,
    messages: previous.messages ?? [], assets: previous.assets ?? [],
    warnings: ['Task accepted. Retrieve this task to export its current conversation and files.'],
    export: { complete: false, directory: root, manifest },
  }, null, 2) + '\n');
}

async function downloadAsset(root, asset, report, send, socketPath) {
  const relative = assetPath(asset);
  const destination = path.join(root, relative);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  let file;
  try {
    file = await fs.open(temporary, 'wx', 0o600);
    let offset = 0;
    do {
      const response = await send(socketPath, {
        id: `result-file-${randomUUID()}`, action: 'task_result_file', taskId: report.taskId,
        fileId: asset.id, offset, protocolVersion: CLI_PROTOCOL_VERSION,
      });
      if (!response.success) throw new Error(response.error || 'File transfer failed.');
      const chunk = response.data;
      if (chunk.fileId !== asset.id || chunk.offset !== offset || chunk.size !== asset.size || chunk.updatedAt !== asset.updatedAt)
        throw new Error('File changed during export. Retrieve the task result again.');
      const bytes = Buffer.from(chunk.data, 'base64');
      if (bytes.length > 256 * 1024 || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > asset.size || (!bytes.length && offset < asset.size))
        throw new Error('Invalid file transfer chunk.');
      await file.writeFile(bytes);
      hash.update(bytes);
      offset = chunk.nextOffset;
    } while (offset < asset.size);
    await file.close(); file = null;
    await fs.rename(temporary, destination);
    return { ...asset, path: relative, sha256: hash.digest('hex') };
  } finally {
    await file?.close();
    await fs.rm(temporary, { force: true });
  }
}

export function renderTaskReport(report) {
  const image = asset => asset.path && /^image\/(png|jpeg|webp|gif)$/.test(asset.mimeType)
    ? `<figure><a href="${escape(asset.path)}"><img loading="lazy" src="${escape(asset.path)}" alt="${escape(asset.name)}"></a><figcaption>${escape(asset.name)} · ${escape(new Date(asset.updatedAt).toISOString())}</figcaption></figure>` : '';
  const images = new Map(report.assets.filter(a => a.uri).map(a => [a.uri, a]));
  const messages = report.messages.map(message => {
    const title = message.role === 'toolResult' ? `${message.toolName} ${message.isError ? '— error' : '— result'}` : message.role;
    const calls = (message.calls ?? []).map(call => `<details><summary>${escape(call.name)}</summary><pre>${escape(JSON.stringify(call.arguments, null, 2))}</pre></details>`).join('');
    const pictures = message.images.map(uri => images.has(uri) ? image(images.get(uri)) : `<p class="warning">Screenshot unavailable: ${escape(uri)}</p>`).join('');
    return `<details class="message"><summary>${escape(title)} <time>${escape(message.timestamp)}</time></summary><pre>${escape(message.text)}</pre>${calls}${pictures}</details>`;
  }).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Dassi task result</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#202725;background:#f5f6f3;margin:0}main{max-width:1000px;margin:auto;padding:40px 24px}h1{margin-bottom:0}h2{margin-top:36px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}section,.message{background:white;border:1px solid #dce1da;border-radius:10px;padding:20px;margin:12px 0}summary{cursor:pointer;font-weight:600}time,figcaption,.meta{font-size:13px;color:#58635c}time{display:block}img{max-width:100%;height:auto;border:1px solid #dce1da}figure{margin:20px 0}.warning{color:#8a3b09}a{color:#205d43}li{margin:8px 0}</style>
<main><h1>Dassi task result</h1><p class="meta">${escape(report.taskId)}<br>Exported ${escape(report.exportedAt)}</p>
<section><strong>Status: ${escape(report.status)}</strong>${report.reason ? `<p class="warning">${escape(report.reason)}</p>` : ''}<pre>${escape(report.answer || 'No final answer recorded.')}</pre></section>
${report.warnings.length ? `<section class="warning"><strong>Evidence gaps</strong><ul>${report.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul></section>` : ''}
<h2>Conversation and actions</h2>${messages || '<p>No messages recorded.</p>'}
<h2>Captured images</h2>${report.assets.filter(a => a.kind === 'screenshot').map(image).join('') || '<p>No images available.</p>'}
<h2>Files</h2><ul>${report.assets.filter(a => a.kind === 'file').map(a => `<li>${a.path ? `<a href="${escape(a.path)}" download>${escape(a.name)}</a>` : escape(a.name)}${a.error ? ` — ${escape(a.error)}` : ''}</li>`).join('')}</ul>
</main></html>`;
}

export async function saveTaskResult(report, directory, send, socketPath) {
  const root = await prepareResultDirectory(directory, report.taskId);
  const previousPath = path.join(root, 'result.json');
  const previous = await stat(previousPath) ? JSON.parse(await fs.readFile(previousPath, 'utf8')) : null;
  const assets = [];
  const warnings = [...report.warnings];
  const exported = { complete: false, directory: root, report: path.join(root, 'report.html'), manifest: previousPath };
  const checkpoint = () => atomicWrite(previousPath, JSON.stringify({ ...report,
    assets: [...assets, ...report.assets.slice(assets.length)],
    warnings: [...warnings, 'Export not finished. Retrieve this task again to finish downloading.'], export: exported,
  }, null, 2) + '\n');
  // A killed first export must still identify its folder so retrieval can resume.
  await checkpoint();
  let complete = true;
  for (const asset of report.assets) {
    try {
      const folder = path.join(root, path.dirname(assetPath(asset)));
      await fs.mkdir(folder, { recursive: true });
      if (!(await fs.lstat(folder)).isDirectory()) throw new Error('Asset directory must not be a symlink.');
      const prior = previous?.assets.find(a => a.id === asset.id && a.updatedAt === asset.updatedAt && a.size === asset.size && a.path === assetPath(asset));
      const local = prior && await stat(path.join(root, prior.path));
      if (local?.isFile() && local.size === asset.size && digest(await fs.readFile(path.join(root, prior.path))) === prior.sha256) {
        assets.push({ ...asset, path: prior.path, sha256: prior.sha256 });
      } else assets.push(await downloadAsset(root, asset, report, send, socketPath));
    } catch (error) {
      complete = false;
      assets.push({ ...asset, error: error.message });
      warnings.push(`Could not save ${asset.name}: ${error.message}`);
    }
    await checkpoint();
  }
  const saved = { ...report, assets, warnings, export: { ...exported, complete } };
  await atomicWrite(path.join(root, 'report.html'), renderTaskReport(saved));
  await atomicWrite(previousPath, JSON.stringify(saved, null, 2) + '\n');
  return saved;
}
