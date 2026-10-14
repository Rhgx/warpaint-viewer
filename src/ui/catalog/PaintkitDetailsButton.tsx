import { Fragment } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Copy, Info } from 'lucide-react';
import type { PaintkitEntry, TextureDirectory, TextureDirectoryEntry } from '../../data/types';
import { isCustomKitId } from '../../protodefs/types';
import { useCopyText } from '../../hooks/useCopyText';
import './PaintkitDetailsButton.css';

// Pyxell's base names carry footnote asterisks and sometimes drop accents
// ("Pina Polished" for Piña Polished). Names that match no stock paint, such
// as "Original", stay plain text.
const foldName = (name: string) => name.replace(/\*+$/, '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function findBaseKit(paintkits: readonly PaintkitEntry[], baseName: string) {
  const folded = foldName(baseName);
  return paintkits.find((kit) => !isCustomKitId(kit.id) && foldName(kit.name) === folded);
}

// 'TL_3 & TL_4 - "patterns/a" & "patterns/b"*' -> slot label, quoted paths,
// and anything after the last path (the page's footnote asterisks). Lines that
// do not have this shape are shown as written.
function splitTextureLine(line: string) {
  const split = line.indexOf(' - ');
  if (split < 0) return null;
  const rest = line.slice(split + 3);
  const paths = [...rest.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (!paths.length) return null;
  return { slot: line.slice(0, split), paths, suffix: rest.slice(rest.lastIndexOf('"') + 1).trim() };
}

function CopyButton({ text, title, className, children }: {
  text: string;
  title: string;
  className: string;
  children: React.ReactNode;
}) {
  const { notice, copy } = useCopyText();
  return (
    <button type="button" className={`paintkit-details-copy ${className}`} title={title} onClick={() => void copy(text)}>
      {children}
      {notice && <span className="paintkit-details-copied">{notice}</span>}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="paintkit-details-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function DirectoryEntry({ entry, directory }: { entry: TextureDirectoryEntry; directory: TextureDirectory }) {
  const textures = entry.textures.map((line) => ({ line, parsed: splitTextureLine(line) }));
  // Two-letter terms (TL, IL, SL, ML) name texture slots; the legend lists the
  // ones this entry uses. Longer terms name features and become tooltips.
  const slotTerms = directory.legend.filter((item) => item.term.length <= 2
    && textures.some(({ parsed }) => parsed?.slot.includes(`${item.term}_`)));
  const featureTerms = directory.legend.filter((item) => item.term.length > 2);
  const featureTitle = (feature: string) => featureTerms
    .find((item) => feature.toLowerCase().includes(item.term.toLowerCase()))?.description;

  return (
    <>
      <Section title="Textures">
        <dl className="paintkit-details-textures">
          {textures.map(({ line, parsed }, i) => parsed ? (
            <div key={i}>
              <dt>{parsed.slot}</dt>
              <dd>
                {parsed.paths.map((path, j) => (
                  <CopyButton key={j} text={path} title="Copy path" className="paintkit-details-path">
                    {path}
                    {j === parsed.paths.length - 1 && parsed.suffix && (
                      <span className="paintkit-details-suffix">{parsed.suffix}</span>
                    )}
                  </CopyButton>
                ))}
              </dd>
            </div>
          ) : (
            <div key={i}><dd>{line}</dd></div>
          ))}
        </dl>
      </Section>

      {entry.features && (
        <Section title="Features">
          <ul>
            {entry.features.map((line, i) => {
              const title = featureTitle(line);
              return <li key={i} title={title} data-explained={title ? '' : undefined}>{line}</li>;
            })}
          </ul>
        </Section>
      )}

      {entry.notes && (
        <Section title="Notes">
          <ul>{entry.notes.map((line, i) => <li key={i}>{line}</li>)}</ul>
        </Section>
      )}

      <footer className="paintkit-details-footer">
        {slotTerms.length > 0 && (
          <dl className="paintkit-details-legend">
            {slotTerms.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.description}</dd>
              </div>
            ))}
          </dl>
        )}
        <p>
          From <a href={directory.source} target="_blank" rel="noreferrer">Pyxell's TF2 Warpaint Texture Directory</a>,
          retrieved {directory.retrievedAt}.
        </p>
      </footer>
    </>
  );
}

// Info button plus the card it opens: the paint kit ID and, when Pyxell's
// texture directory covers the paint, its entry. Opens on hover for mouse
// users and on click for touch.
export function PaintkitDetailsButton({
  defindex,
  kitName,
  entry,
  directory,
  paintkits,
  onSelectKit,
  side,
  className,
  onOpenChange,
}: {
  defindex: number;
  kitName: string;
  entry: TextureDirectoryEntry | undefined;
  directory: TextureDirectory | null;
  paintkits: readonly PaintkitEntry[];
  onSelectKit: (id: number) => void;
  side: 'right' | 'bottom';
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover.Root onOpenChange={onOpenChange}>
      <Popover.Trigger
        openOnHover
        delay={200}
        className={`paintkit-details-trigger${className ? ` ${className}` : ''}`}
        aria-label={`Details for ${kitName}`}
      >
        <Info size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="start" sideOffset={8} collisionPadding={10} className="paintkit-details-positioner">
          <Popover.Popup className="paintkit-details-popup" data-camera-input-suspended="">
            <header className="paintkit-details-header">
              <div className="paintkit-details-heading">
                <Popover.Title className="paintkit-details-title">{kitName}</Popover.Title>
                {/* The paintkit_proto_def_index that VScript and popfiles take. */}
                <CopyButton text={String(defindex)} title="Copy paintkit_proto_def_index" className="paintkit-details-id">
                  #{defindex}<Copy size={11} aria-hidden="true" />
                </CopyButton>
              </div>
              {entry?.base && (
                <p className="paintkit-details-base">
                  Base:{' '}
                  {entry.base.map((name, i) => {
                    const kit = findBaseKit(paintkits, name);
                    return (
                      <Fragment key={i}>
                        {i > 0 && ', '}
                        {kit ? (
                          <Popover.Close className="paintkit-details-base-link" onClick={() => onSelectKit(kit.id)}>
                            {name}
                          </Popover.Close>
                        ) : name}
                      </Fragment>
                    );
                  })}
                </p>
              )}
            </header>
            {entry && directory
              ? <DirectoryEntry entry={entry} directory={directory} />
              : directory && <p className="paintkit-details-empty">No texture directory entry.</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
