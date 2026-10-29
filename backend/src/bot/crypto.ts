import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config';

const key = Buffer.from(config.botKeySecret, 'hex');

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');
  const data = Buffer.from(dataPart, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function maskKey(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 3)}***${value.slice(-4)}`;
}
