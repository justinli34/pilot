import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  MAX_PROMPT_BYTES,
  type ImageAttachment,
  type MessageQueueState,
  type QueuedMessage,
  type StreamingBehavior,
} from "../shared/protocol.js";
import { AppError, errorMessage } from "./errors.js";
import { redactText, truncateUtf8 } from "./security.js";

type InternalQueuedMessage = Omit<QueuedMessage, "imageCount" | "truncated"> & {
  images: ImageAttachment[];
};

interface ImageReservation {
  text: string;
  images: ImageAttachment[];
  active: boolean;
}
type PiMessageQueue = Pick<
  AgentSession,
  "clearQueue" | "followUp" | "getFollowUpMessages" | "getSteeringMessages" | "steer"
>;

export interface NativeMessageQueueOptions {
  session: PiMessageQueue;
  onChange: (queue: MessageQueueState) => void;
  onRestoreError: (error: unknown) => void;
}

export class NativeMessageQueue {
  private messages: InternalQueuedMessage[] = [];
  private revision = 0;
  private nextId = 0;
  private mutating = false;
  private suppressNativeEvents = false;
  private readonly imageReservations: Record<StreamingBehavior, ImageReservation[]> = {
    steer: [],
    followUp: [],
  };

  constructor(private readonly options: NativeMessageQueueOptions) {}

  get isMutating(): boolean {
    return this.mutating;
  }

  get depth(): number {
    return this.messages.length;
  }

  estimatedImageSize(): number {
    const messageBytes = this.messages.reduce(
      (total, message) =>
        total + message.images.reduce((imageTotal, image) => imageTotal + image.data.length, 0),
      0,
    );
    return (["steer", "followUp"] as const).reduce(
      (total, behavior) =>
        total +
        this.imageReservations[behavior].reduce(
          (reservationTotal, reservation) =>
            reservationTotal +
            reservation.images.reduce((imageTotal, image) => imageTotal + image.data.length, 0),
          0,
        ),
      messageBytes,
    );
  }

  reserveImages(
    text: string,
    streamingBehavior: StreamingBehavior,
    images: readonly ImageAttachment[],
  ): () => void {
    if (images.length === 0) return () => {};
    const reservation: ImageReservation = { text, images: [...images], active: true };
    this.imageReservations[streamingBehavior].push(reservation);
    return () => {
      if (!reservation.active) return;
      reservation.active = false;
      const reservations = this.imageReservations[streamingBehavior];
      const index = reservations.indexOf(reservation);
      if (index >= 0) reservations.splice(index, 1);
    };
  }

  snapshot(): MessageQueueState {
    return {
      revision: this.revision,
      messages: this.messages.map((message) => {
        const redacted = redactText(message.text);
        return {
          id: message.id,
          text: truncateUtf8(message.text, MAX_PROMPT_BYTES, "…"),
          streamingBehavior: message.streamingBehavior,
          imageCount: message.images.length,
          truncated: Buffer.byteLength(redacted, "utf8") > MAX_PROMPT_BYTES,
        };
      }),
    };
  }

  syncFromSession(notify = true): boolean {
    return this.apply(
      this.options.session.getSteeringMessages(),
      this.options.session.getFollowUpMessages(),
      this.messages,
      notify,
    );
  }

  handleNativeUpdate(steering: readonly string[], followUp: readonly string[]): boolean {
    if (this.suppressNativeEvents) return false;
    return this.apply(steering, followUp, this.messages, true);
  }

  async update(
    messageId: string,
    expectedRevision: number,
    text: string,
    streamingBehavior: StreamingBehavior,
  ): Promise<void> {
    await this.mutate(expectedRevision, (messages) => {
      let found = false;
      const updated = messages.map((message) => {
        if (message.id !== messageId) return message;
        found = true;
        if (text.trim().length === 0 && message.images.length === 0) {
          throw new AppError(400, "invalid_prompt", "Queued messages cannot be blank");
        }
        if (message.text === text && message.streamingBehavior === streamingBehavior)
          return message;
        return this.newMessage(text, streamingBehavior, message.images);
      });
      if (!found) {
        throw new AppError(
          409,
          "queued_message_changed",
          "That queued message was already delivered or changed",
        );
      }
      return updated;
    });
  }

  async delete(messageId: string, expectedRevision: number): Promise<void> {
    await this.mutate(expectedRevision, (messages) => {
      const remaining = messages.filter((message) => message.id !== messageId);
      if (remaining.length === messages.length) {
        throw new AppError(
          409,
          "queued_message_changed",
          "That queued message was already delivered or deleted",
        );
      }
      return remaining;
    });
  }

  async clear(expectedRevision: number): Promise<void> {
    await this.mutate(expectedRevision, () => []);
  }

