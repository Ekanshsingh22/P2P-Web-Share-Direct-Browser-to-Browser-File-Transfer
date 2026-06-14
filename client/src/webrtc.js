import { saveChunk, saveMeta, getMeta } from './db';

// Custom Hex/Bytes conversion helpers
export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------
// Cryptography Helpers (Web Crypto API)
// ----------------------------------------------------

// Generate a random 256-bit AES-GCM key
export async function generateEncryptionKey() {
  return await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// Export CryptoKey to a Hex string (so it can be appended to the URL hash)
export async function exportKey(key) {
  const raw = await window.crypto.subtle.exportKey('raw', key);
  return bytesToHex(new Uint8Array(raw));
}

// Import Hex string back to a CryptoKey
export async function importKey(hexKey) {
  const bytes = hexToBytes(hexKey);
  return await window.crypto.subtle.importKey(
    'raw',
    bytes,
    'AES-GCM',
    true,
    ['encrypt', 'decrypt']
  );
}

// Compute SHA-256 hash of an ArrayBuffer
export async function computeSHA256(arrayBuffer) {
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// Encrypt a chunk of file data using AES-GCM
// Returns a Uint8Array containing: [12 bytes IV] + [encrypted payload]
export async function encryptChunk(key, arrayBuffer) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    arrayBuffer
  );
  
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return combined;
}

// Decrypt a combined chunk buffer [12 bytes IV] + [encrypted payload] using AES-GCM
// Returns the original decrypted ArrayBuffer
export async function decryptChunk(key, combinedBuffer) {
  const combined = new Uint8Array(combinedBuffer);
  const iv = combined.slice(0, 12);
  const encryptedData = combined.slice(12);
  
  return await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encryptedData.buffer
  );
}

// ----------------------------------------------------
// File Chunk Packet Layout:
// [4 bytes: chunkIndex (big-endian)] +
// [32 bytes: chunkHash (SHA-256 hex converted to 32 bytes)] +
// [12 bytes: IV] + [encrypted payload]
// ----------------------------------------------------

export async function createChunkPacket(key, chunkIndex, chunkData) {
  // 1. Compute hash of the raw (unencrypted) chunk to verify integrity later
  const rawHashHex = await computeSHA256(chunkData);
  const hashBytes = hexToBytes(rawHashHex); // 32 bytes

  // 2. Encrypt the chunk
  const encryptedCombined = await encryptChunk(key, chunkData);

  // 3. Create the packet header (4 bytes index + 32 bytes hash)
  const headerBuffer = new ArrayBuffer(36);
  const view = new DataView(headerBuffer);
  view.setUint32(0, chunkIndex, false); // Big-endian
  
  const headerBytes = new Uint8Array(headerBuffer);
  headerBytes.set(hashBytes, 4);

  // 4. Combine header and encrypted packet
  const packet = new Uint8Array(headerBytes.length + encryptedCombined.length);
  packet.set(headerBytes, 0);
  packet.set(encryptedCombined, headerBytes.length);

  return packet;
}

export async function parseChunkPacket(key, packetBuffer) {
  const packet = new Uint8Array(packetBuffer);
  
  // 1. Read chunkIndex (bytes 0-3)
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const chunkIndex = view.getUint32(0, false);

  // 2. Read chunkHash (bytes 4-35)
  const hashBytes = packet.slice(4, 36);
  const expectedHashHex = bytesToHex(hashBytes);

  // 3. Read encrypted payload (bytes 36+)
  const encryptedPayloadBytes = packet.slice(36);

  // 4. Decrypt payload
  const decryptedArrayBuffer = await decryptChunk(key, encryptedPayloadBytes);

  // 5. Verify chunk hash
  const actualHashHex = await computeSHA256(decryptedArrayBuffer);
  if (actualHashHex !== expectedHashHex) {
    throw new Error(`Data corruption detected at chunk ${chunkIndex}. Hash mismatch.`);
  }

  return {
    chunkIndex,
    decryptedData: decryptedArrayBuffer
  };
}

// ----------------------------------------------------
// WebRTC Configuration Constants
// ----------------------------------------------------
export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

export const CHUNK_SIZE = 64 * 1024; // 64KB chunks
