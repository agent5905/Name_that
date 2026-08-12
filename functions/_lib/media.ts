import { ApiError } from './api';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES * 2 + 256 * 1024;
const MAX_PIXELS = 2_000_000;

export interface DecodedPng {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mimeType: 'image/png';
  readonly extension: 'png';
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  CRC_TABLE[index] = value >>> 0;
}

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const bytes of parts) {
    for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[], length = parts.reduce((sum, part) => sum + part.byteLength, 0)): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(typeBytes, 4);
  result.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32([typeBytes, data]));
  return result;
}

async function streamWithLimit(stream: ReadableStream<Uint8Array>, limit: number, code: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new ApiError(413, code, 'Upload is too large.');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return concat(parts, total);
}

export async function boundedMultipart(request: Request): Promise<FormData> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Upload is too large.');
  if (!request.body) throw new ApiError(422, 'IMAGE_REQUIRED', 'An image is required.');
  const bytes = await streamWithLimit(request.body, MAX_MULTIPART_BYTES, 'PAYLOAD_TOO_LARGE');
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) throw new ApiError(415, 'INVALID_MULTIPART', 'Use a multipart image upload.');
  const bounded = new Request(request.url, { method: 'POST', headers: { 'content-type': contentType }, body: new Blob([bytes.slice().buffer]) });
  return bounded.formData();
}

export async function encryptRevealWithKey(bytes:Uint8Array,keyValue:string,ivValue:string,aad:string):Promise<Uint8Array>{
 const decode=(value:string)=>{const padded=value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4);return Uint8Array.from(atob(padded),character=>character.charCodeAt(0));};
 const key=await crypto.subtle.importKey('raw',decode(keyValue).slice().buffer,{name:'AES-GCM'},false,['encrypt']);
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:decode(ivValue).slice().buffer,additionalData:new TextEncoder().encode(aad)},key,bytes.slice().buffer);return new Uint8Array(encrypted);
}

export async function safeImage(value: FormDataEntryValue | null): Promise<DecodedPng> {
  if (!(value instanceof File)) throw new ApiError(422, 'IMAGE_REQUIRED', 'An image is required.');
  if (value.size < 1 || value.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Images must be 5 MiB or smaller.');
  if (value.type && value.type.toLowerCase() !== 'image/png') throw new ApiError(415, 'IMAGE_TYPE_MISMATCH', 'The normalized upload must be a PNG image.');
  const bytes = new Uint8Array(await value.arrayBuffer());
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, sawHeader = false, sawData = false, sawEnd = false;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    if (length > MAX_UPLOAD_BYTES || offset + 12 + length > bytes.byteLength) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
    const typeBytes = bytes.slice(offset + 4, offset + 8);
    const type = new TextDecoder().decode(typeBytes);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    const expectedCrc = view.getUint32(offset + 8 + length);
    if (crc32([typeBytes, data]) !== expectedCrc) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4);
      if (width < 1 || height < 1 || width > 2000 || height > 2000 || width * height > MAX_PIXELS ||
          data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'Use a non-interlaced 8-bit RGBA PNG no larger than 2 megapixels.');
      }
      sawHeader = true;
    } else if (type === 'IDAT') { sawData = true; idat.push(data); }
    else if (type === 'IEND') { if (length !== 0) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.'); sawEnd = true; offset += 12; break; }
    offset += 12 + length;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== bytes.byteLength) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
  const rowBytes = width * 4;
  const expectedInflated = (rowBytes + 1) * height;
  let inflated: Uint8Array;
  try {
    const compressed = concat(idat);
    inflated = await streamWithLimit(new Blob([compressed.slice().buffer]).stream().pipeThrough(new DecompressionStream('deflate')), expectedInflated, 'IMAGE_DECODE_TOO_LARGE');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
  }
  if (inflated.byteLength !== expectedInflated) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * (rowBytes + 1);
    const filter = inflated[sourceStart] ?? 255;
    if (filter > 4) throw new ApiError(415, 'UNSAFE_IMAGE_TYPE', 'The image could not be decoded safely.');
  }
  // The browser already emits normalized RGBA PNGs. Fully inflating the IDAT
  // stream proves that the compressed payload is complete, bounded, and has a
  // valid filter byte for every row. Preserve those verified source bytes;
  // decoding every pixel and recompressing it here doubled peak memory and CPU
  // and could exceed the Pages Worker limits on otherwise valid 5 MiB pairs.
  return { bytes, width, height, mimeType: 'image/png', extension: 'png' };
}

export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  if (rgba.byteLength !== width * height * 4) throw new Error('Invalid RGBA buffer.');
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width); header.setUint32(4, height); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  return concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())]);
}
