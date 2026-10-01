import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LLMClient, MassClassificationTools } from '../src/index.js';
import { finalContent } from '../src/web/model-output.js';

type Box = [number, number, number, number];
type JsonObject = Record<string, unknown>;
type CocoImage = { id: number; file_name: string; width: number; height: number; doc_category?: string; page_no?: number; doc_name?: string };
type CocoAnnotation = { id: number; image_id: number; category_id: number; bbox: Box; area?: number };
type Coco = { images: CocoImage[]; annotations: CocoAnnotation[]; categories: { id: number; name: string }[] };
type TextCell = { bbox?: Box; text?: string };

const DEFAULT_DATASET = 'C:\\Users\\Shadow\\Datasets\\DocLayNet\\extracted';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8082/v1';
const LABELS = ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'] as const;
type Label = typeof LABELS[number];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberFlag(name: string, fallback: number, minimum = 0): number {
  const value = flag(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }

function endpointHealthUrl(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}/health`;
}

async function waitForHealthy(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const health = endpointHealthUrl(endpoint);
  let lastError = 'endpoint unavailable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (response.ok) return;
      lastError = `health HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(1000);
  }
  throw new Error(`LLM endpoint did not become healthy within ${timeoutMs} ms: ${lastError}`);
}

async function completeWithRetry(client: LLMClient, endpoint: string, request: Parameters<LLMClient['complete']>[0], attempts: number, retryDelayMs: number, healthWaitMs: number): Promise<Awaited<ReturnType<LLMClient['complete']>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.complete(request);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await delay(retryDelayMs * attempt);
      try { await waitForHealthy(endpoint, healthWaitMs); } catch (healthError) { lastError = healthError; }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function seededSample<T>(items: T[], count: number, seed: number): T[] {
  const shuffled = [...items]; let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  return shuffled.slice(0, count);
}

function usage(): void {
  console.log(`DocLayNet adapter\n\nUsage:\n  npm run doclaynet:eval -- --limit 5 --endpoint http://127.0.0.1:8082/v1\n\nOptions:\n  --dataset PATH       Extracted DocLayNet root\n  --split SPLIT        train, validation, or test (default: test)\n  --start N            Image offset in the split (default: 0)\n  --limit N            Number of pages (default: 5)\n  --sample N           Deterministically sample N random pages\n  --seed N             Seed used by --sample (default: 20261001)\n  --max-objects N      Objects per page (default: 12)\n  --objects-per-request N  Objects sent in one LLM call (default: 6)\n  --endpoint URL       OpenAI-compatible /v1 endpoint\n  --model ID           Served model ID (default: harness-local)\n  --max-tokens N       Completion token limit (default: 2400)\n  --attempts N         Attempts per request (default: 4)\n  --request-timeout-ms N  Timeout per request (default: 180000)\n  --health-wait-ms N  Wait for a restarting server (default: 30000)\n  --output PATH        JSON report/checkpoint path\n  --resume             Resume completed pages from --output\n  --mass               Also submit sampled PDFs to Mass Classification\n\nThe LLM task is text-plus-geometry layout classification. The local GGUF models are not vision models, so PNG pixels are deliberately not sent to the text endpoint.`);
}

function asObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function overlap(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]); const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]); const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return area / Math.max(1, a[2] * a[3]);
}