  private takeReservedImages(
    text: string,
    streamingBehavior: StreamingBehavior,
  ): ImageAttachment[] {
    const reservations = this.imageReservations[streamingBehavior];
    const matchingIndex = reservations.findIndex((reservation) => reservation.text === text);
    const index = matchingIndex >= 0 ? matchingIndex : 0;
    const [reservation] = reservations.splice(index, 1);
    if (!reservation) return [];
    reservation.active = false;
    return reservation.images;
  }

  private newMessage(
    text: string,
    streamingBehavior: StreamingBehavior,
    images?: readonly ImageAttachment[],
  ): InternalQueuedMessage {
    return {
      id: `queue-${++this.nextId}`,
      text,
      streamingBehavior,
      images: images ? [...images] : this.takeReservedImages(text, streamingBehavior),
    };
  }

  private reconcileMode(
    texts: readonly string[],
    streamingBehavior: StreamingBehavior,
    preferred: readonly InternalQueuedMessage[],
  ): InternalQueuedMessage[] {
    const candidates = preferred.filter(
      (message) => message.streamingBehavior === streamingBehavior,
    );
    const isPrefix =
      candidates.length <= texts.length &&
      candidates.every((message, index) => message.text === texts[index]);
    if (isPrefix) {
      return [
        ...candidates,
        ...texts.slice(candidates.length).map((text) => this.newMessage(text, streamingBehavior)),
      ];
    }

    const suffixStart = candidates.length - texts.length;
    const isSuffix =
      texts.length <= candidates.length &&
      texts.every((text, index) => candidates[suffixStart + index]?.text === text);
    if (isSuffix) return candidates.slice(suffixStart);

    const unused = [...candidates];
    return texts.map((text) => {
      const index = unused.findIndex((message) => message.text === text);
      if (index < 0) return this.newMessage(text, streamingBehavior);
      const [existing] = unused.splice(index, 1);
      return existing ?? this.newMessage(text, streamingBehavior);
    });
  }

  private reconcile(
    steering: readonly string[],
    followUp: readonly string[],
    preferred: readonly InternalQueuedMessage[],
  ): InternalQueuedMessage[] {
    return [
      ...this.reconcileMode(steering, "steer", preferred),
      ...this.reconcileMode(followUp, "followUp", preferred),
    ];
  }

  private same(
    left: readonly InternalQueuedMessage[],
    right: readonly InternalQueuedMessage[],
  ): boolean {
    return (
      left.length === right.length &&
      left.every(
        (message, index) =>
          message.id === right[index]?.id &&
          message.text === right[index]?.text &&
          message.streamingBehavior === right[index]?.streamingBehavior &&
          message.images.length === right[index]?.images.length &&
          message.images.every(
            (image, imageIndex) =>
              image.mimeType === right[index]?.images[imageIndex]?.mimeType &&
              image.data === right[index]?.images[imageIndex]?.data,
          ),
      )
    );
  }

  private apply(
    steering: readonly string[],
    followUp: readonly string[],
    preferred: readonly InternalQueuedMessage[],
    notify: boolean,
  ): boolean {
    const next = this.reconcile(steering, followUp, preferred);
    if (this.same(this.messages, next)) return false;
    this.messages = next;
    this.revision += 1;
    if (notify) this.options.onChange(this.snapshot());
    return true;
  }

  private async write(messages: readonly InternalQueuedMessage[]): Promise<void> {
    this.options.session.clearQueue();
    await Promise.all(
      messages.map((message) =>
        message.streamingBehavior === "followUp"
          ? this.options.session.followUp(message.text, message.images)
          : this.options.session.steer(message.text, message.images),
      ),
    );
  }

  private async mutate(
    expectedRevision: number,
    transform: (messages: readonly InternalQueuedMessage[]) => InternalQueuedMessage[],
  ): Promise<void> {
    if (this.mutating) {
      throw new AppError(409, "queue_busy", "Another queued-message change is in progress");
    }

    this.syncFromSession();
    if (expectedRevision !== this.revision) {
      throw new AppError(
        409,
        "queue_changed",
        "The message queue changed; review it and try again",
      );
    }

    const original = this.messages.map((message) => ({
      ...message,
      images: [...message.images],
    }));
    const desired = transform(
      original.map((message) => ({ ...message, images: [...message.images] })),
    );
    if (this.same(original, desired)) return;

    this.mutating = true;
    this.suppressNativeEvents = true;
    let preferred = desired;
    let mutationError: unknown;
    try {
      await this.write(desired);
    } catch (error) {
      mutationError = error;
      preferred = original;
      try {
        await this.write(original);
      } catch (restoreError) {
        this.options.onRestoreError(restoreError);
      }
    } finally {
      this.suppressNativeEvents = false;
      this.mutating = false;
      this.apply(
        this.options.session.getSteeringMessages(),
        this.options.session.getFollowUpMessages(),
        preferred,
        true,
      );
    }

    if (mutationError) {
      throw new AppError(
        400,
        "queued_message_invalid",
        `Could not update the queued message: ${truncateUtf8(errorMessage(mutationError), 2_048, "…")}`,
      );
    }
  }
}
