// SPDX-License-Identifier: Apache-2.0
// Edge layout for the diagram: consumes buses (left gutter) and route-back
// lines (right gutter), with greedy lane assignment.

import type { StepView } from "./workflowView.ts";

export interface Bus {
  artifact: string;
  producerIndex: number;
  consumerIndices: number[];
  lastConsumerIndex: number;
  lane: number;
}

export interface RouteBack {
  fromIndex: number; // the gate's step
  toIndex: number; // the target step
  from: string;
  to: string;
  lane: number;
}

export interface Layout {
  buses: Bus[];
  routes: RouteBack[];
  leftLanes: number;
  rightLanes: number;
}

export function layoutEdges(steps: StepView[]): Layout {
  // A consumer reads the artifact from the nearest earlier step that lists
  // it in produces, optional_produces or updates, or returns it from its
  // child through a workflow gate, as fuse-flow finds the document a step
  // reads. One bus per writer of an artifact that a later step reads from it.
  const writes = (step: StepView, id: string) =>
    step.artifacts.some((a) => a.artifact === id) ||
    step.gates.some((g) => g.kind === "workflow" && Object.hasOwn(g.returns ?? {}, id));
  const byWriter = new Map<string, Bus>();
  steps.forEach((step, j) => {
    for (const artifact of step.consumes) {
      let producerIndex = j - 1;
      while (producerIndex >= 0 && !writes(steps[producerIndex], artifact)) producerIndex--;
      if (producerIndex < 0) continue;
      const key = `${producerIndex}:${artifact}`;
      const bus = byWriter.get(key) ?? { artifact, producerIndex, consumerIndices: [], lastConsumerIndex: j, lane: 0 };
      if (!bus.consumerIndices.includes(j)) bus.consumerIndices.push(j);
      bus.lastConsumerIndex = Math.max(bus.lastConsumerIndex, j);
      byWriter.set(key, bus);
    }
  });
  const buses = [...byWriter.values()];
  buses.sort((a, b) => a.producerIndex - b.producerIndex || a.lastConsumerIndex - b.lastConsumerIndex);
  const laneEnd: number[] = [];
  for (const bus of buses) {
    let lane = 0;
    while (laneEnd[lane] !== undefined && laneEnd[lane] > bus.producerIndex) lane++;
    bus.lane = lane;
    laneEnd[lane] = bus.lastConsumerIndex;
  }

  const routes: RouteBack[] = [];
  steps.forEach((step, i) => {
    for (const gate of step.gates) {
      for (const target of gate.route_back_to) {
        const j = steps.findIndex((s) => s.id === target);
        if (j >= 0 && j <= i) routes.push({ fromIndex: i, toIndex: j, from: step.id, to: target, lane: 0 });
      }
    }
  });
  routes.sort((a, b) => a.fromIndex - a.toIndex - (b.fromIndex - b.toIndex));
  const placed: RouteBack[] = [];
  for (const route of routes) {
    let lane = 0;
    while (placed.some((p) => p.lane === lane && !(p.fromIndex < route.toIndex || p.toIndex > route.fromIndex))) lane++;
    route.lane = lane;
    placed.push(route);
  }

  return {
    buses,
    routes,
    leftLanes: laneEnd.length,
    rightLanes: routes.length ? Math.max(...routes.map((r) => r.lane)) + 1 : 0,
  };
}

// A bus is highlighted while its artifact is hovered, or while its producer
// or one of its consumers is the selected step.
export function busHighlighted(bus: Bus, hoveredArtifact: string | null, selectedIndex: number): boolean {
  return (
    hoveredArtifact === bus.artifact || bus.producerIndex === selectedIndex || bus.consumerIndices.includes(selectedIndex)
  );
}

// The buses the diagram draws, each with whether it is highlighted. With
// onlyHovered, as on the edit page, only the hovered artifact's buses are
// drawn, highlighted, and a selection reveals none. Otherwise, as on
// Present, every bus is drawn and the highlight follows busHighlighted.
export function drawnBuses(
  layout: Layout,
  { hoveredArtifact, selectedIndex, onlyHovered }: { hoveredArtifact: string | null; selectedIndex: number; onlyHovered: boolean },
): { bus: Bus; highlighted: boolean }[] {
  if (onlyHovered) return layout.buses.filter((bus) => bus.artifact === hoveredArtifact).map((bus) => ({ bus, highlighted: true }));
  return layout.buses.map((bus) => ({ bus, highlighted: busHighlighted(bus, hoveredArtifact, selectedIndex) }));
}

// Sequence edges: between consecutive steps whose predecessor's artifacts
// are not already drawn as a labeled bus (every step draws a plain
// sequence arrow from the step before it; this is in addition to buses).
export function hasAnyEdges(layout: Layout): boolean {
  return layout.buses.length > 0 || layout.routes.length > 0;
}
