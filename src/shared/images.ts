export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number];

function base64Value(code: number): number | undefined {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return undefined;
}

export function decodedBase64Bytes(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index++) {
    if (base64Value(value.charCodeAt(index)) === undefined) return undefined;
  }
  for (let index = dataLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 0x3d) return undefined;
  }

  // Reject non-canonical encodings whose unused bits are non-zero.
  const finalValue = base64Value(value.charCodeAt(dataLength - 1));
  if (finalValue === undefined) return undefined;
  if (
    (padding === 2 && (finalValue & 0x0f) !== 0) ||
    (padding === 1 && (finalValue & 0x03) !== 0)
  ) {
    return undefined;
  }
  return (value.length / 4) * 3 - padding;
}

export function detectImageMediaType(bytes: ArrayLike<number>): ImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}
