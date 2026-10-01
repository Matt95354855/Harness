import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const models = [
  { id: 'gpt-oss', name: 'GPT-OSS 20B', quantization: 'MXFP4', file: 'gpt-oss-20b-mxfp4/gpt-oss-20b-MXFP4.gguf' },
  { id: 'qwen', name: 'Qwen3.6 27B', quantization: 'Q4_K_M', file: 'qwen3.6-27b-instruct-q4_k_m/qwen3.6-27b-instruct-Q4_K_M.gguf' },
] as const;
export type ModelId = typeof models[number]['id'];
export const isModel = (value: unknown): value is ModelId => models.some(model => model.id === value);

/** One GPU owner. Switches are serialized together with full Harness runs by the caller. */
export class ModelManager {
  private child?: ChildProcess;
  private current?: ModelId;
  private state = 'stopped';
  private closed = false;
  readonly endpoint = 'http://127.0.0.1:8082/v1';
  constructor(private readonly directory: string) {}
  status() { return { active: this.current ?? null, state: this.state, models: models.map(({ id, name, quantization }) => ({ id, name, quantization })) }; }
  private log(data: Buffer) {
    const path = join(this.directory, 'model.log');
    if (existsSync(path) && statSync(path).size > 5_000_000) {
      rmSync(`${path}.1`, { force: true }); renameSync(path, `${path}.1`);
    }
    appendFileSync(path, data);
  }
  async ensure(id: ModelId): Promise<void> {
    if (this.closed) throw new Error('Server shutting down');
    if (this.current === id && this.child && this.state === 'ready') {
      try { if ((await fetch('http://127.0.0.1:8082/health', { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* restart owned process */ }
    }
    await this.stop();
    const model = models.find(item => item.id === id)!;
    const root = process.env.HARNESS_MODEL_ROOT ?? join(process.env.USERPROFILE!, 'Models', 'gguf');
    const executable = process.env.HARNESS_LLAMA_SERVER ?? join(process.env.LOCALAPPDATA!, 'Microsoft', 'WinGet', 'Packages', 'ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'llama-server.exe');
    const file = join(root, model.file);
    if (!existsSync(executable) || !existsSync(file)) throw new Error('Modèle ou moteur llama.cpp introuvable.');
    // Refuse to adopt or terminate an unrelated process on our dedicated port.
    try {
      await fetch('http://127.0.0.1:8082/health', { signal: AbortSignal.timeout(1000) });
      throw new Error('Le port 8082 est occupé par un autre moteur.');
    } catch (error) { if (error instanceof Error && error.message.includes('occupé')) throw error; }
    this.state = 'loading'; this.current = id;
    const child = spawn(executable, ['--model', file, '--alias', 'harness-local', '--host', '127.0.0.1', '--port', '8082',
      '--parallel', '1', '--jinja', '--gpu-layers', id === 'gpt-oss' ? 'all' : 'auto', '--fit', 'on', '--fit-target', '2048',
      '--fit-ctx', '4096', '--ctx-size', '4096', '--reasoning', 'off', '--no-webui',
      ...(id === 'gpt-oss' ? ['--skip-chat-parsing'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (data: Buffer) => this.log(data)); child.stderr?.on('data', (data: Buffer) => this.log(data));
    child.on('error', () => { this.state = 'error'; });
    child.on('exit', () => { if (this.child === child) { this.child = undefined; this.state = 'stopped'; } });
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && !this.closed) {
      if (child.exitCode !== null || this.state === 'error') break;
      try {
        const result = await fetch('http://127.0.0.1:8082/health', { signal: AbortSignal.timeout(2000) });
        if (result.ok) { this.state = 'ready'; return; }
      } catch { /* model loading */ }
      await delay(1000);
    }
    await this.stop(); this.state = 'error';
    throw new Error('Chargement du modèle impossible. Consultez le journal local.');
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Le moteur ne s’arrête pas.')), 15000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    this.child = undefined; this.state = 'stopped';
  }
  async close() { this.closed = true; await this.stop(); }
}