function cellText(annotation: CocoAnnotation, cells: TextCell[]): string {
  const matches = cells
    .filter(cell => Array.isArray(cell.bbox) && typeof cell.text === 'string' && overlap(annotation.bbox, cell.bbox) >= 0.05)
    .sort((a, b) => overlap(annotation.bbox, b.bbox!) - overlap(annotation.bbox, a.bbox!))
    .slice(0, 4)
    .map(cell => cell.text!.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  return matches.join(' ').slice(0, 240);
}

function selectObjects(objects: CocoAnnotation[], maxObjects: number): CocoAnnotation[] {
  if (maxObjects === 0 || objects.length <= maxObjects) return objects;
  const groups = new Map<number, CocoAnnotation[]>();
  for (const object of objects) groups.set(object.category_id, [...(groups.get(object.category_id) ?? []), object]);
  for (const group of groups.values()) group.sort((a, b) => (b.area ?? b.bbox[2] * b.bbox[3]) - (a.area ?? a.bbox[2] * a.bbox[3]));
  const selected: CocoAnnotation[] = [];
  while (selected.length < maxObjects) {
    let added = false;
    for (const group of groups.values()) {
      const next = group.shift();
      if (next) { selected.push(next); added = true; if (selected.length >= maxObjects) break; }
    }
    if (!added) break;
  }
  return selected;
}

function extractJson(content: string): JsonObject {
  let text = content;
  try { text = finalContent(content); } catch { /* Some llama.cpp profiles omit the final channel. */ }
  text = text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM response contains no JSON object');
  return asObject(JSON.parse(text.slice(start, end + 1)), 'LLM JSON');
}

function label(value: unknown): Label | undefined {
  return typeof value === 'string' && (LABELS as readonly string[]).includes(value) ? value as Label : undefined;
}

function promptFor(page: CocoImage, objects: CocoAnnotation[], names: Map<number, string>, cells: TextCell[]): string {
  const items = objects.map(object => ({
    id: object.id,
    bbox: object.bbox.map((value, index) => Number((value / (index < 2 ? page.width : page.height)).toFixed(4))),
    text: cellText(object, cells) || '(no extracted text)',
  }));
  return `Classify each document-layout object. Return ONLY valid JSON with this exact shape: {"predictions":[{"id":123,"label":"Text"}]}.\nAllowed labels: ${LABELS.join(', ')}.\nUse the object geometry (normalized x,y,width,height) and extracted text. Do not add explanations, markdown, or labels outside the allowed list.\nPage metadata: category=${page.doc_category ?? 'unknown'}, original_page=${page.page_no ?? 'unknown'}, objects=${objects.length}.\nObjects:\n${JSON.stringify(items)}\nGround-truth labels are hidden; predict one label for every object id. Label names in the metadata map are not provided to the model: ${names.size} category ids exist.`;
}

function metrics(rows: { expected: Label; predicted?: Label }[]): JsonObject {
  const perClass = Object.fromEntries(LABELS.map(name => {
    const tp = rows.filter(row => row.expected === name && row.predicted === name).length;
    const fp = rows.filter(row => row.expected !== name && row.predicted === name).length;
    const fn = rows.filter(row => row.expected === name && row.predicted !== name).length;
    const precision = tp + fp ? tp / (tp + fp) : 0; const recall = tp + fn ? tp / (tp + fn) : 0;
    return [name, { support: tp + fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 }];
  }));
  const valid = rows.filter(row => row.predicted).length;
  const correct = rows.filter(row => row.predicted === row.expected).length;
  const supported = LABELS.filter(name => (perClass[name] as JsonObject).support as number > 0);
  const macroF1 = supported.length ? supported.reduce((sum, name) => sum + ((perClass[name] as JsonObject).f1 as number), 0) / supported.length : 0;
  return { objects: rows.length, validPredictions: valid, invalidOrMissing: rows.length - valid, accuracyOnAllObjects: rows.length ? correct / rows.length : 0, accuracyOnValidPredictions: valid ? correct / valid : 0, macroF1OnSupportedClasses: macroF1, perClass };
}

function rowsFromReports(reports: JsonObject[]): { expected: Label; predicted?: Label }[] {
  const rows: { expected: Label; predicted?: Label }[] = [];
  for (const report of reports) {
    if (!Array.isArray(report.objects)) continue;
    for (const value of report.objects) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const object = value as JsonObject; const expected = label(object.expected);
      if (expected) rows.push({ expected, predicted: label(object.predicted) });
    }
  }
  return rows;
}

function isCompletedPage(report: JsonObject): boolean {
  if (report.status === 'completed') return true;
  if (report.error || report.status === 'partial') return false;
  return Array.isArray(report.objects) && report.objects.length > 0 && report.objects.every(value => value && typeof value === 'object' && !Array.isArray(value) && Boolean(label((value as JsonObject).predicted)));
}

async function saveReport(output: string, report: JsonObject): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await rename(temporary, output);
}

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }

