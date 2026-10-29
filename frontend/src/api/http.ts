import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('bfa_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
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
