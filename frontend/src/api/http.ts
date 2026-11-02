import axios from 'axios';

// Every JSON call gets a hard ceiling so a stalled request cannot pin the UI
// (the boot /auth/me path has its own, shorter guard in main.ts). Uploads are
// the exception: a multi-megabyte body legitimately takes longer than a small
// API call, so the request interceptor lifts the ceiling for multipart bodies.
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
// Blob responses include attachments and large JSON/ZIP/CSV exports; a slow
// link can legitimately take far longer than a small JSON request.
const BLOB_TIMEOUT_MS = 120_000;

const http = axios.create({ baseURL: '/api', timeout: DEFAULT_TIMEOUT_MS });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('bfa_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    config.timeout = UPLOAD_TIMEOUT_MS;
  } else if (config.responseType === 'blob') {
    config.timeout = BLOB_TIMEOUT_MS;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      localStorage.removeItem('bfa_token');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data: unknown = error.response?.data;
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const apiError = data.error;
      if (
        typeof apiError === 'object' &&
        apiError !== null &&
        'message' in apiError &&
        typeof apiError.message === 'string'
      ) {
        return apiError.message;
      }
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export default http;
