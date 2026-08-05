import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type { SlashCommandSummary } from "../shared/protocol.js";

function commandQuery(value: string): string | undefined {
  if (!value.startsWith("/") || /[\s\n]/.test(value)) return undefined;
  return value.slice(1);
}

interface SlashCommandsOptions {
  draft: string;
  commands: SlashCommandSummary[];
  select: (command: SlashCommandSummary) => void;
}

export function useSlashCommands({ draft, commands, select }: SlashCommandsOptions) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = commandQuery(draft);
  const matches = useMemo(() => {
    if (query === undefined || dismissed) return [];
    const normalized = query.toLowerCase();
    return commands
      .filter(
        (command) =>
          command.name.toLowerCase().includes(normalized) ||
          command.description?.toLowerCase().includes(normalized),
      )
      .slice(0, 8);
  }, [commands, dismissed, query]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  const choose = (command: SlashCommandSummary) => {
    select(command);
    setSelectedIndex(0);
    setDismissed(true);
  };

  const reset = () => {
    setDismissed(false);
    setSelectedIndex(0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (matches.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        return (current + direction + matches.length) % matches.length;
      });
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    const exactCommand = commands.some((command) => draft === `/${command.name}`);
    const shouldComplete =
      event.key === "Tab" ||
      (event.key === "Enter" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !exactCommand);
    const command = shouldComplete ? matches[selectedIndex] : undefined;
    if (!command) return false;
    event.preventDefault();
    choose(command);
    return true;
  };

  return { matches, selectedIndex, choose, reset, handleKeyDown };
}
