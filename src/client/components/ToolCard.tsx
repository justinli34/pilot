import { ChevronRight } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { JsonValue, ToolExecution } from "../../shared/protocol.js";

interface ToolCardProps {
  tool: ToolExecution;
}

function argObject(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function summary(tool: ToolExecution): string {
  const args = argObject(tool.arguments);
  const candidate = args?.command ?? args?.path ?? args?.query ?? args?.pattern;
  if (typeof candidate === "string") return candidate.replace(/\s+/g, " ");
  const keys = args ? Object.keys(args) : [];
  return keys.length > 0 ? keys.slice(0, 3).join(", ") : "";
}

function statusLabel(tool: ToolExecution): string {
  return tool.status.charAt(0).toUpperCase() + tool.status.slice(1);
}

export const ToolCard = memo(function ToolCard({ tool }: ToolCardProps) {
  const [expanded, setExpanded] = useState(tool.status === "running");
  const previousStatus = useRef(tool.status);

  useEffect(() => {
    if (previousStatus.current === "running" && tool.status !== "running") setExpanded(false);
    previousStatus.current = tool.status;
  }, [tool.status]);

  const label = summary(tool);
  return (
    <div className={`tool-row tool-${tool.status}`}>
      <button
        className="tool-header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight className={expanded ? "chevron expanded" : "chevron"} size={14} />
        <span className="tool-name">{tool.name}</span>
        {label && (
          <span className="tool-summary" title={label}>
            {label}
          </span>
        )}
        {(tool.status === "running" || tool.status === "aborted") && (
          <span className={`tool-status tool-status-${tool.status}`}>{statusLabel(tool)}</span>
        )}
      </button>
      {expanded && (
        <div className="tool-details">
          <div className="tool-section">
            <span className="tool-section-label">Arguments</span>
            <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
          </div>
          {tool.patch && (
            <div className="tool-section">
              <span className="tool-section-label">Unified patch</span>
              <pre className="patch-output">
                <code className="language-diff">{tool.patch}</code>
              </pre>
            </div>
          )}
          {(tool.output || tool.error) && (
            <div className="tool-section">
              <span className="tool-section-label">
                {tool.error ? "Error" : tool.status === "running" ? "Live output" : "Output"}
              </span>
              <pre className={tool.error ? "tool-error-output" : ""}>
                {tool.error || tool.output}
              </pre>
            </div>
          )}
          {!tool.output && !tool.error && !tool.patch && (
            <div className="tool-empty-output">
              {tool.status === "running" ? "Waiting for output…" : "No text output"}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
