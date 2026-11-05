/** Apart from the code that reads these files, so that the viewer can recognize one without loading the board. */
export const LAYOUT_FILE_EXTENSION = '.pegboard';

export const isLayoutFileName = (name: string) => name.toLowerCase().endsWith(LAYOUT_FILE_EXTENSION);
