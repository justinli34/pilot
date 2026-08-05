import { z } from "zod/mini";

import { SUPPORTED_IMAGE_MEDIA_TYPES, decodedBase64Bytes } from "./images.js";

export { SUPPORTED_IMAGE_MEDIA_TYPES, type ImageMediaType } from "./images.js";

export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_MODEL_ID_LENGTH = 256;
export const MAX_SESSION_NAME_LENGTH = 512;
export const MAX_SESSION_NAME_BYTES = 512;
export const TRANSCRIPT_LIMIT_NOTICE_ID = "pilot-transcript-limit";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodMiniType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const SessionStatusSchema = z.enum(["idle", "running", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const RuntimePhaseSchema = z.enum([
  "idle",
  "running",
  "retrying",
  "compacting",
  "aborting",
  "error",
]);
export type RuntimePhase = z.infer<typeof RuntimePhaseSchema>;

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const StreamingBehaviorSchema = z.enum(["steer", "followUp"]);
export type StreamingBehavior = z.infer<typeof StreamingBehaviorSchema>;

export const QueuedMessageSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  streamingBehavior: StreamingBehaviorSchema,
  imageCount: z.number().check(z.int(), z.nonnegative()),
  truncated: z.boolean(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

export const MessageQueueStateSchema = z.strictObject({
  revision: z.number().check(z.int(), z.nonnegative()),
  messages: z.array(QueuedMessageSchema),
});
export type MessageQueueState = z.infer<typeof MessageQueueStateSchema>;

export const ToolStatusSchema = z.enum(["running", "succeeded", "failed", "aborted"]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const ProjectSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  path: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SessionSummarySchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.optional(z.string()),
  firstMessage: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  messageCount: z.number().check(z.int(), z.nonnegative()),
  archived: z.boolean(),
  unread: z.boolean(),
  status: SessionStatusSchema,
  phase: RuntimePhaseSchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SafeModelSchema = z.strictObject({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  supportsImages: z.boolean(),
  contextWindow: z.number().check(z.nonnegative()),
});
export type SafeModel = z.infer<typeof SafeModelSchema>;

export const SlashCommandSummarySchema = z.strictObject({
  name: z.string(),
  description: z.optional(z.string()),
  source: z.enum(["extension", "prompt", "skill"]),
});
export type SlashCommandSummary = z.infer<typeof SlashCommandSummarySchema>;

export const ContextUsageSchema = z.strictObject({
  tokens: z.nullable(z.number().check(z.nonnegative())),
  contextWindow: z.number().check(z.nonnegative()),
  percent: z.nullable(z.number().check(z.nonnegative())),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const TextBlockSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

const ImageDataSchema = z.string().check(
  z.minLength(4, "Image data must be non-empty base64"),
  z.maxLength(MAX_IMAGE_BASE64_CHARACTERS, `Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`),
  z.refine((value) => decodedBase64Bytes(value) !== undefined, "Image data must be valid base64"),
  z.refine(
    (value) => (decodedBase64Bytes(value) ?? Infinity) <= MAX_IMAGE_BYTES,
    `Image exceeds the ${MAX_IMAGE_BYTES} byte size limit`,
  ),
);

export const ImageAttachmentSchema = z.strictObject({
  type: z.literal("image"),
  data: ImageDataSchema,
  mimeType: z.enum(SUPPORTED_IMAGE_MEDIA_TYPES),
});
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;

export const ThinkingBlockSchema = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  redacted: z.optional(z.boolean()),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

export const ToolCallBlockSchema = z.strictObject({
  type: z.literal("tool_call"),
  toolCallId: z.string(),
  name: z.string(),
  arguments: JsonValueSchema,
});
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;

export const TranscriptBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageAttachmentSchema,
  ThinkingBlockSchema,
  ToolCallBlockSchema,
]);
export type TranscriptBlock = z.infer<typeof TranscriptBlockSchema>;

export const TranscriptMessageSchema = z.strictObject({
  kind: z.literal("message"),
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  blocks: z.array(TranscriptBlockSchema),
  timestamp: z.number(),
  completedAt: z.optional(z.number()),
  model: z.optional(z.string()),
  stopReason: z.optional(z.string()),
  error: z.optional(z.string()),
  streaming: z.optional(z.boolean()),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const TranscriptNoticeSchema = z.strictObject({
  kind: z.literal("notice"),
  id: z.string(),
  tone: z.enum(["info", "warning", "error"]),
  title: z.string(),
  text: z.string(),
  timestamp: z.number(),
});
export type TranscriptNotice = z.infer<typeof TranscriptNoticeSchema>;

export const TranscriptBashExecutionSchema = z.strictObject({
  kind: z.literal("bash_execution"),
  id: z.string(),
  command: z.string(),
  output: z.string(),
  status: ToolStatusSchema,
  timestamp: z.number(),
});
export type TranscriptBashExecution = z.infer<typeof TranscriptBashExecutionSchema>;

export const TranscriptItemSchema = z.discriminatedUnion("kind", [
  TranscriptMessageSchema,
  TranscriptNoticeSchema,
  TranscriptBashExecutionSchema,
]);
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const ToolExecutionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  arguments: JsonValueSchema,
  status: ToolStatusSchema,
  output: z.string(),
  patch: z.optional(z.string()),
  error: z.optional(z.string()),
  startedAt: z.optional(z.number()),
  completedAt: z.optional(z.number()),
});
export type ToolExecution = z.infer<typeof ToolExecutionSchema>;

export const RuntimeErrorSchema = z.strictObject({
  action: z.string(),
  message: z.string(),
  at: z.number(),
});
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

export const RuntimeStateSchema = z.strictObject({
  phase: RuntimePhaseSchema,
  status: SessionStatusSchema,
  isBusy: z.boolean(),
  retry: z.optional(
    z.strictObject({
      attempt: z.number().check(z.int(), z.nonnegative()),
      maxAttempts: z.number().check(z.int(), z.nonnegative()),
      delayMs: z.number().check(z.nonnegative()),
    }),
  ),
  queueDepth: z.number().check(z.int(), z.nonnegative()),
  lastError: z.optional(RuntimeErrorSchema),
  updatedAt: z.number(),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const SessionIdentitySchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  name: z.optional(z.string()),
});
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

const ModelIdentitySchema = z.strictObject({ provider: z.string(), id: z.string() });

export const SessionSnapshotSchema = z.strictObject({
  identity: SessionIdentitySchema,
  transcript: z.array(TranscriptItemSchema),
  streamingMessage: z.nullable(TranscriptMessageSchema),
  tools: z.record(z.string(), ToolExecutionSchema),
  runtime: RuntimeStateSchema,
  queue: MessageQueueStateSchema,
  models: z.array(SafeModelSchema),
  currentModel: z.nullable(ModelIdentitySchema),
  thinkingLevel: ThinkingLevelSchema,
  thinkingLevels: z.array(ThinkingLevelSchema),
  contextUsage: z.nullable(ContextUsageSchema),
  commands: z.array(SlashCommandSummarySchema),
  permissionsNotice: z.string(),
  truncated: z.boolean(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const BoundedPromptTextSchema = z.string().check(
  z.maxLength(MAX_PROMPT_BYTES, `Prompt exceeds the ${MAX_PROMPT_BYTES} byte limit`),
  z.refine(
    (value) => utf8Bytes(value) <= MAX_PROMPT_BYTES,
    `Prompt exceeds the ${MAX_PROMPT_BYTES} byte limit`,
  ),
);
const ImageAttachmentsSchema = z.array(ImageAttachmentSchema).check(
  z.maxLength(
    MAX_IMAGE_ATTACHMENTS,
    `A prompt can include at most ${MAX_IMAGE_ATTACHMENTS} images`,
  ),
  z.refine(
    (images) =>
      images.reduce((total, image) => total + (decodedBase64Bytes(image.data) ?? Infinity), 0) <=
      MAX_TOTAL_IMAGE_BYTES,
    `Images exceed the ${MAX_TOTAL_IMAGE_BYTES} byte combined size limit`,
  ),
);
const ModelFieldSchema = z.string().check(z.minLength(1), z.maxLength(MAX_MODEL_ID_LENGTH));
const QueueMessageIdSchema = z.string().check(z.minLength(1), z.maxLength(128));
const QueueRevisionSchema = z.number().check(z.int(), z.nonnegative());

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("prompt"),
      text: BoundedPromptTextSchema,
      images: z.optional(ImageAttachmentsSchema),
      streamingBehavior: z.optional(StreamingBehaviorSchema),
    })
    .check(
      z.refine(
        (command) => command.text.trim().length > 0 || (command.images?.length ?? 0) > 0,
        "Prompt cannot be blank without an image",
      ),
    ),
  z.strictObject({ type: z.literal("abort") }),
  z.strictObject({
    type: z.literal("update_queued_message"),
    messageId: QueueMessageIdSchema,
    queueRevision: QueueRevisionSchema,
    text: BoundedPromptTextSchema,
    streamingBehavior: StreamingBehaviorSchema,
  }),
  z.strictObject({
    type: z.literal("delete_queued_message"),
    messageId: QueueMessageIdSchema,
    queueRevision: QueueRevisionSchema,
  }),
  z.strictObject({
    type: z.literal("clear_queued_messages"),
    queueRevision: QueueRevisionSchema,
  }),
  z.strictObject({
    type: z.literal("set_model"),
    provider: ModelFieldSchema,
    modelId: ModelFieldSchema,
  }),
  z.strictObject({ type: z.literal("set_thinking_level"), level: ThinkingLevelSchema }),
  z.strictObject({ type: z.literal("compact") }),
  z.strictObject({ type: z.literal("refresh") }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

const RequestIdSchema = z
  .string()
  .check(
    z.minLength(1),
    z.maxLength(MAX_REQUEST_ID_LENGTH),
    z.regex(/^[A-Za-z0-9._:-]+$/, "requestId contains unsupported characters"),
  );

export const ClientCommandEnvelopeSchema = z.strictObject({
  kind: z.literal("command"),
  requestId: RequestIdSchema,
  command: ClientCommandSchema,
});
export type ClientCommandEnvelope = z.infer<typeof ClientCommandEnvelopeSchema>;

export const AssistantDeltaSchema = z.strictObject({
  type: z.literal("assistant_delta"),
  messageId: z.string(),
  blockIndex: z.number().check(z.int(), z.nonnegative()),
  field: z.enum(["text", "thinking"]),
  append: z.string(),
});
export type AssistantDelta = z.infer<typeof AssistantDeltaSchema>;

export const ToolDeltaSchema = z.strictObject({
  type: z.literal("tool_delta"),
  toolId: z.string(),
  outputAppend: z.optional(z.string()),
  patchAppend: z.optional(z.string()),
});
export type ToolDelta = z.infer<typeof ToolDeltaSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), snapshot: SessionSnapshotSchema }),
  z.strictObject({ type: z.literal("session_ready") }),
  z.strictObject({
    type: z.literal("transcript_updated"),
    transcript: z.array(TranscriptItemSchema),
    tools: z.record(z.string(), ToolExecutionSchema),
    truncated: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("transcript_delta"),
    appended: z.array(TranscriptItemSchema),
    removedIds: z.array(z.string()),
    notice: z.nullable(TranscriptNoticeSchema),
    toolUpserts: z.record(z.string(), ToolExecutionSchema),
    removedToolIds: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("assistant_updated"),
    message: z.nullable(TranscriptMessageSchema),
  }),
  AssistantDeltaSchema,
  z.strictObject({ type: z.literal("tool_updated"), tool: ToolExecutionSchema }),
  ToolDeltaSchema,
  z.strictObject({ type: z.literal("queue_updated"), queue: MessageQueueStateSchema }),
  z.strictObject({
    type: z.literal("runtime_updated"),
    runtime: RuntimeStateSchema,
    currentModel: z.nullable(ModelIdentitySchema),
    thinkingLevel: ThinkingLevelSchema,
    thinkingLevels: z.array(ThinkingLevelSchema),
    contextUsage: z.nullable(ContextUsageSchema),
  }),
  z.strictObject({
    type: z.literal("notification"),
    tone: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

const ServerEnvelopeBase = {
  sessionId: z.string(),
  sequence: z.number().check(z.int(), z.nonnegative()),
  revision: z.optional(z.string().check(z.minLength(1), z.maxLength(128))),
};

export const ServerEventEnvelopeSchema = z.strictObject({
  ...ServerEnvelopeBase,
  kind: z.literal("event"),
  event: ServerEventSchema,
});
export type ServerEventEnvelope = z.infer<typeof ServerEventEnvelopeSchema>;

const ServerSuccessEnvelopeSchema = z.strictObject({
  ...ServerEnvelopeBase,
  kind: z.literal("response"),
  requestId: RequestIdSchema,
  ok: z.literal(true),
  result: z.optional(JsonValueSchema),
});
const ServerFailureEnvelopeSchema = z.strictObject({
  ...ServerEnvelopeBase,
  kind: z.literal("response"),
  requestId: RequestIdSchema,
  ok: z.literal(false),
  error: z.strictObject({ code: z.string(), message: z.string() }),
});
export const ServerResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  ServerSuccessEnvelopeSchema,
  ServerFailureEnvelopeSchema,
]);
export type ServerResponseEnvelope = z.infer<typeof ServerResponseEnvelopeSchema>;

export const ServerEnvelopeSchema = z.union([
  ServerEventEnvelopeSchema,
  ServerSuccessEnvelopeSchema,
  ServerFailureEnvelopeSchema,
]);
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;

export const ProjectsResponseSchema = z.strictObject({
  projects: z.array(ProjectSummarySchema),
  nextCursor: z.optional(z.string()),
});
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

export const ProjectResponseSchema = z.strictObject({ project: ProjectSummarySchema });
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const AddProjectRequestSchema = z.strictObject({
  path: z
    .string()
    .check(
      z.minLength(1, "Project path cannot be blank"),
      z.maxLength(4_096, "Project path is too long"),
    ),
});
export type AddProjectRequest = z.infer<typeof AddProjectRequestSchema>;

export const DeleteProjectResponseSchema = z.strictObject({
  removed: z.literal(true),
  projectId: z.string(),
});
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;

export const DirectoryEntrySchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  symlink: z.boolean(),
  hidden: z.boolean(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const DirectoryListingSchema = z.strictObject({
  path: z.string(),
  parent: z.optional(z.string()),
  home: z.string(),
  root: z.string(),
  directories: z.array(DirectoryEntrySchema),
});
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

export const SessionsResponseSchema = z.strictObject({
  sessions: z.array(SessionSummarySchema),
  nextCursor: z.optional(z.string()),
});
export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

export const WorkspaceSessionsStreamEnvelopeSchema = z.strictObject({
  kind: z.literal("workspace_sessions"),
  sessions: z.array(SessionSummarySchema),
});
export type WorkspaceSessionsStreamEnvelope = z.infer<typeof WorkspaceSessionsStreamEnvelopeSchema>;

export const CreateSessionResponseSchema = z.strictObject({ session: SessionSummarySchema });
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const RenameSessionRequestSchema = z.strictObject({
  name: z.string().check(
    z.minLength(1, "Session name cannot be blank"),
    z.maxLength(
      MAX_SESSION_NAME_LENGTH,
      `Session names are limited to ${MAX_SESSION_NAME_LENGTH} characters`,
    ),
    z.refine((value) => value.trim().length > 0, "Session name cannot be blank"),
    z.refine(
      (value) => utf8Bytes(value) <= MAX_SESSION_NAME_BYTES,
      `Session names are limited to ${MAX_SESSION_NAME_BYTES} bytes`,
    ),
  ),
});
export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>;

export const ArchiveSessionRequestSchema = z.strictObject({
  archived: z.boolean(),
});
export type ArchiveSessionRequest = z.infer<typeof ArchiveSessionRequestSchema>;

export const MarkSessionReadRequestSchema = z.strictObject({
  unread: z.literal(false),
});
export type MarkSessionReadRequest = z.infer<typeof MarkSessionReadRequestSchema>;

export const UpdateSessionRequestSchema = z.union([
  RenameSessionRequestSchema,
  ArchiveSessionRequestSchema,
  MarkSessionReadRequestSchema,
]);
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

export const UpdateSessionResponseSchema = z.strictObject({ session: SessionSummarySchema });
export type UpdateSessionResponse = z.infer<typeof UpdateSessionResponseSchema>;

export const DeleteSessionResponseSchema = z.strictObject({
  deleted: z.literal(true),
  sessionId: z.string(),
});
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;

export const ApiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.optional(z.string()),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function parseJson(input: string, source: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new ProtocolError("invalid_json", `${source} must be valid JSON`);
  }
}

function firstIssue(error: { issues: readonly { message: string }[] }): string {
  return error.issues[0]?.message ?? "Message does not match the protocol";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClientEnvelope(input: string): ClientCommandEnvelope {
  const value = parseJson(input, "WebSocket messages");
  if (!isRecord(value) || value.kind !== "command") {
    throw new ProtocolError("invalid_envelope", "Expected a command envelope");
  }
  if (
    isRecord(value.command) &&
    value.command.type === "set_thinking_level" &&
    !ThinkingLevelSchema.safeParse(value.command.level).success
  ) {
    throw new ProtocolError("invalid_thinking_level", "Unsupported thinking level");
  }
  const result = ClientCommandEnvelopeSchema.safeParse(value);
  if (result.success) return result.data;

  const message = firstIssue(result.error);
  const requestIdIssue = result.error.issues.some((issue) => issue.path[0] === "requestId");
  const imageIssue = result.error.issues[0]?.path.includes("images") === true;
  const code = requestIdIssue
    ? "invalid_request_id"
    : message.includes("combined size limit") || message.includes("byte size limit")
      ? "image_too_large"
      : message.includes("at most") && message.includes("images")
        ? "too_many_images"
        : imageIssue
          ? "invalid_image"
          : message.includes("byte limit")
            ? "prompt_too_large"
            : message.includes("blank")
              ? "invalid_prompt"
              : "invalid_command";
  throw new ProtocolError(code, message);
}

export function parseServerEnvelope(input: string): ServerEnvelope {
  const value = parseJson(input, "Server messages");
  const result = ServerEnvelopeSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ProtocolError(
    "invalid_server_message",
    `Invalid server message: ${firstIssue(result.error)}`,
  );
}

export function parseWorkspaceSessionsStreamEnvelope(
  input: string,
): WorkspaceSessionsStreamEnvelope {
  const value = parseJson(input, "Workspace sessions stream messages");
  const result = WorkspaceSessionsStreamEnvelopeSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ProtocolError(
    "invalid_workspace_sessions_stream_message",
    `Invalid workspace sessions stream message: ${firstIssue(result.error)}`,
  );
}
