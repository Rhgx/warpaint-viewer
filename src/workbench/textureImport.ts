import { encodeRgbaPng } from '../source/png';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_VTF_PIXELS = 16 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'vtf'];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('The image could not be decoded.'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

async function rgbaDataUrl(data: Uint8Array, width: number, height: number) {
  const png = await encodeRgbaPng(data, width, height);
  return readAsDataUrl(new File([png], 'decoded.png', { type: 'image/png' }));
}

async function decodeTga(file: File): Promise<string> {
  const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
  const parsed = new TGALoader().parse(await file.arrayBuffer());
  if (!parsed.data || !parsed.width || !parsed.height)
    throw new Error('This TGA has no readable pixel data.');
  return rgbaDataUrl(
    Uint8Array.from(parsed.data as ArrayLike<number>),
    parsed.width,
    parsed.height,
  );
}

async function decodeVtf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { decodeVtfToPng, VtfDecodeError } = await import('../source/vtfDecode');
  try {
    const decoded = await decodeVtfToPng(bytes, {
      maxPixels: MAX_VTF_PIXELS,
      limitDescription: '16 megapixel import limit',
    });
    return readAsDataUrl(
      new File([decoded.png], 'decoded.png', { type: 'image/png' }),
    );
  } catch (cause) {
    const detail =
      cause instanceof Error
        ? cause.message
        : 'The image data could not be decoded.';
    const header = cause instanceof VtfDecodeError ? cause.header : undefined;
    if (detail.startsWith('VTF dimensions '))
      throw new Error(`${file.name}: ${detail}`);
    throw new Error(
      header
        ? `${file.name}: VTF ${header.verMajor}.${header.verMinor}, format ${header.highResFormat}: ${detail}`
        : `${file.name}: ${detail}`,
    );
  }
}

export async function readTexture(file: File, alphaOnly = false) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (
    !SUPPORTED_EXTENSIONS.includes(extension) ||
    (alphaOnly && extension === 'tga')
  ) {
    throw new Error(
      alphaOnly
        ? 'Choose a PNG, JPG, or WebP alpha mask.'
        : 'Choose a PNG, JPG, WebP, TGA, or VTF texture.',
    );
  }
  if (alphaOnly && extension === 'vtf')
    throw new Error(
      'VTF textures contain their own alpha channel and cannot be used as a separate alpha mask.',
    );
  if (file.size > MAX_FILE_BYTES)
    throw new Error('Files must be 32 MB or smaller.');
  return {
    dataUrl:
      extension === 'tga'
        ? await decodeTga(file)
        : extension === 'vtf'
          ? await decodeVtf(file)
          : await readAsDataUrl(file),
    fileName: file.name,
    isTga: extension === 'tga',
    hasEmbeddedAlpha: extension === 'tga' || extension === 'vtf',
  };
}

export async function mergeAlpha(
  colorUrl: string,
  alphaUrl: string,
): Promise<string> {
  const [color, alpha] = await Promise.all([
    loadImage(colorUrl),
    loadImage(alphaUrl),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = color.naturalWidth;
  canvas.height = color.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The browser could not merge the alpha mask.');
  context.drawImage(color, 0, 0);
  const colorPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(alpha, 0, 0, canvas.width, canvas.height);
  const maskPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  let hasTransparency = false;
  for (let i = 3; i < maskPixels.data.length; i += 4) {
    if (maskPixels.data[i] < 255) {
      hasTransparency = true;
      break;
    }
  }
  for (let i = 0; i < colorPixels.data.length; i += 4) {
    colorPixels.data[i + 3] = hasTransparency
      ? maskPixels.data[i + 3]
      : Math.round(
          maskPixels.data[i] * 0.299 +
            maskPixels.data[i + 1] * 0.587 +
            maskPixels.data[i + 2] * 0.114,
        );
  }
  context.putImageData(colorPixels, 0, 0);
  return canvas.toDataURL('image/png');
}
