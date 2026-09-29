/** Share overflow space evenly, but give unused space back to the other pane. */
export function paneHeights(available: number, graphContent: number, detailContent: number) {
  const budget = Math.max(2, Math.floor(available))
  const graphNeed = Math.max(1, Math.ceil(graphContent))
  const detailNeed = Math.max(1, Math.ceil(detailContent))
  const graph = Math.min(graphNeed, Math.max(Math.floor(budget / 2), budget - detailNeed))
  const detail = Math.min(detailNeed, budget - graph)
  return { graph, detail }
}

/**
 * Scroll offset that brings a child into a viewport. `childTop` is the child's top edge relative to the viewport's
 * top edge at the current `scrollTop`. A child that fits is revealed whole by the nearest edge; a child at least as
 * tall as the viewport is aligned to the top so its heading stays readable. OpenTUI's scrollChildIntoView leaves a
 * child exactly as tall as the viewport where it is, so the offset is computed here.
 */
export function revealScroll(scrollTop: number, childTop: number, childHeight: number, viewportHeight: number) {
  if (childTop < 0 || childHeight >= viewportHeight) return scrollTop + childTop
  const overflow = childTop + childHeight - viewportHeight
  return overflow > 0 ? scrollTop + overflow : scrollTop
}
