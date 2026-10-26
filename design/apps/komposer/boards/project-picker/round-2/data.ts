// Made-up example data shared by the round 2 options: projects, workflows,
// workstreams, and design boards with the workflow that produced them.

import type { State } from "../../../shared/Icon.tsx";

export const PROJECTS = ["acme-storefront", "garden-planner", "tidepool-api", "recipe-box"];
export const WORKFLOWS = ["feature-development", "bug-fix", "design-exploration", "system-development"];

export type Workstream = { slug: string; project: string; workflow: string; state: State; step: string; when: string };

export const WORKSTREAMS: Workstream[] = [
  { slug: "checkout-gift-cards", project: "acme-storefront", workflow: "feature-development", state: "waiting", step: "Review the design", when: "12 min ago" },
  { slug: "search-autocomplete", project: "acme-storefront", workflow: "feature-development", state: "running", step: "Implement", when: "3 min ago" },
  { slug: "wishlist-sharing", project: "acme-storefront", workflow: "feature-development", state: "done", step: "Merged", when: "3 days ago" },
  { slug: "cart-badge-overflow", project: "acme-storefront", workflow: "bug-fix", state: "running", step: "Reproduce", when: "40 min ago" },
  { slug: "product-page-layout", project: "acme-storefront", workflow: "design-exploration", state: "done", step: "Round 2 chosen", when: "yesterday" },
  { slug: "planting-calendar", project: "garden-planner", workflow: "feature-development", state: "blocked", step: "Implement", when: "2 hours ago" },
  { slug: "frost-alerts", project: "garden-planner", workflow: "system-development", state: "running", step: "Design the system", when: "20 min ago" },
  { slug: "seed-list-sorting", project: "garden-planner", workflow: "bug-fix", state: "done", step: "Merged", when: "4 days ago" },
  { slug: "rate-limits", project: "tidepool-api", workflow: "feature-development", state: "waiting", step: "Approve the plan", when: "1 hour ago" },
  { slug: "timezone-drift", project: "tidepool-api", workflow: "bug-fix", state: "waiting", step: "Confirm the fix", when: "5 min ago" },
  { slug: "ingest-pipeline", project: "tidepool-api", workflow: "system-development", state: "done", step: "Completed", when: "last week" },
];

// A board made by hand, outside any workflow, has no workflow recorded.
export type DesignBoard = { feature: string; project: string; workflow: string | null; rounds: number; open: number };

export const BOARDS: DesignBoard[] = [
  { feature: "product-page-layout", project: "acme-storefront", workflow: "design-exploration", rounds: 2, open: 0 },
  { feature: "checkout-flow", project: "acme-storefront", workflow: "feature-development", rounds: 1, open: 3 },
  { feature: "empty-cart", project: "acme-storefront", workflow: null, rounds: 1, open: 0 },
  { feature: "planting-calendar", project: "garden-planner", workflow: "feature-development", rounds: 3, open: 1 },
  { feature: "onboarding", project: "recipe-box", workflow: "design-exploration", rounds: 1, open: 2 },
];

export const count = (rows: { project: string; workflow: string | null }[], project: string | null, workflow: string | null) =>
  rows.filter((r) => (!project || r.project === project) && (!workflow || r.workflow === workflow)).length;
