import { Fragment, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Copy, Info } from 'lucide-react';

import type { OperationTemplateData, PaintkitEntry, TextureDirectory, TextureDirectoryEntry } from '../../data/types';
import { isCustomKitId } from '../../protodefs/types';
import { useCopyText } from './useCopyText';
import { useOperationTemplates } from '../../hooks/useOperationTemplates';
import { useSettings } from '../../settings';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { PATH_TEXT } from '../primitives/textStyles';

// Pyxell's names carry footnote asterisks and sometimes drop accents. Names matching no stock paint stay plain text.
const foldName = (name: string) => name.replace(/\*+$/, '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function findBaseKit(paintkits: readonly PaintkitEntry[], baseName: string) {
  const folded = foldName(baseName);
  return paintkits.find((kit) => !isCustomKitId(kit.id) && foldName(kit.name) === folded);
}

// Splits lines like 'TL_3 & TL_4 - "patterns/a"*' into slot label, quoted paths and footnote
// asterisks. Lines of any other shape are shown as written.
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

// Top-level templates that use this stock paint, with how many other paints share each.
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

const PATH = cn('-ml-1 max-w-full px-1 py-px text-left text-text wrap-anywhere', PATH_TEXT);
const INLINE_ACTION = 'cursor-pointer border-0 bg-transparent p-0 [font:inherit] focus-ring hover:underline';
const BASE_LINK = `${INLINE_ACTION} text-accent`;
const LIST = 'm-0 list-disc pl-4';

