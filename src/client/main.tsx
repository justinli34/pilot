import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/sidebar.css";
import "./styles/main-view.css";
import "./styles/transcript.css";
import "./styles/composer.css";
import "./styles/motion.css";
import "./styles/responsive.css";
import "./styles/reduced-motion.css";

const root = document.getElementById("root");
if (!root) throw new Error("Pilot root element is missing");

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
