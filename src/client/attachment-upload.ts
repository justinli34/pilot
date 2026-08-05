import { detectImageMediaType } from "../shared/images.js";
import {
  MAX_IMAGE_BYTES,
  MAX_PROMPT_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  type ImageAttachment,
} from "../shared/protocol.js";

export const MAX_TEXT_ATTACHMENTS = 5;
export const MAX_TEXT_FILE_BYTES = MAX_PROMPT_BYTES;
export const MAX_PENDING_ATTACHMENTS = 10;

export interface PendingImage extends ImageAttachment {
  id: string;
  name: string;
  bytes: number;
}

export interface PendingTextAttachment {
  type: "text-file";
  id: string;
  name: string;
  bytes: number;
  text: string;
}

export type PendingAttachment = PendingImage | PendingTextAttachment;

export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function safeName(file: File): string {
  let normalized = "";
  for (const character of file.name) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) normalized += character;
  }
  return (normalized.trim() || "Pasted file").slice(0, 200);
}

function isLikelySupportedImage(file: File): boolean {
  return (
    SUPPORTED_IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === file.type) ||
    /\.(?:png|jpe?g|gif|webp)$/i.test(file.name)
  );
}

function isProbablyText(value: string): boolean {
  if (value.includes("\0")) return false;
  let controls = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controls += 1;
    }
  }
  return controls <= Math.max(2, Math.floor(value.length / 100));
}

export function isPendingImage(attachment: PendingAttachment): attachment is PendingImage {
  return attachment.type === "image";
}

export async function readPendingAttachment(file: File): Promise<PendingAttachment> {
  const name = safeName(file);
  if (file.size === 0) throw new AttachmentUploadError(`${name} is empty`);

  if (file.size > MAX_IMAGE_BYTES) {
    const initialLimit = isLikelySupportedImage(file) ? MAX_IMAGE_BYTES : MAX_TEXT_FILE_BYTES;
    const limit =
      initialLimit >= 1024 * 1024
        ? `${Math.round(initialLimit / 1024 / 1024)} MiB`
        : `${Math.round(initialLimit / 1024)} KiB`;
    throw new AttachmentUploadError(`${name} is larger than ${limit}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new AttachmentUploadError(`Could not read ${name}`);
  }

  const mimeType = detectImageMediaType(bytes);
  if (mimeType) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new AttachmentUploadError(
        `${name} is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB`,
      );
    }
    return {
      id: crypto.randomUUID(),
      name,
      bytes: bytes.byteLength,
      type: "image",
      data: bytesToBase64(bytes),
      mimeType,
    };
  }

  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new AttachmentUploadError(
      `${name} is larger than ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KiB`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentUploadError(`${name} is not a UTF-8 text or supported image file`);
  }
  if (!isProbablyText(text)) {
    throw new AttachmentUploadError(`${name} is not a UTF-8 text or supported image file`);
  }

  return {
    type: "text-file",
    id: crypto.randomUUID(),
    name,
    bytes: bytes.byteLength,
    text,
  };
}

export function pendingImageSource(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function codeFence(text: string): string {
  let longestRun = 0;
  let currentRun = 0;
  for (const character of text) {
    if (character === "`") {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function serializeTextAttachments(files: readonly PendingTextAttachment[]): string {
  if (files.length === 0) return "";
  const rendered = files.map((file) => {
    const fence = codeFence(file.text);
    const trailingNewline = file.text.endsWith("\n") ? "" : "\n";
    return `Attached file ${JSON.stringify(file.name)}:\n${fence}\n${file.text}${trailingNewline}${fence}`;
  });
  return `The following files were attached by the user:\n\n${rendered.join("\n\n")}`;
}

export function appendTextAttachments(
  prompt: string,
  files: readonly PendingTextAttachment[],
): string {
  const attachments = serializeTextAttachments(files);
  if (!attachments) return prompt;
  return prompt.trim().length > 0 ? `${prompt}\n\n${attachments}` : attachments;
}
