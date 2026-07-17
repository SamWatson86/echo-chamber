import { expect } from "@playwright/test";

export async function visibleRect(locator) {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    };
  });
}

export function intersectionArea(first, second) {
  const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  return width * height;
}

export async function expectNoOverlap(first, second, tolerance = 1) {
  const [firstRect, secondRect] = await Promise.all([visibleRect(first), visibleRect(second)]);
  expect(intersectionArea(firstRect, secondRect)).toBeLessThanOrEqual(tolerance);
}

export async function expectHorizontallyContained(child, parent, tolerance = 1) {
  const [childRect, parentRect] = await Promise.all([visibleRect(child), visibleRect(parent)]);
  expect(childRect.left).toBeGreaterThanOrEqual(parentRect.left - tolerance);
  expect(childRect.right).toBeLessThanOrEqual(parentRect.right + tolerance);
}

export async function expectMinimumUsableRegion(locator, minimums) {
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.clientWidth).toBeGreaterThanOrEqual(minimums.width || 1);
  expect(geometry.clientHeight).toBeGreaterThanOrEqual(minimums.height || 1);
  return geometry;
}

export async function expectNoDocumentOverflow(page, tolerance = 1) {
  const geometry = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + tolerance);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + tolerance);
}
