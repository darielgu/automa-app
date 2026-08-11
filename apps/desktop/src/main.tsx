import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./app.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import "./ui/styles.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </TooltipProvider>
  </React.StrictMode>
);
