import {
  ArrowUp,
  Clock3,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Link,
  LoaderCircle,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { DirectoryListing } from "../../shared/protocol.js";
import { browseDirectories } from "../api.js";
import { ModalDialog } from "./ModalDialog.js";

const RECENT_PROJECT_PATHS_KEY = "pilot.recentProjectPaths";

interface ProjectBrowserDialogProps {
  adding: boolean;
  error?: string;
  onClose: () => void;
  onAdd: (path: string) => Promise<void>;
}

function recentPaths(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_PROJECT_PATHS_KEY) ?? "[]");
    return Array.isArray(value) && value.every((path) => typeof path === "string")
      ? value.slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

export function rememberProjectPath(path: string): void {
  localStorage.setItem(
    RECENT_PROJECT_PATHS_KEY,
    JSON.stringify([path, ...recentPaths().filter((candidate) => candidate !== path)].slice(0, 6)),
  );
}

function breadcrumbs(listing: DirectoryListing): Array<{ label: string; path: string }> {
  const separator = listing.root.includes("\\") ? "\\" : "/";
  const remainder = listing.path.slice(listing.root.length);
  const parts = remainder.split(/[\\/]/).filter(Boolean);
  const result = [{ label: listing.root, path: listing.root }];
  let current = listing.root;
  for (const part of parts) {
    current = `${current}${current.endsWith(separator) ? "" : separator}${part}`;
    result.push({ label: part, path: current });
  }
  return result;
}

