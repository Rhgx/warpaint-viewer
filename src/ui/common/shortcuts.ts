export function shortcutTargetsEditableContent(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : document.activeElement;
  return element instanceof Element && Boolean(element.closest(
    'input, textarea, select, [contenteditable], [role="textbox"]',
  ));
}
