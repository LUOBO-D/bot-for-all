const rooms = new Map<number, Map<number, Set<string>>>();

export function addSocket(roomId: number, userId: number, socketId: string): boolean {
  let users = rooms.get(roomId);
  if (!users) {
    users = new Map();
    rooms.set(roomId, users);
  }
  let sockets = users.get(userId);
  if (!sockets) {
    sockets = new Set();
    users.set(userId, sockets);
  }
  const first = sockets.size === 0;
  sockets.add(socketId);
  return first;
}

export function removeSocket(roomId: number, userId: number, socketId: string): boolean {
  const users = rooms.get(roomId);
  if (!users) {
    return false;
  }
  const sockets = users.get(userId);
  if (!sockets) {
    return false;
  }
  sockets.delete(socketId);
  if (sockets.size > 0) {
    return false;
  }
  users.delete(userId);
  if (users.size === 0) {
    rooms.delete(roomId);
  }
  return true;
}

export function onlineUserIds(roomId: number): number[] {
  const users = rooms.get(roomId);
  return users ? [...users.keys()] : [];
}

export function isOnline(roomId: number, userId: number): boolean {
  return rooms.get(roomId)?.has(userId) ?? false;
}
