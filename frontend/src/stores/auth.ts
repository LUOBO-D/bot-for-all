import axios from 'axios';
import { defineStore } from 'pinia';
import http from '../api/http';
import { connectSocket, disconnectSocket } from '../socket';
import { useChatStore } from './chat';
import type { User } from '../types';

interface AuthState {
  token: string | null;
  user: User | null;
  offline: boolean;
}

// Kept outside the store so a re-created store (logout → login) cannot stack
// duplicate connect_error listeners on the singleton socket.
let connectErrorHandler: ((error: Error) => void) | null = null;

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: localStorage.getItem('bfa_token'),
    user: null,
    offline: false,
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
    // A rotated token for the same account (change-password, logout-other-devices)
    // must replace the stored credential without tearing down the session, so
    // `user`, the open room and the dialog all survive the swap.
    updateToken(token: string) {
      this.token = token;
      localStorage.setItem('bfa_token', token);
      // connectSocket() only re-handshakes while the socket is down, and the
      // server validates the token version during the handshake — an already
      // open socket would keep running on the credential just invalidated.
      const socket = connectSocket(token);
      if (socket.connected) {
        socket.disconnect();
        socket.connect();
      }
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
        this.offline = false;
        connectSocket(this.token);
      } catch (error) {
        // Only an explicit auth rejection destroys the session; network
        // errors and 5xx keep the token and flag offline for retry.
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status === 401 || status === 403) {
            this.offline = false;
            this.logout();
            return;
          }
        }
        this.offline = true;
      }
    },
    logout() {
      this.token = null;
      this.user = null;
      this.offline = false;
      localStorage.removeItem('bfa_token');
      // Drop the previous account's rooms/messages so the next login
      // never flashes stale state (socket UNAUTHORIZED path included).
      // dispose() first: $reset() clears state but leaves the socket
      // listeners and timers of the old binding attached.
      try {
        const chat = useChatStore();
        chat.dispose();
        chat.$reset();
      } catch {
        // store may be unavailable during teardown; token/user already cleared
      }
      const socket = disconnectSocket();
      if (connectErrorHandler) {
        socket?.off('connect_error', connectErrorHandler);
        connectErrorHandler = null;
      }
    },
  },
});
