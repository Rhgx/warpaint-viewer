import { Fragment, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Copy, Info } from 'lucide-react';
import type { OperationTemplateData, PaintkitEntry, TextureDirectory, TextureDirectoryEntry } from '../../data/types';
import { isCustomKitId } from '../../protodefs/types';
import { useCopyText } from '../../hooks/useCopyText';
import { useOperationTemplates } from '../../hooks/useOperationTemplates';
import { useSettings } from '../../settings';
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

interface OperationUsage {
  defindex: number;
  name: string;
  others: number;
  users: ReadonlySet<number>;
}

// Top-level templates whose usage list holds this stock paint, with how many
// other stock paints share each one.
function operationsFor(data: OperationTemplateData | null, defindex: number): OperationUsage[] {
  if (!data) return [];
  return data.templates.flatMap((template) => {
    const users = data.usage[String(template.defindex)] ?? [];
    return users.includes(defindex)
      ? [{ defindex: template.defindex, name: template.name, others: users.length - 1, users: new Set(users) }]
      : [];
  });
}

function sharedSuffix(others: number): string {
  if (others === 0) return 'not shared';
  return others === 1 ? 'shared with 1 other' : `shared with ${others} others`;
}

const SHARED_LIST_LIMIT = 12;

// The Operation row, with each shared count expandable into the other stock
// paints on that operation. The open state lives here, so every opened card
// starts collapsed.
function OperationRow({ defindex, operations, paintkits, onSelectKit }: {
  defindex: number;
  operations: OperationUsage[];
  paintkits: readonly PaintkitEntry[];
  onSelectKit: (id: number) => void;
}) {
  const [sharedOpen, setSharedOpen] = useState<number | null>(null);
  const expanded = operations.find((operation) => operation.defindex === sharedOpen);
  const sharers = expanded
    ? paintkits
        .filter((kit) => !isCustomKitId(kit.id) && kit.id !== defindex && expanded.users.has(kit.id))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return (
    <div>
      <dt>Operation</dt>
      <dd>
        {operations.map((operation, i) => {
          const title = `${operation.others} other stock war paint${operation.others === 1 ? '' : 's'} use this operation`;
          return (
            <Fragment key={operation.defindex}>
              {i > 0 && ', '}
              <CopyButton text={operation.name} title="Copy operation name" className="paintkit-details-path">
                {operation.name}
              </CopyButton>
              {' '}
              {operation.others > 0 ? (
                <button
                  type="button"
                  className="paintkit-details-suffix paintkit-details-shared-toggle"
                  title={title}
                  aria-expanded={sharedOpen === operation.defindex}
                  onClick={() => setSharedOpen(sharedOpen === operation.defindex ? null : operation.defindex)}
                >
                  {sharedSuffix(operation.others)}
                </button>
              ) : (
                <span className="paintkit-details-suffix" title={title}>{sharedSuffix(operation.others)}</span>
              )}
            </Fragment>
          );
        })}
        {expanded && (
          <div className="paintkit-details-shared">
            {sharers.slice(0, SHARED_LIST_LIMIT).map((kit, i) => (
              <Fragment key={kit.id}>
                {i > 0 && ', '}
                <Popover.Close className="paintkit-details-base-link" onClick={() => onSelectKit(kit.id)}>
                  {kit.name}
                </Popover.Close>
              </Fragment>
            ))}
            {sharers.length > SHARED_LIST_LIMIT && `, and ${sharers.length - SHARED_LIST_LIMIT} more`}
          </div>
        )}
      </dd>
    </div>
  );
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

// The popup body. Popover.Portal mounts its children only while the popover is
// open, so the operation template data is fetched on the first open, not on hover.
function PaintkitDetailsContent({
  defindex,
  kitName,
  entry,
  directory,
  paintkits,
  onSelectKit,
  stockKit,
}: {
  defindex: number;
  kitName: string;
  entry: TextureDirectoryEntry | undefined;
  directory: TextureDirectory | null;
  paintkits: readonly PaintkitEntry[];
  onSelectKit: (id: number) => void;
  stockKit: boolean;
}) {
  const showDetails = useSettings((s) => s.showPaintkitDetails);
  const operationUsage = useOperationTemplates(showDetails);
  const operations = stockKit ? operationsFor(operationUsage, defindex) : [];

  return (
    <>
      <header className="paintkit-details-header">
        <div className="paintkit-details-heading">
          <Popover.Title className="paintkit-details-title">{kitName}</Popover.Title>
          {/* The paintkit_proto_def_index that VScript and popfiles take. */}
          <CopyButton text={String(defindex)} title="Copy paintkit_proto_def_index" className="paintkit-details-id">
            #{defindex}<Copy size={11} aria-hidden="true" />
          </CopyButton>
        </div>
        {(entry?.base || operations.length > 0) && (
          <dl className="paintkit-details-meta">
            {entry?.base && (
              <div>
                <dt>Base</dt>
                <dd>
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
                </dd>
              </div>
            )}
            {operations.length > 0 && (
              <OperationRow defindex={defindex} operations={operations} paintkits={paintkits} onSelectKit={onSelectKit} />
            )}
          </dl>
        )}
      </header>
      {entry && directory
        ? <DirectoryEntry entry={entry} directory={directory} />
        : directory && <p className="paintkit-details-empty">No texture directory entry.</p>}
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
  stockKit,
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
  /** Imported kits can share a defindex with a stock kit, so they are excluded by catalog id. */
  stockKit: boolean;
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
            <PaintkitDetailsContent
              defindex={defindex}
              kitName={kitName}
              entry={entry}
              directory={directory}
              paintkits={paintkits}
              onSelectKit={onSelectKit}
              stockKit={stockKit}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
