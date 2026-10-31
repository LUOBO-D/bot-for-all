import axios from 'axios';
import { defineStore } from 'pinia';
import http from '../api/http';
import { connectSocket, disconnectSocket } from '../socket';
import type { User } from '../types';

interface AuthState {
  token: string | null;
  user: User | null;
}

// Kept outside the store so a re-created store (logout → login) cannot stack
// duplicate connect_error listeners on the singleton socket.
let connectErrorHandler: ((error: Error) => void) | null = null;

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: localStorage.getItem('bfa_token'),
    user: null,
  }),
  actions: {
    setSession(token: string, user: User) {
      this.token = token;
      this.user = user;
      localStorage.setItem('bfa_token', token);
      const socket = connectSocket(token);
      if (connectErrorHandler) {
        socket.off('connect_error', connectErrorHandler);
      }
      connectErrorHandler = (error: Error) => {
        if (error.message === 'UNAUTHORIZED') {
          this.logout();
        }
      };
      socket.on('connect_error', connectErrorHandler);
    },
    async login(username: string, password: string) {
      const { data } = await http.post<{ token: string; user: User }>('/auth/login', {
        username,
        password,
      });
      this.setSession(data.token, data.user);
    },
    async register(payload: {
      username: string;
      password: string;
      displayName?: string;
      captchaId?: string;
      captchaText?: string;
    }) {
      const { data } = await http.post<{ token: string; user: User }>('/auth/register', payload);
      this.setSession(data.token, data.user);
    },
    async fetchMe() {
      if (!this.token) {
        return;
      }
      try {
        const { data } = await http.get<{ user: User }>('/auth/me');
        this.user = data.user;
        connectSocket(this.token);
      } catch (error) {
        // A flaky network must not destroy the session; only an explicit
        // rejection by the server means the token is gone.
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          this.logout();
        }
      }
    },
    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem('bfa_token');
      const socket = disconnectSocket();
      if (connectErrorHandler) {
        socket?.off('connect_error', connectErrorHandler);
        connectErrorHandler = null;
      }
    },
  },
});
