import type { ReactEventHandler } from 'react';
import './WeaponUvSurface.css';

export interface WeaponUvSurfaceProps {
  readonly textureSrc?: string | null;
  readonly className?: string;
  readonly textureAlt?: string;
  readonly onTextureLoad?: ReactEventHandler<HTMLImageElement>;
}

/**
 * Shared visual foundation for flat weapon-texture editors. Interaction layers
 * stay with their owning editor while the composed texture presentation stays
 * consistent between editor surfaces.
 */
export function WeaponUvSurface({
  textureSrc,
  className,
  textureAlt = '',
  onTextureLoad,
}: WeaponUvSurfaceProps) {
  return (
    <div
      className={`weapon-uv-surface${className ? ` ${className}` : ''}`}
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
    </div>
  );
}
