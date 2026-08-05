import { useEffect, useRef, useState } from "react";

import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_PROMPT_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
} from "../shared/protocol.js";
import {
  MAX_PENDING_ATTACHMENTS,
  MAX_TEXT_ATTACHMENTS,
  isPendingImage,
  readPendingAttachment,
  serializeTextAttachments,
  type PendingAttachment,
  type PendingTextAttachment,
} from "./attachment-upload.js";

const textEncoder = new TextEncoder();

export function useAttachments(supportsImages: boolean) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const readingRef = useRef(false);

  useEffect(() => {
    if (supportsImages) setError(undefined);
  }, [supportsImages]);

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0 || readingRef.current) return;
    readingRef.current = true;
    setReading(true);
    setError(undefined);
    const next = [...attachmentsRef.current];
    const errors = new Set<string>();
    const candidates = files.slice(0, MAX_PENDING_ATTACHMENTS);
    if (files.length > candidates.length) {
      errors.add(`You can attach at most ${MAX_PENDING_ATTACHMENTS} files at a time.`);
    }

    try {
      for (const file of candidates) {
        if (next.length >= MAX_PENDING_ATTACHMENTS) {
          errors.add(`You can attach at most ${MAX_PENDING_ATTACHMENTS} files.`);
          break;
        }

        try {
          const attachment = await readPendingAttachment(file);
          if (isPendingImage(attachment)) {
            if (!supportsImages) {
              errors.add("The selected model does not support image input.");
              continue;
            }
            const images = next.filter(isPendingImage);
            if (images.length >= MAX_IMAGE_ATTACHMENTS) {
              errors.add(`You can attach at most ${MAX_IMAGE_ATTACHMENTS} images.`);
              continue;
            }
            const totalImageBytes = images.reduce((total, item) => total + item.bytes, 0);
            if (totalImageBytes + attachment.bytes > MAX_TOTAL_IMAGE_BYTES) {
              errors.add(
                `Images can total at most ${Math.round(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)} MiB.`,
              );
              continue;
            }
          } else {
            const textFiles = next.filter(
              (item): item is PendingTextAttachment => item.type === "text-file",
            );
            if (textFiles.length >= MAX_TEXT_ATTACHMENTS) {
              errors.add(`You can attach at most ${MAX_TEXT_ATTACHMENTS} text or code files.`);
              continue;
            }
            const serialized = serializeTextAttachments([...textFiles, attachment]);
            if (textEncoder.encode(serialized).byteLength > MAX_PROMPT_BYTES) {
              errors.add(
                `Text and code attachments can total at most ${MAX_PROMPT_BYTES / 1024} KiB.`,
              );
              continue;
            }
          }
          next.push(attachment);
        } catch (attachmentError) {
          errors.add(
            attachmentError instanceof Error ? attachmentError.message : "Could not read a file",
          );
        }
      }
      attachmentsRef.current = next;
      setAttachments(next);
      setError(errors.size > 0 ? [...errors].join(" ") : undefined);
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  };

  const removeAttachment = (id: string) => {
    const next = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
    setError(undefined);
  };

  const clearAttachments = () => {
    attachmentsRef.current = [];
    setAttachments([]);
    setError(undefined);
  };

  return {
    attachments,
    images: attachments.filter(isPendingImage),
    textFiles: attachments.filter(
      (attachment): attachment is PendingTextAttachment => attachment.type === "text-file",
    ),
    error,
    reading,
    dragging,
    setDragging,
    addFiles,
    removeAttachment,
    clearAttachments,
  };
}
