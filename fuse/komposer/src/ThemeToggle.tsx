// SPDX-License-Identifier: Apache-2.0
// The theme button: a moon and "Dark" in the light theme, a sun and "Light"
// in the dark theme.

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme.ts";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button className="theme-toggle" title={`Switch to the ${dark ? "light" : "dark"} theme`} onClick={toggle}>
      {dark ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
      {dark ? "Light" : "Dark"}
    </button>
  );
}