export function ProjectBrowserDialog({ adding, error, onClose, onAdd }: ProjectBrowserDialogProps) {
  const [listing, setListing] = useState<DirectoryListing>();
  const [pathInput, setPathInput] = useState("");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string>();
  const [pathError, setPathError] = useState<string>();
  const [pathSubmitting, setPathSubmitting] = useState(false);
  const [recents] = useState(recentPaths);
  const navigation = useRef<AbortController | undefined>(undefined);

  const open = async (path?: string) => {
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    setLoading(true);
    setBrowseError(undefined);
    setPathError(undefined);
    try {
      const result = await browseDirectories(path, controller.signal);
      if (controller.signal.aborted) return;
      setListing(result);
      setPathInput(result.path);
      setSelectedPath(result.path);
      setFilter("");
    } catch (browseFailure) {
      if (!controller.signal.aborted) {
        setBrowseError(
          browseFailure instanceof Error ? browseFailure.message : "Could not open this folder",
        );
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    void open();
    return () => navigation.current?.abort();
  }, []);

  const visibleDirectories = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return (listing?.directories ?? []).filter(
      (directory) =>
        (showHidden || !directory.hidden) &&
        (query.length === 0 || directory.name.toLocaleLowerCase().includes(query)),
    );
  }, [filter, listing, showHidden]);

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    const path = pathInput.trim();
    if (!path) {
      setPathError("Enter an absolute server path.");
      return;
    }
    setPathSubmitting(true);
    void open(path).finally(() => setPathSubmitting(false));
  };

  return (
    <ModalDialog
      backdropClassName="project-browser-backdrop"
      dialogClassName="project-browser-dialog"
      labelledBy="project-browser-title"
      closeDisabled={adding}
      onClose={onClose}
    >
      <header className="project-browser-header">
        <span className="project-browser-mark" aria-hidden="true">
          <FolderOpen size={17} />
        </span>
        <h2 id="project-browser-title">Add project</h2>
        <button
          type="button"
          aria-label="Close folder browser"
          title="Close"
          disabled={adding}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>

      <form className="project-path-form" onSubmit={submitPath}>
        <label htmlFor="project-path-input">Server path</label>
        <div className="project-path-field">
          <div className="project-path-controls">
            <input
              id="project-path-input"
              name="projectPath"
              value={pathInput}
              placeholder="/home/you/project…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={pathError ? true : undefined}
              aria-describedby={pathError ? "project-path-error" : undefined}
              disabled={adding}
              onChange={(event) => {
                setPathInput(event.target.value);
                if (pathError) setPathError(undefined);
              }}
            />
            <button type="submit" disabled={adding || pathSubmitting} aria-busy={pathSubmitting}>
              {pathSubmitting && <LoaderCircle className="spin" aria-hidden="true" size={13} />}
              Go
            </button>
          </div>
          {pathError && (
            <span id="project-path-error" className="project-path-error" role="alert">
              {pathError}
            </span>
          )}
        </div>
      </form>

      <div className="project-browser-body">
        <aside className="project-browser-places" aria-label="Quick access">
          <div className="project-browser-places-heading">Quick access</div>
          <button
            type="button"
            disabled={!listing || adding}
            onClick={() => void open(listing?.home)}
          >
            <Home size={15} /> Home
          </button>
          <button
            type="button"
            disabled={!listing || adding}
            onClick={() => void open(listing?.root)}
          >
            <HardDrive size={15} /> Filesystem
          </button>
          {recents.length > 0 && (
            <div className="project-browser-places-heading recent">Recent</div>
          )}
          {recents.map((path) => (
            <button
              type="button"
              title={path}
              key={path}
              disabled={adding}
              onClick={() => void open(path)}
            >
              <Clock3 size={14} /> <span>{path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}</span>
            </button>
          ))}
        </aside>

        <section className="project-browser-main">
          <div className="project-browser-toolbar">
            <div className="project-breadcrumbs" aria-label="Current folder">
              {listing &&
                breadcrumbs(listing).map((crumb) => (
                  <button
                    type="button"
                    key={crumb.path}
                    title={crumb.path}
                    disabled={adding}
                    onClick={() => void open(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                ))}
            </div>
            <button
              className="show-hidden-button"
              type="button"
              aria-pressed={showHidden}
              title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
              onClick={() => setShowHidden((visible) => !visible)}
            >
              {showHidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div className="project-folder-filter">
            <input
              value={filter}
              type="search"
              name="folderFilter"
              placeholder="Filter folders…"
              aria-label="Filter folders"
              autoComplete="off"
              disabled={!listing || adding}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="project-folder-list" role="group" aria-label="Server folders">
            {loading && (
              <div className="project-browser-state" role="status">
                <LoaderCircle className="spin" aria-hidden="true" size={17} /> Loading folders…
              </div>
            )}
            {!loading && browseError && (
              <div className="project-browser-state error" role="alert">
                {browseError}
              </div>
            )}
            {!loading && !browseError && listing?.parent && (
              <button
                className="project-folder-row parent"
                type="button"
                aria-label="Parent folder"
                aria-pressed={selectedPath === listing.parent}
                onDoubleClick={() => void open(listing.parent)}
                onClick={() => setSelectedPath(listing.parent)}
              >
                <ArrowUp size={16} /> <span>..</span>
              </button>
            )}
            {!loading &&
              !browseError &&
              visibleDirectories.map((directory) => (
                <button
                  className={`project-folder-row${selectedPath === directory.path ? " selected" : ""}`}
                  type="button"
                  aria-pressed={selectedPath === directory.path}
                  title={directory.path}
                  key={directory.path}
                  onClick={() => setSelectedPath(directory.path)}
                  onDoubleClick={() => void open(directory.path)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void open(directory.path);
                    }
                  }}
                >
                  <Folder size={16} />
                  <span>{directory.name}</span>
                  {directory.symlink && <Link size={13} aria-label="Symbolic link" />}
                </button>
              ))}
            {!loading && !browseError && visibleDirectories.length === 0 && (
              <div className="project-browser-state">No matching folders</div>
            )}
          </div>
        </section>
      </div>

      <footer className="project-browser-footer">
        <div className="project-browser-selection">
          <span>Selected</span>
          <strong title={selectedPath}>{selectedPath ?? "Choose a folder"}</strong>
        </div>
        {error && (
          <div className="project-browser-error" role="alert">
            {error}
          </div>
        )}
        <div className="project-browser-actions">
          <button type="button" disabled={adding} onClick={onClose}>
            Cancel
          </button>
          <button
            className="add-project-confirm"
            type="button"
            disabled={!selectedPath || adding}
            aria-busy={adding}
            onClick={() => {
              if (selectedPath) void onAdd(selectedPath).catch(() => undefined);
            }}
          >
            {adding && <LoaderCircle className="spin" aria-hidden="true" size={14} />}
            Add project
          </button>
        </div>
      </footer>
    </ModalDialog>
  );
}
