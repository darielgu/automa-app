import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { HashRouter } from "react-router-dom";
import { App } from "./app.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import "./ui/styles.css";
import "./styles.css";

// Dropping a file anywhere on the window makes Chromium navigate to it, which
// blanks the app. The resume drop target handles its own events; everything
// else must be refused.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => event.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/*
      reducedMotion="user" makes framer honour the OS setting for every
      motion component at once, dropping transform animations and keeping
      opacity ones. CSS transitions are handled separately in ui/styles.css.
    */}
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </TooltipProvider>
    </MotionConfig>
  </React.StrictMode>
);
