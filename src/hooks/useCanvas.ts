import { useState, useEffect } from 'react';

interface ElementInfo {
  tagName: string;
  x: number;
  y: number;
  w: number;
  h: number;
  html: string;
}

export function useCanvas() {
  const [isCanvasEnabled, setIsCanvasEnabled] = useState(false);
  const [elementsInfo, setElementsInfo] = useState<ElementInfo[]>([]);

  useEffect(() => {
    const toggleCanvas = async () => {
      if (!isCanvasEnabled) {
        const info = await gatherElementsInfo();
        setElementsInfo(info);
        setIsCanvasEnabled(true);
        document.body.classList.add('canvas-mode');
      } else {
        setElementsInfo([]);
        setIsCanvasEnabled(false);
        document.body.classList.remove('canvas-mode');
      }
    };

    window.addEventListener('toggleCanvasEvent', toggleCanvas);

    return () => {
      window.removeEventListener('toggleCanvasEvent', toggleCanvas);
    };
  }, [isCanvasEnabled]);

  return { isCanvasEnabled, elementsInfo };
}

async function gatherElementsInfo() {
  const rootElement = document.getElementsByTagName('main')[0];
  const info: any[] = [];
  if (rootElement) {
    for (const child of rootElement.children) {
      if (['BUTTON'].includes(child.tagName)) continue;
      const rect = child.getBoundingClientRect();
      let w = rect.width;
      if (!['P', 'UL', 'OL'].includes(child.tagName)) {
        w = measureElementTextWidth(child as HTMLElement);
      }
      // Check if the element is centered
      const computedStyle = window.getComputedStyle(child);
      let x = rect.left; // Default x position
      if (computedStyle.display === 'block' && computedStyle.textAlign === 'center') {
        // Adjust x position for centered elements
        const parentWidth = child.parentElement ? child.parentElement.getBoundingClientRect().width : 0;
        x = (parentWidth - w) / 2 + window.scrollX + (child.parentElement ? child.parentElement.getBoundingClientRect().left : 0);
      }

      info.push({
        tagName: child.tagName,
        x: x,
        y: rect.top,
        w: w,
        h: rect.height,
        html: child.outerHTML
      });
    };
  }
  return info;
}

function measureElementTextWidth(element: HTMLElement) {
  // Create a temporary span element
  const tempElement = document.createElement('span');
  // Get the text content from the passed element
  tempElement.textContent = element.textContent || element.innerText;
  // Get the computed style of the passed element
  const computedStyle = window.getComputedStyle(element);
  // Apply relevant styles to the temporary element
  tempElement.style.font = computedStyle.font;
  tempElement.style.fontWeight = computedStyle.fontWeight;
  tempElement.style.fontSize = computedStyle.fontSize;
  tempElement.style.fontFamily = computedStyle.fontFamily;
  tempElement.style.letterSpacing = computedStyle.letterSpacing;
  // Ensure the temporary element is not visible in the viewport
  tempElement.style.position = 'absolute';
  tempElement.style.visibility = 'hidden';
  tempElement.style.whiteSpace = 'nowrap'; // Prevent text from wrapping
  // Append to the body to make measurements possible
  document.body.appendChild(tempElement);
  // Measure the width
  const width = tempElement.getBoundingClientRect().width;
  // Remove the temporary element from the document
  document.body.removeChild(tempElement);
  // Return the measured width
  return width === 0 ? 10 : width;
}