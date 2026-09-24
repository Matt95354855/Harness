import type { JsonValue, Tool, ToolContext } from '../core/types.js';

const API = 'https://www.googleapis.com/drive/v3';
const idPattern = /^[A-Za-z0-9_-]{10,200}$/u;

async function body(response: Response): Promise<JsonValue> {
  if (!response.ok) throw new Error(`Google Drive returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error('Google Drive response exceeds 1000000 characters');
  try { return JSON.parse(text) as JsonValue; } catch { return text; }
}

export class GoogleDriveTools {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) { if (!token.trim()) throw new Error('Google Drive token is required'); }
  private request(url: string, context: ToolContext): Promise<Response> { return this.fetcher(url, { signal: context.signal, redirect: 'error', headers: { Authorization: `Bearer ${this.token}` } }); }
  tools(): Tool[] { return [
    {
      name: 'drive_search', description: 'Search file names and full text in Google Drive with read-only access.',
      parameters: [{ name: 'query', type: 'string', description: 'Text to search in Drive.', required: true }, { name: 'maxResults', type: 'number', description: 'Maximum 1 to 20 results.', required: false, minimum: 1, maximum: 20 }],
      execute: async ({ query, maxResults }, context) => {
        if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('query must contain 1 to 500 characters');
        const escaped = query.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
        const params = new URLSearchParams({ q: `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`, pageSize: String(maxResults ?? 10), fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)' });
        return body(await this.request(`${API}/files?${params}`, context));
      },
    },
    {
      name: 'drive_read', description: 'Read a Google Drive text file, Google Doc or spreadsheet by file ID. Read-only and size-limited.',
      parameters: [{ name: 'fileId', type: 'string', description: 'Google Drive file ID returned by drive_search.', required: true }],
      execute: async ({ fileId }, context) => {
        if (typeof fileId !== 'string' || !idPattern.test(fileId)) throw new Error('Invalid Google Drive file ID');
        const metadata = await body(await this.request(`${API}/files/${fileId}?fields=id,name,mimeType,modifiedTime,size,webViewLink`, context));
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid Google Drive metadata');
        const mime = String(metadata.mimeType ?? '');
        const exportType = mime === 'application/vnd.google-apps.document' ? 'text/plain' : mime === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : undefined;
        if (mime.startsWith('application/vnd.google-apps.') && !exportType) return { metadata, content: null, note: 'This Google Workspace file type is listed but cannot be exported as plain text by this tool.' } as JsonValue;
        if (!exportType && !mime.startsWith('text/') && !['application/json', 'application/xml'].includes(mime)) throw new Error(`Unsupported Google Drive content type: ${mime || 'unknown'}`);
        const url = exportType ? `${API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportType)}` : `${API}/files/${fileId}?alt=media`;
        return { metadata, content: await body(await this.request(url, context)) } as JsonValue;
      },
    },
  ]; }
}
