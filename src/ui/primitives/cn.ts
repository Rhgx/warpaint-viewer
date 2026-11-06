import { type CxOptions, cx } from 'class-variance-authority';
import { extendTailwindMerge } from 'tailwind-merge';

// What @theme adds. Unregistered, tailwind-merge misses that h-auto replaces h-control, or reads text-11 as a colour.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['8.5', '9', '9.5', '10', '10.5', '11', '11.5', '12', '13', '14', '15', '16'],
      spacing: ['control'],
      shadow: ['pop'],
    },
  },
});

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}
