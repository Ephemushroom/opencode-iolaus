import { describe, expect, test } from "bun:test"
import { paneHeights, revealScroll } from "../src/tui/layout"

describe("DAG pane allocation", () => {
  test("short details release space for a wrapped seven-card graph", () => {
    expect(paneHeights(32, 18, 10)).toEqual({ graph: 18, detail: 10 })
    expect(paneHeights(26, 18, 10)).toEqual({ graph: 16, detail: 10 })
  })

  test("short graphs release space for long results", () => {
    expect(paneHeights(32, 5, 100)).toEqual({ graph: 5, detail: 27 })
  })

  test("both overflowing panes remain scrollable with a balanced viewport", () => {
    expect(paneHeights(31, 100, 100)).toEqual({ graph: 15, detail: 16 })
  })

  test("short content shrinks the dialog instead of leaving an empty tail", () => {
    expect(paneHeights(50, 5, 10)).toEqual({ graph: 5, detail: 10 })
  })

  test("resize and content changes redistribute the same budget", () => {
    for (const available of [2, 7, 15, 32, 60]) {
      for (const graph of [5, 18, 100]) {
        for (const detail of [10, 40, 100]) {
          const result = paneHeights(available, graph, detail)
          expect(result.graph).toBeGreaterThan(0)
          expect(result.detail).toBeGreaterThan(0)
          expect(result.graph + result.detail).toBe(Math.min(available, graph + detail))
        }
      }
    }
  })
})

describe("selected card reveal", () => {
  test("a visible card leaves the scroll position alone", () => {
    expect(revealScroll(0, 0, 5, 18)).toBe(0)
    expect(revealScroll(6, 12, 5, 18)).toBe(6)
  })

  test("a card below the viewport scrolls the minimum distance to its bottom edge", () => {
    // 160x45 QA layout: third wave row (top at 12 rows) inside a 16-row viewport.
    expect(revealScroll(0, 12, 5, 16)).toBe(1)
    expect(revealScroll(3, 20, 5, 16)).toBe(12)
  })

  test("a card above the viewport scrolls back to its top edge", () => {
    expect(revealScroll(12, -12, 5, 16)).toBe(0)
    expect(revealScroll(7, -2, 5, 16)).toBe(5)
  })

  test("a card as tall as the viewport is top-aligned instead of left where it is", () => {
    // 160x24 QA layout: the graph pane is 5 rows and so is a card. OpenTUI's scrollChildIntoView returns 0 here.
    expect(revealScroll(6, 6, 5, 5)).toBe(12)
    expect(revealScroll(0, 12, 5, 5)).toBe(12)
    expect(revealScroll(12, 0, 5, 5)).toBe(12)
    expect(revealScroll(0, 3, 8, 5)).toBe(3)
  })

  test("the reveal is a fixed point once the card is in view", () => {
    for (const viewport of [5, 6, 11, 16, 18]) {
      for (const childTop of [-20, -5, 0, 3, 7, 12, 20]) {
        for (const childHeight of [4, 5, 8]) {
          const first = revealScroll(10, childTop, childHeight, viewport)
          const moved = childTop - (first - 10)
          expect(revealScroll(first, moved, childHeight, viewport)).toBe(first)
          expect(moved).toBeGreaterThanOrEqual(0)
          if (childHeight <= viewport) expect(moved + childHeight).toBeLessThanOrEqual(viewport)
        }
      }
    }
  })
})