async function callMass(dataset: string, split: string, pages: CocoImage[], report: JsonObject): Promise<void> {
  const apiKey = process.env.MASS_CLASSIFICATION_API_KEY ?? '';
  if (!apiKey) throw new Error('MASS_CLASSIFICATION_API_KEY is required with --mass');
  const endpoint = process.env.MASS_CLASSIFICATION_URL ?? 'http://127.0.0.1:8000';
  const mass = await MassClassificationTools.create({ endpoint, apiKey, inputRoots: [join(dataset, 'PDF')] });
  const context = { signal: AbortSignal.timeout(3_600_000), sessionId: 'doclaynet-adapter' };
  const tools = mass.tools();
  const submit = tools.find(tool => tool.name === 'mass_submit_document');
  if (!submit) throw new Error('mass_submit_document is not available; check MASS_INPUT_ROOTS');
  const results: JsonObject[] = [];
  for (const page of pages) {
    const path = join(dataset, 'PDF', page.file_name);
    const receipt = asObject(await submit.execute({ path, source: { dataset: 'DocLayNet', split, image_id: page.id } }, context), 'Mass receipt');
    const id = typeof receipt.id === 'string' ? receipt.id : undefined;
    if (!id) throw new Error(`Mass API returned no document id for ${basename(path)}`);
    results.push({ page: page.file_name, result: await mass.waitForDocument(id, { timeoutMs: 3_600_000, intervalMs: 2000 }) as unknown as JsonObject });
  }
  report.mass = { endpoint, results };
}

