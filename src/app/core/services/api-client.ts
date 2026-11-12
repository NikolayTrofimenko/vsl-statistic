import type { AuthState, KbFile, Offer, SessionUser, UploadInput, VslStatApi } from '../../../shared/api.types';

/**
 * HTTP implementation of the `VslStatApi` contract.
 *
 * Data calls are one POST per named channel (`/api/rpc/<channel>`); binary
 * things — thumbnails, the video stream, the Google consent redirect — are
 * plain relative URLs the browser loads itself. In development Angular's dev
 * server proxies `/api` to the backend.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface HttpApiOptions {
  /** Invoked whenever the server rejects a call with 401 (session expired). */
  onUnauthorized?: () => void;
}

export function createHttpApi(options: HttpApiOptions = {}): VslStatApi {
  async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/api/rpc/${channel}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ args }),
      });
    } catch {
      throw new ApiError('Сервер недоступен.', 0);
    }

    const payload = (await response.json().catch(() => null)) as {
      ok: boolean;
      data?: unknown;
      error?: string;
    } | null;

    if (response.status === 401) {
      options.onUnauthorized?.();
      throw new ApiError(payload?.error ?? 'Требуется вход.', 401);
    }
    if (!response.ok || !payload?.ok) {
      throw new ApiError(payload?.error ?? `Ошибка сервера (${response.status})`, response.status);
    }
    return payload.data as T;
  }

  /**
   * Raw file body via XMLHttpRequest — fetch() can't report upload progress,
   * and creatives run to hundreds of megabytes.
   */
  function uploadCreative(
    input: UploadInput,
    onProgress?: (percent: number | null) => void,
  ): Promise<{ id: string }> {
    const query = new URLSearchParams({ folderId: input.folderId, name: input.name || input.file.name });
    if (input.geo) query.set('geo', input.geo);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/library/upload?${query}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', input.file.type || 'video/mp4');
      xhr.upload.onprogress = (e) =>
        onProgress?.(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
      xhr.onload = () => {
        let payload: { ok?: boolean; data?: { id: string }; error?: string } | null = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status === 401) options.onUnauthorized?.();
        if (xhr.status >= 200 && xhr.status < 300 && payload?.ok && payload.data) resolve(payload.data);
        else reject(new ApiError(payload?.error ?? `Загрузка не удалась (${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('Сервер недоступен.', 0));
      xhr.send(input.file);
    });
  }

  async function uploadOfferPhoto(id: number, file: File): Promise<Offer> {
    const res = await fetch(`/api/offers/photo/${id}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (res.status === 401) options.onUnauthorized?.();
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; data?: Offer; error?: string } | null;
    if (!res.ok || !payload?.ok || !payload.data) throw new ApiError(payload?.error ?? `Фото не загрузилось (${res.status})`, res.status);
    return payload.data;
  }

  /** An image or video for a knowledge-base document — the same raw-body upload. */
  function uploadKnowledge(file: File, onProgress?: (percent: number | null) => void): Promise<KbFile> {
    const query = new URLSearchParams({ name: file.name });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/knowledge/upload?${query}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) =>
        onProgress?.(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
      xhr.onload = () => {
        let payload: { ok?: boolean; data?: KbFile; error?: string } | null = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status === 401) options.onUnauthorized?.();
        if (xhr.status >= 200 && xhr.status < 300 && payload?.ok && payload.data) resolve(payload.data);
        else reject(new ApiError(payload?.error ?? `Загрузка не удалась (${xhr.status})`, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError('Сервер недоступен.', 0));
      xhr.send(file);
    });
  }

  return {
    auth: {
      async session(): Promise<AuthState> {
        const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
        if (!res.ok) throw new ApiError('Сервер недоступен.', res.status);
        return (await res.json()) as AuthState;
      },
      async login(login: string, password: string): Promise<SessionUser> {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ login, password }),
        });
        const payload = (await res.json().catch(() => null)) as {
          ok: boolean;
          user?: SessionUser;
          error?: string;
        } | null;
        if (!res.ok || !payload?.ok || !payload.user) {
          throw new ApiError(payload?.error ?? 'Не удалось войти.', res.status);
        }
        return payload.user;
      },
      async logout(): Promise<void> {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      },
    },

    users: {
      list: () => rpc('users:list'),
      create: (input) => rpc('users:create', input),
      update: (id, patch) => rpc('users:update', id, patch),
      setPassword: (id, password) => rpc('users:setPassword', id, password),
      roles: () => rpc('users:roles'),
      saveRole: (role) => rpc('users:saveRole', role),
      deleteRole: (id) => rpc('users:deleteRole', id),
    },

    drive: {
      status: () => rpc('drive:status'),
      connectUrl: () => '/api/drive/oauth/start',
      disconnect: () => rpc('drive:disconnect'),
      sync: () => rpc('drive:sync'),
    },

    library: {
      list: () => rpc('library:list'),
      update: (id, patch) => rpc('library:update', id, patch),
      thumbUrl: (id) => `/api/drive/thumb/${encodeURIComponent(id)}`,
      streamUrl: (id) => `/api/drive/stream/${encodeURIComponent(id)}`,
      verticals: () => rpc('library:verticals'),
      saveVertical: (id, code) => rpc('library:saveVertical', id, code),
      folders: () => rpc('library:folders'),
      text: (id) => rpc('library:text', id),
      retranscribe: (id) => rpc('library:retranscribe', id),
      queue: () => rpc('library:queue'),
      upload: (input, onProgress) => uploadCreative(input, onProgress),
      delete: (id) => rpc('library:delete', id),
    },

    reports: {
      save: (fileId, text) => rpc('reports:save', fileId, text),
      remove: (fileId) => rpc('reports:remove', fileId),
      resolve: (fileId) => rpc('reports:resolve', fileId),
    },

    duplicates: {
      mark: (fileId, originalId) => rpc('duplicates:mark', fileId, originalId),
      unmark: (fileId) => rpc('duplicates:unmark', fileId),
      clear: (fileId) => rpc('duplicates:clear', fileId),
    },

    history: {
      list: () => rpc('history:list'),
    },

    offers: {
      list: () => rpc('offers:list'),
      save: (input) => rpc('offers:save', input),
      delete: (id) => rpc('offers:delete', id),
      partners: () => rpc('offers:partners'),
      uploadPhoto: (id, file) => uploadOfferPhoto(id, file),
    },

    knowledge: {
      list: () => rpc('knowledge:list'),
      get: (id) => rpc('knowledge:get', id),
      save: (input) => rpc('knowledge:save', input),
      delete: (id) => rpc('knowledge:delete', id),
      upload: (file, onProgress) => uploadKnowledge(file, onProgress),
    },

    dashboard: {
      overview: (kind, anchor) => rpc('dashboard:overview', kind, anchor ?? null),
      detail: (metricId, kind, anchor) => rpc('dashboard:detail', metricId, kind, anchor),
      sync: () => rpc('dashboard:sync'),
    },

    grants: {
      overview: () => rpc('grants:overview'),
      apply: (changes) => rpc('grants:apply', changes),
      saveTeam: (input) => rpc('grants:saveTeam', input),
      deleteTeam: (id) => rpc('grants:deleteTeam', id),
      log: () => rpc('grants:log'),
    },

    domains: {
      overview: (fresh) => rpc('domains:overview', fresh ?? false),
      subdomains: (root) => rpc('domains:subdomains', root),
      update: (root, patch) => rpc('domains:update', root, patch),
      banSub: (host, banned, remove) => rpc('domains:banSub', host, banned, remove),
      buyers: () => rpc('domains:buyers'),
      issue: (input) => rpc('domains:issue', input),
      cleanup: (root) => rpc('domains:cleanup', root),
      renew: (domains) => rpc('domains:renew', domains),
      check: (domains) => rpc('domains:check', domains),
      buy: (input) => rpc('domains:buy', input),
    },

    caps: {
      report: (date) => rpc('caps:report', date ?? null),
      offers: () => rpc('caps:offers'),
      save: (input) => rpc('caps:save', input),
      delete: (id) => rpc('caps:delete', id),
      testTelegram: () => rpc('caps:testTelegram'),
      buyers: (capId, date, days) => rpc('caps:buyers', capId, date, days),
    },

    tags: {
      list: () => rpc('tags:list'),
      save: (tag) => rpc('tags:save', tag),
      delete: (id) => rpc('tags:delete', id),
      toggle: (fileId, tagId, on) => rpc('tags:toggle', fileId, tagId, on),
    },

    stats: {
      facets: () => rpc('stats:facets'),
      overview: (filter) => rpc('stats:overview', filter),
      detail: (id, filter) => rpc('stats:detail', id, filter),
      updateLandVideo: (id, patch) => rpc('stats:updateLandVideo', id, patch),
      deleteLandVideo: (id) => rpc('stats:deleteLandVideo', id),
      snippet: () => rpc('stats:snippet'),
      apiKeys: () => rpc('stats:apiKeys'),
      createApiKey: (name) => rpc('stats:createApiKey', name),
      revokeApiKey: (id) => rpc('stats:revokeApiKey', id),
      apiBase: () => rpc('stats:apiBase'),
      craftStatus: () => rpc('stats:craftStatus'),
    },
  };
}
