import type { ReactEventHandler } from 'react';
import { cn } from '../primitives/cn';

const IMAGE = 'absolute inset-0 block size-full object-contain select-none';

interface WeaponUvSurfaceProps {
  readonly textureSrc?: string | null;
  readonly isolationOverlaySrc?: string | null;
  readonly textureAlt?: string;
  readonly onTextureLoad?: ReactEventHandler<HTMLImageElement>;
}

/** Shared visual base for flat weapon-texture editors; interaction layers stay with their owning editor. */
export function WeaponUvSurface({
  textureSrc,
  isolationOverlaySrc,
  textureAlt = '',
  onTextureLoad,
}: WeaponUvSurfaceProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden={!textureAlt || undefined}
    >
      <span className="checker-cells absolute inset-0 z-0 bg-uv-backing" aria-hidden="true" />
      {textureSrc ? (
        <img
          className={cn(IMAGE, 'z-1 bg-uv-backing')}
          src={textureSrc}
          alt={textureAlt}
          draggable={false}
          onLoad={onTextureLoad}
        />
      ) : null}
      {textureSrc && isolationOverlaySrc ? (
        <img
          className={cn(IMAGE, 'z-2 brightness-46 contrast-82 grayscale mask-contain mask-center mask-no-repeat')}
          src={textureSrc}
          alt=""
          draggable={false}
          style={{
            maskImage: `url(${JSON.stringify(isolationOverlaySrc)})`,
            WebkitMaskImage: `url(${JSON.stringify(isolationOverlaySrc)})`,
          }}
        />
      ) : null}
    </div>
  );
}
