import type { ReactEventHandler } from 'react';
import './WeaponUvSurface.css';

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
      className="weapon-uv-surface"
      aria-hidden={!textureAlt || undefined}
    >
      <span className="weapon-uv-surface-underlay" aria-hidden="true" />
      {textureSrc ? (
        <img
          className="weapon-uv-surface-texture"
          src={textureSrc}
          alt={textureAlt}
          draggable={false}
          onLoad={onTextureLoad}
        />
      ) : null}
      {textureSrc && isolationOverlaySrc ? (
        <img
          className="weapon-uv-surface-isolation-overlay"
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
