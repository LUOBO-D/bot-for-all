import { io, type Socket } from 'socket.io-client';

declare global {
  interface Window {
    __socket?: Socket;
  }
}

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io('/', {
      autoConnect: false,
      transports: ['websocket', 'polling'],
    });
    if (import.meta.env.DEV) {
      window.__socket = socket;
    }
  }
  return socket;
}

export function connectSocket(token: string): Socket {
  const instance = getSocket();
  instance.auth = { token };
  if (!instance.connected) {
    instance.connect();
  }
  return instance;
}

export function disconnectSocket(): Socket | null {
  if (!socket) {
    return null;
  }
  socket.disconnect();
  return socket;
}
