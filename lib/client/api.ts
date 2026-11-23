import type {
  Box,
  CutoutInfo,
  GenerationRecord,
  GenerationRequest,
  SavedSpace,
  UploadInfo,
  UploadKind,
} from '@/lib/types';

/** A failed API call: the server's Turkish message plus the HTTP status (absent when unreachable). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'Beklenmeyen bir hata oluştu.';
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('Sunucuya ulaşılamadı. Uygulamanın çalıştığından emin olun.');
  }
  return parse<T>(res);
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function uploadFile(file: File, kind: UploadKind): Promise<UploadInfo> {
  const form = new FormData();
  form.append('file', file);
  form.append('kind', kind);
  return request<UploadInfo>('/api/uploads', { method: 'POST', body: form });
}

export function getUpload(id: string): Promise<UploadInfo> {
  return request<UploadInfo>(`/api/uploads/${encodeURIComponent(id)}`);
}

export function getCutout(id: string): Promise<CutoutInfo> {
  return request<CutoutInfo>(`/api/cutouts/${encodeURIComponent(id)}`);
}

export function createCutout(uploadId: string, box?: Box): Promise<CutoutInfo> {
  return request<CutoutInfo>('/api/cutout', json({ uploadId, box }));
}

export function startGeneration(req: GenerationRequest): Promise<GenerationRecord> {
  return request<GenerationRecord>('/api/generate', json(req));
}

export function getGeneration(id: string): Promise<GenerationRecord> {
  return request<GenerationRecord>(`/api/generations/${encodeURIComponent(id)}`);
}

export function listGenerations(): Promise<GenerationRecord[]> {
  return request<GenerationRecord[]>('/api/generations');
}

export function listSpaces(): Promise<SavedSpace[]> {
  return request<SavedSpace[]>('/api/spaces');
}

export function saveSpace(name: string, uploadId: string): Promise<SavedSpace> {
  return request<SavedSpace>('/api/spaces', json({ name, uploadId }));
}

export function getMagnificStatus(): Promise<{ connected: boolean }> {
  return request<{ connected: boolean }>('/api/magnific/status');
}

export function fileUrl(rel: string): string {
  return '/api/files/' + rel.split('/').map(encodeURIComponent).join('/');
}
