import { decodedBase64Bytes, detectImageMediaType } from "../shared/images.js";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARACTERS,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  type ImageAttachment,
} from "../shared/protocol.js";
import { AppError } from "./errors.js";

const supportedMediaTypes = new Set<string>(SUPPORTED_IMAGE_MEDIA_TYPES);

export function safeImageAttachment(value: unknown): ImageAttachment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const image = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (
    image.type !== "image" ||
    typeof image.data !== "string" ||
    image.data.length > MAX_IMAGE_BASE64_CHARACTERS ||
    typeof image.mimeType !== "string" ||
    !supportedMediaTypes.has(image.mimeType)
  ) {
    return undefined;
  }
  const bytes = decodedBase64Bytes(image.data);
  if (bytes === undefined || bytes > MAX_IMAGE_BYTES) return undefined;
  const signature = Buffer.from(image.data.slice(0, 32), "base64");
  if (detectImageMediaType(signature) !== image.mimeType) return undefined;
  return {
    type: "image",
    data: image.data,
    mimeType: image.mimeType as ImageAttachment["mimeType"],
  };
}

export function validateImageAttachments(images: readonly ImageAttachment[]): void {
  if (images.length > MAX_IMAGE_ATTACHMENTS) {
    throw new AppError(
      400,
      "too_many_images",
      `A prompt can include at most ${MAX_IMAGE_ATTACHMENTS} images`,
    );
  }
  let totalBytes = 0;
  for (const image of images) {
    const bytes = decodedBase64Bytes(image.data);
    if (bytes === undefined || bytes > MAX_IMAGE_BYTES) {
      throw new AppError(400, "invalid_image", "An image has invalid or oversized base64 data");
    }
    totalBytes += bytes;
    const signature = Buffer.from(image.data.slice(0, 32), "base64");
    if (detectImageMediaType(signature) !== image.mimeType) {
      throw new AppError(
        400,
        "invalid_image",
        "An image's contents do not match its declared media type",
      );
    }
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new AppError(
      400,
      "image_too_large",
      `Images exceed the ${MAX_TOTAL_IMAGE_BYTES} byte combined size limit`,
    );
  }
}
