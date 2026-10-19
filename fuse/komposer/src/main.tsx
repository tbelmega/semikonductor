// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./tokens/fonts.css";
import "./tokens/colors.css";
import "./tokens/typography.css";
import "./tokens/spacing.css";
import "./tokens/effects.css";
import "./tokens/base.css";
import "./styles.css";
import { App } from "./App.tsx";
import { TooltipLayer } from "./Tooltip.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipLayer>
      <App />
    </TooltipLayer>
  </StrictMode>,
);
