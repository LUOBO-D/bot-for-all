import type { Server } from 'socket.io';
import type { MessageDTO } from '../types';

let server: Server | null = null;

export function setSocketServer(io: Server): void {
  server = io;
}

export function getSocketServer(): Server | null {
  return server;
}

export function broadcastMessageUpdated(roomId: number, message: MessageDTO): void {
  server?.to(`room:${roomId}`).emit('message:updated', { roomId, message });
}
