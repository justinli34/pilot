import { useCallback, useEffect, useState } from "react";

import { readCssFlag, readCssPixelToken } from "./design-system.js";

const SIDEBAR_COLLAPSED_KEY = "pilot.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "pilot.sidebarWidth";

interface SidebarWidthMetrics {
  min: number;
  default: number;
  max: number;
  step: number;
}

function readSidebarWidthMetrics(): SidebarWidthMetrics {
  return {
    min: readCssPixelToken("--sidebar-width-min"),
    default: readCssPixelToken("--sidebar-width-default"),
    max: readCssPixelToken("--sidebar-width-max"),
    step: readCssPixelToken("--sidebar-resize-step"),
  };
}

function clampSidebarWidth(width: number, metrics: SidebarWidthMetrics): number {
  return Math.min(metrics.max, Math.max(metrics.min, Math.round(width)));
}

function initialSidebarWidth(metrics: SidebarWidthMetrics): number {
  const storedValue = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (storedValue === null) return metrics.default;
  const stored = Number(storedValue);
  return Number.isFinite(stored) ? clampSidebarWidth(stored, metrics) : metrics.default;
}

function isMobileViewport(): boolean {
  return readCssFlag("--is-mobile-viewport");
}

export function useSidebarLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
  );
  const [widthMetrics] = useState(readSidebarWidthMetrics);
  const [width, setWidth] = useState(() => initialSidebarWidth(widthMetrics));
  const [mobileViewport, setMobileViewport] = useState(isMobileViewport);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    const updateViewport = () => setMobileViewport(isMobileViewport());
    updateViewport();
    window.addEventListener("resize", updateViewport, { passive: true });
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileViewport) setMobileSidebarOpen(false);
  }, [mobileViewport]);

  useEffect(() => {
    if (!mobileViewport || !mobileSidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebarOpen, mobileViewport]);

  const toggle = useCallback(() => {
    if (mobileViewport) {
      setMobileSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, [mobileViewport]);

  const resize = useCallback(
    (nextWidth: number) => setWidth(clampSidebarWidth(nextWidth, widthMetrics)),
    [widthMetrics],
  );

  const commitWidth = useCallback(
    (nextWidth: number) => {
      const next = clampSidebarWidth(nextWidth, widthMetrics);
      setWidth(next);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    },
    [widthMetrics],
  );

  const closeMobile = useCallback(() => setMobileSidebarOpen(false), []);

  return {
    sidebarCollapsed,
    width,
    widthMetrics,
    mobileViewport,
    mobileSidebarOpen,
    effectiveCollapsed: mobileViewport ? !mobileSidebarOpen : sidebarCollapsed,
    contentCollapsed: mobileViewport ? false : sidebarCollapsed,
    toggle,
    resize,
    commitWidth,
    closeMobile,
  };
}