// Each shared count expands to the other paints on that operation. Cards start collapsed.
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
      <dt className="text-dim">Operation</dt>
      <dd className="m-0 text-text">
        {operations.map((operation, i) => {
          const title = `${operation.others} other stock war paint${operation.others === 1 ? '' : 's'} use this operation`;
          return (
            <Fragment key={operation.defindex}>
              {i > 0 && ', '}
              <CopyButton text={operation.name} title="Copy operation name" className={`inline ${PATH}`}>
                {operation.name}
              </CopyButton>
              {' '}
              {operation.others > 0 ? (
                <button
                  type="button"
                  className={`${INLINE_ACTION} text-left text-dim`}
                  title={title}
                  aria-expanded={sharedOpen === operation.defindex}
                  onClick={() => setSharedOpen(sharedOpen === operation.defindex ? null : operation.defindex)}
                >
                  {sharedSuffix(operation.others)}
                </button>
              ) : (
                <span className="text-dim" title={title}>{sharedSuffix(operation.others)}</span>
              )}
            </Fragment>
          );
        })}
        {expanded && (
          <div className="mt-1 wrap-anywhere">
            {sharers.slice(0, SHARED_LIST_LIMIT).map((kit, i) => (
              <Fragment key={kit.id}>
                {i > 0 && ', '}
                <Popover.Close className={BASE_LINK} onClick={() => onSelectKit(kit.id)}>
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
    <button
      type="button"
      className={cn('cursor-copy rounded-sm border-0 bg-transparent p-0 text-dim transition-fast focus-ring hover:bg-panel-2 hover:text-text', className)}
      title={title}
      onClick={() => void copy(text)}
    >
      {children}
      {notice && <span className="ml-2 font-sans text-pass">{notice}</span>}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="[section+&]:mt-2.5">
      <h3 className="m-0 mb-1 text-11 font-semibold text-text">{title}</h3>
      {children}
    </section>
  );
}

function DirectoryEntry({ entry, directory }: { entry: TextureDirectoryEntry; directory: TextureDirectory }) {
  const textures = entry.textures.map((line) => ({ line, parsed: splitTextureLine(line) }));
  // Two-letter terms name texture slots and are listed in the legend; longer terms are tooltips.
  const slotTerms = directory.legend.filter((item) => item.term.length <= 2
    && textures.some(({ parsed }) => parsed?.slot.includes(`${item.term}_`)));
  const featureTerms = directory.legend.filter((item) => item.term.length > 2);
  const featureTitle = (feature: string) => featureTerms
    .find((item) => feature.toLowerCase().includes(item.term.toLowerCase()))?.description;

  return (
    <>
      <Section title="Textures">
        <dl className="m-0 grid grid-cols-[fit-content(140px)_minmax(0,1fr)] gap-x-3 gap-y-1 *:contents">
          {textures.map(({ line, parsed }, i) => parsed ? (
            <div key={i}>
              <dt className="pt-0.5 text-11 text-dim">{parsed.slot}</dt>
              <dd className="col-start-2 m-0">
                {parsed.paths.map((path, j) => (
                  <CopyButton key={j} text={path} title="Copy path" className={`block ${PATH}`}>
                    {path}
                    {j === parsed.paths.length - 1 && parsed.suffix && (
                      <span className="text-dim">{parsed.suffix}</span>
                    )}
                  </CopyButton>
                ))}
              </dd>
            </div>
          ) : (
            <div key={i}><dd className="col-start-2 m-0">{line}</dd></div>
          ))}
        </dl>
      </Section>

      {entry.features && (
        <Section title="Features">
          <ul className={LIST}>
            {entry.features.map((line, i) => {
              const title = featureTitle(line);
              return (
                <li
                  key={i}
                  className="not-first:mt-0.5 data-explained:cursor-help data-explained:underline data-explained:decoration-dim data-explained:decoration-dotted data-explained:underline-offset-3"
                  title={title}
                  data-explained={title ? '' : undefined}
                >
                  {line}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {entry.notes && (
        <Section title="Notes">
          <ul className={LIST}>{entry.notes.map((line, i) => <li key={i} className="not-first:mt-0.5">{line}</li>)}</ul>
        </Section>
      )}

      <footer className="mt-3 border-t border-border pt-2 text-11 text-dim">
        {slotTerms.length > 0 && (
          <dl className="m-0 mb-1.5 grid gap-0.5">
            {slotTerms.map((item) => (
              <div key={item.term} className="flex gap-2">
                <dt className="w-5 flex-none font-semibold text-text">{item.term}</dt>
                <dd className="m-0">{item.description}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="m-0">
          From <a className="text-accent underline" href={directory.source} target="_blank" rel="noreferrer">Pyxell's TF2 Warpaint Texture Directory</a>,
          retrieved {directory.retrievedAt}.
        </p>
      </footer>
    </>
  );
}

// Popover.Portal mounts children only while open, so operation data loads on first open.
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
      <header className="not-last:mb-2.5 not-last:border-b not-last:border-border not-last:pb-2">
        <div className="flex items-baseline justify-between gap-3">
          <Popover.Title className="m-0 text-13 font-semibold">{kitName}</Popover.Title>
          {/* The paintkit_proto_def_index that VScript and popfiles take. */}
          <CopyButton text={String(defindex)} title="Copy paintkit_proto_def_index" className="inline-flex flex-none items-center gap-1.25 px-1.25 py-px text-12 tabular-nums">
            #{defindex}<Copy size={11} aria-hidden="true" />
          </CopyButton>
        </div>
        {(entry?.base || operations.length > 0) && (
          <dl className="m-0 mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-11 *:contents">
            {entry?.base && (
              <div>
                <dt className="text-dim">Base</dt>
                <dd className="m-0 text-text">
                  {entry.base.map((name, i) => {
                    const kit = findBaseKit(paintkits, name);
                    return (
                      <Fragment key={i}>
                        {i > 0 && ', '}
                        {kit ? (
                          <Popover.Close className={BASE_LINK} onClick={() => onSelectKit(kit.id)}>
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
        : directory && <p className="m-0 mt-0.5 text-11 text-dim">No texture directory entry.</p>}
    </>
  );
}

// Info button and its card. Opens on hover for mouse users and on click for touch.
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
        aria-label={`Details for ${kitName}`}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-slot="paintkit-details-trigger"
            className={cn('size-5.5 flex-none rounded-full data-popup-open:bg-panel-2 data-popup-open:text-text', className)}
          />
        }
      >
        <Info size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="start" sideOffset={8} collisionPadding={10} className="z-1100">
          {/* Shrinks to an ID-only card; directory entries fill out to the cap. */}
          <Popover.Popup
            className="scrollbar-slim max-h-(--available-height) w-max max-w-[min(500px,var(--available-width))] origin-(--transform-origin) overflow-auto rounded-lg border border-strong bg-panel px-3.5 py-3 text-12 leading-[1.45] text-text shadow-pop [transition:opacity_120ms_ease,scale_120ms_ease] data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 motion-reduce:transition-none"
            data-slot="paintkit-details-popup"
            data-camera-input-suspended=""
          >
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