async function main(): Promise<void> {
  if (hasFlag('help')) { usage(); return; }
  try { process.loadEnvFile(process.env.HARNESS_ENV_FILE ?? '.env'); } catch { /* .env is optional. */ }
  const dataset = resolve(flag('dataset') ?? process.env.DOC_LAYNET_DATASET ?? DEFAULT_DATASET);
  const split = flag('split') ?? process.env.DOC_LAYNET_SPLIT ?? 'test';
  const splitFile = split === 'validation' ? 'val' : split;
  if (!['train', 'val', 'validation', 'test'].includes(split)) throw new Error('--split must be train, validation, or test');
  const start = numberFlag('start', 0); const limit = numberFlag('limit', 5); const sample = numberFlag('sample', 0); const seed = numberFlag('seed', 20261001);
  const selectionStart = sample > 0 ? 0 : start; const selectionLimit = sample > 0 ? sample : limit; const maxObjects = numberFlag('max-objects', 12);
  const objectsPerRequest = numberFlag('objects-per-request', 6, 1);
  const maxTokens = numberFlag('max-tokens', 2400, 128);
  const attempts = numberFlag('attempts', 4, 1);
  const requestTimeoutMs = numberFlag('request-timeout-ms', 180000, 1000);
  const healthWaitMs = numberFlag('health-wait-ms', 30000, 1000);
  const retryDelayMs = numberFlag('retry-delay-ms', 2000, 0);
  const endpoint = flag('endpoint') ?? process.env.DOC_LAYNET_LLM_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = flag('model') ?? process.env.DOC_LAYNET_MODEL ?? 'harness-local';
  const output = resolve(flag('output') ?? join('.harness', 'doclaynet', `${model}-${split}-${Date.now()}.json`));
  const resume = hasFlag('resume');
  const coco = await readJson<Coco>(join(dataset, 'COCO', `${splitFile}.json`));
  if (sample > coco.images.length) throw new Error(`--sample cannot exceed the number of pages in the split (${coco.images.length})`);
  const pages = sample > 0 ? seededSample(coco.images, sample, seed) : coco.images.slice(start, start + limit);
  if (!pages.length) throw new Error('No pages selected');
  const names = new Map(coco.categories.map(category => [category.id, category.name]));
  let existing: JsonObject | undefined;
  if (resume) {
    try { existing = await readJson<JsonObject>(output); } catch { existing = undefined; }
    if (existing && (existing.dataset !== dataset || existing.split !== split || existing.start !== selectionStart || existing.limit !== selectionLimit || existing.sample !== sample || existing.seed !== seed || existing.model !== model || existing.endpoint !== endpoint)) {
      throw new Error('--resume requires the same dataset, split, range, model, and endpoint as the existing report');
    }
  }
  const pageReportsById = new Map<number, JsonObject>();
  if (Array.isArray(existing?.pages)) {
    for (const value of existing.pages) {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as JsonObject).imageId === 'number') pageReportsById.set((value as JsonObject).imageId as number, value as JsonObject);
    }
  }
  const client = new LLMClient({ endpoint, model, apiKey: process.env.DOC_LAYNET_LLM_API_KEY ?? process.env.LLM_API_KEY, timeoutMs: requestTimeoutMs, maxRetries: 0 });
  await waitForHealthy(endpoint, healthWaitMs);
  let availableModels: string[] = [];
  let modelError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { availableModels = await client.listModels(); modelError = undefined; break; }
    catch (error) { modelError = error; if (attempt < attempts) { await delay(retryDelayMs * attempt); await waitForHealthy(endpoint, healthWaitMs); } }
  }
  if (modelError) throw modelError instanceof Error ? modelError : new Error(String(modelError));
  if (!availableModels.includes(model)) throw new Error(`Model ${model} is not served by ${endpoint}; available: ${availableModels.join(', ')}`);
  const checkpoint = (status: string): JsonObject => {
    const pageReports = pages.map(page => pageReportsById.get(page.id)).filter((page): page is JsonObject => Boolean(page));
    return { version: 'doclaynet-llm-adapter:v1', status, dataset, split, start: selectionStart, limit: selectionLimit, sample, seed, maxObjects, objectsPerRequest, maxTokens, attempts, requestTimeoutMs, healthWaitMs, endpoint, model, labels: LABELS, completedPages: pageReports.filter(isCompletedPage).length, totalPages: pages.length, metrics: metrics(rowsFromReports(pageReports)), pages: pageReports };
  };
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!;
    if (resume && pageReportsById.has(page.id) && isCompletedPage(pageReportsById.get(page.id)!)) {
      console.log(`resume: ${pageIndex + 1}/${pages.length} ${page.file_name}`);
      continue;
    }
    const objects = selectObjects(coco.annotations.filter(annotation => annotation.image_id === page.id), maxObjects);
    const meta = await readJson<{ cells?: TextCell[] }>(join(dataset, 'JSON', `${page.file_name.replace(/\.png$/iu, '')}.json`));
    const byId = new Map<number, Label>(); const requests: JsonObject[] = [];
    for (const batch of chunks(objects, objectsPerRequest)) {
      try {
        const response = await completeWithRetry(client, endpoint, { messages: [
          { role: 'system', content: 'You are a deterministic document-layout classifier. Return only the requested JSON object. Never include analysis, explanations, markdown, or extra keys.' },
          { role: 'user', content: promptFor(page, batch, names, meta.cells ?? []) },
        ], temperature: 0, topP: 0.1, maxTokens, signal: AbortSignal.timeout(requestTimeoutMs) }, attempts, retryDelayMs, healthWaitMs);
        const parsed = extractJson(response.content); const predictions = Array.isArray(parsed.predictions) ? parsed.predictions : [];
        let accepted = 0;
        for (const prediction of predictions) {
          if (!prediction || typeof prediction !== 'object') continue;
          const item = prediction as JsonObject; const id = typeof item.id === 'number' ? item.id : Number(item.id); const predicted = label(item.label);
          if (Number.isInteger(id) && predicted && batch.some(object => object.id === id) && !byId.has(id)) { byId.set(id, predicted); accepted += 1; }
        }
        requests.push({ status: accepted === batch.length ? 'completed' : 'partial', objectIds: batch.map(object => object.id), accepted, raw: response.content.slice(0, 5000), usage: response.usage });
      } catch (error) {
        requests.push({ status: 'failed', objectIds: batch.map(object => object.id), error: error instanceof Error ? error.message : String(error) });
      }
    }
    const evaluated = objects.map(object => ({ id: object.id, expected: names.get(object.category_id), predicted: byId.get(object.id), text: cellText(object, meta.cells ?? []) }));
    const status = evaluated.every(object => object.predicted) ? 'completed' : 'partial';
    pageReportsById.set(page.id, { status, page: page.file_name, imageId: page.id, category: page.doc_category, pageNo: page.page_no, objects: evaluated, requests });
    await saveReport(output, checkpoint('running'));
    console.log(`${status}: ${pageIndex + 1}/${pages.length} ${page.file_name}`);
  }
  const report = checkpoint('completed');
  if (hasFlag('mass')) await callMass(dataset, split, pages, report);
  await saveReport(output, report);
  console.log(JSON.stringify({ output, model, endpoint, pages: pages.length, metrics: report.metrics }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
