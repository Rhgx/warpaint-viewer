import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Asterisk,
  Blend,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  LockKeyhole,
  Package,
  Plus,
  SlidersHorizontal,
  Sticker,
  Target,
} from 'lucide-react';

import type { OperationGraphNodeKind, OperationGraphPort } from '../../editor/graph';
import { useOperationTemplates } from '../../hooks/useOperationTemplates';
import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { GraphValueField } from './OperationGraphFields';
import {
  editableParametersFor,
  nodeKindLabel,
  operationNodeKind,
  portTypeClass,
  portTypeLabel,
  shortTexturePath,
  sourceSummary,
  visibleInputPorts,
} from './operationGraphFlowModel';
import {
  TEMPLATE_USAGE_LIMIT,
  type EditableParameter,
  type FlowNode,
} from './operationGraphTypes';

// Sized by hand: react-flow measures and lays out nodes from their real size, so density here is load-bearing.
const NODE = 'relative grid w-61.5 cursor-default rounded-md border border-strong bg-panel pl-1 text-text shadow-[0_1px_2px_rgb(0_0_0/12%)] transition-[opacity,border-color,box-shadow] duration-120 focus-ring before:pointer-events-none before:absolute before:-inset-y-px before:-left-px before:z-1 before:w-1.25 before:rounded-l-md before:bg-(--graph-kind) hover:border-(--graph-kind)/55 motion-reduce:transition-none data-locked:bg-[color-mix(in_srgb,var(--panel-2)_45%,var(--panel))] data-selected:border-accent data-selected:shadow-pop data-selected:ring-1 data-selected:ring-accent data-[emphasis=dimmed]:opacity-26 data-[search-match=false]:opacity-32 data-[search-match=true]:data-[emphasis=normal]:border-warn/75 data-search-current:data-[emphasis=normal]:border-warn data-search-current:data-[emphasis=normal]:ring-2 data-search-current:data-[emphasis=normal]:ring-warn';
const NODE_RULE = 'border-t border-border/70';
const NOTE = `m-0 ${NODE_RULE} px-2 py-1.5 text-9 leading-[1.4] text-dim`;
const FIELDS = 'grid cursor-default bg-panel-2/30';
const ACTION = 'gap-1 border border-transparent px-1.25 py-0.75 text-9.5 font-normal text-accent not-disabled:hover:border-border not-disabled:hover:text-accent';
const EXPORT_ITEM = 'group flex min-h-9 cursor-pointer items-center gap-1.75 rounded-sm border-0 bg-transparent px-1.5 py-1.25 text-left text-text focus-ring hover:bg-accent hover:text-accent-text focus-visible:-outline-offset-2';
const EXPORT_DETAIL = 'text-8.5 text-dim group-hover:text-inherit group-hover:opacity-72';
const REORDER_BUTTON = 'size-5 flex-none';
const SUMMARY_ROW = 'flex min-w-0 justify-between gap-2 text-9.5 text-dim';
const SUMMARY_VALUE = 'min-w-0 truncate text-text';

export function NodeKindIcon({ kind }: { readonly kind: OperationGraphNodeKind }): React.JSX.Element {
  const size = 12;
  switch (kind) {
    case 'texture_lookup': return <ImageIcon size={size} aria-hidden />;
    case 'select': return <Layers size={size} aria-hidden />;
    case 'combine_add': return <Plus size={size} aria-hidden />;
    case 'combine_multiply': return <Asterisk size={size} aria-hidden />;
    case 'combine_lerp': return <Blend size={size} aria-hidden />;
    case 'apply_sticker': return <Sticker size={size} aria-hidden />;
    case 'operation_template': return <Package size={size} aria-hidden />;
    case 'output': return <Target size={size} aria-hidden />;
    case 'invalid': return <AlertCircle size={size} aria-hidden />;
  }
}

interface PortRowProps {
  readonly port: OperationGraphPort;
  readonly connectedLabel?: string;
  readonly connectable: boolean;
}

/** One input slot. The dot shows the port type and whether anything is plugged in. */
function PortRow({ port, connectedLabel, connectable }: PortRowProps): React.JSX.Element {
  const state = connectedLabel !== undefined ? 'connected' : port.required ? 'required' : 'open';
  return (
    <div className="relative flex min-h-5 items-center gap-1.75 rounded-sm py-px pl-0.5 hover:bg-panel-2/60 data-[state=open]:opacity-72" data-slot="graph-port-row" data-state={state}>
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        className={portTypeClass(port.type)}
        isConnectable={connectable}
        title={`${port.label}: ${portTypeLabel(port.type)}${connectedLabel ? ` from ${connectedLabel}` : ''}`}
        aria-label={`${port.label}, ${portTypeLabel(port.type)}`}
      />
      <span className="max-w-[45%] min-w-0 flex-none truncate text-dim">{port.label}</span>
      {connectedLabel !== undefined ? (
        <span className="min-w-0 flex-1 truncate text-right text-10 text-text [direction:rtl]" title={connectedLabel}>{connectedLabel}</span>
      ) : (
        <span className={cn('flex-1 text-right text-9', state === 'required' ? 'text-warn' : 'text-dim')}>{port.required ? 'required' : port.variadic ? 'add' : 'empty'}</span>
      )}
    </div>
  );
}

function OperationFlowNodeComponent({ data, selected }: NodeProps<FlowNode>): React.JSX.Element {
  const { graphNode: node, nodesById, connectedEdges } = data;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const operationUsage = useOperationTemplates(node.kind === 'operation_template');
  const templateDefindex = node.raw?.operation_template?.defindex;
  const templateUsers = templateDefindex === undefined ? [] : (operationUsage?.usage[String(templateDefindex)] ?? []);
  const templateName = templateDefindex === undefined ? undefined : operationUsage?.names[String(templateDefindex)];
  // Which stock template this is, and how far an edit to it would reach.
  const templateRows = node.kind === 'operation_template' && operationUsage ? [
    ...(templateName ? [{ label: 'Template', value: templateName }] : []),
    {
      label: 'Used by',
      value: templateUsers.length === 0
        ? 'no stock war paints'
        : `${templateUsers.length} stock war paint${templateUsers.length === 1 ? '' : 's'}`,
    },
  ] : [];
  const templatePaints = templateUsers
    .map((id) => ({ id, name: data.paintNames?.get(id) ?? String(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nodeDiagnostics = data.diagnostics;
  // Only errors badge the card; warnings fire on ordinary paints and stay in the list.
  const nodeErrors = nodeDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const summaries = sourceSummary(node);
  const inputPorts = visibleInputPorts(node);
  const updateParameter = data.onUpdateParameter;
  const parameters = updateParameter ? editableParametersFor(node) : [];
  const primaryParameters = parameters.filter((entry) => entry.primary);
  const advancedParameters = parameters.filter((entry) => !entry.primary);
  const canReorder = !data.readOnly && (node.kind === 'combine_add' || node.kind === 'combine_multiply' || node.kind === 'output');
  const sourceByInput = new Map(connectedEdges.map((edge) => [edge.inputIndex, nodesById.get(edge.source)?.label ?? edge.source]));

  const reorderInput = (fromIndex: number, toIndex: number): void => {
    if (data.onReorderInput) data.onReorderInput(node.id, fromIndex, toIndex);
    else data.onGraphChange?.({ type: 'reorder', nodeId: node.id, fromIndex, toIndex });
  };

  const handleSelect = (): void => data.onSelectNode(node.id);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect();
    }
  };

  const renderField = (entry: EditableParameter): React.JSX.Element => (
    <GraphValueField
      key={`${entry.address.field}-${entry.address.index ?? 'direct'}`}
      label={entry.meta.label}
      kind={entry.meta.kind}
      {...(entry.field ? { field: entry.field } : {})}
      {...(entry.meta.step !== undefined ? { step: entry.meta.step } : {})}
      variables={data.variables}
      textureOptions={data.textureOptions}
      readOnly={data.readOnly}
      primary={entry.primary ?? false}
      onChange={(value) => updateParameter?.(node.id, entry.address, value)}
    />
  );

  return (
    <article
      className={NODE}
      data-slot="graph-node"
      data-graph-kind={operationNodeKind(node)}
      data-emphasis={data.emphasis}
      data-search-match={data.searchMatch === undefined ? undefined : String(data.searchMatch)}
      data-search-current={data.searchCurrent ? '' : undefined}
      data-locked={node.locked ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      tabIndex={0}
      role="button"
      aria-label={`${node.label}, ${nodeKindLabel(node.kind)} node`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
    >
      {node.kind !== 'output' && (
        <Handle
          type="source"
          position={Position.Right}
          id="output"
          className={portTypeClass(node.outputType)}
          isConnectable={!data.readOnly}
          title={`Output: ${portTypeLabel(node.outputType)}`}
          aria-label={`Output, ${portTypeLabel(node.outputType)}`}
        />
      )}
      <header className="flex min-h-7.5 items-center gap-1.5 rounded-tr-[calc(var(--radius-md)-1px)] border-b border-border bg-(--graph-kind)/7 px-2 py-1.25">
        <span className="grid size-4.5 flex-none place-items-center rounded-sm bg-(--graph-kind)/15 text-(--graph-kind)" aria-hidden><NodeKindIcon kind={node.kind} /></span>
        <span className="grid min-w-0 flex-1 gap-px">
          <span className="text-8.5 leading-none font-bold tracking-[.06em] text-(--graph-kind) uppercase">{nodeKindLabel(node.kind)}</span>
          <strong className="truncate text-11 font-bold" title={node.label}>{node.label}</strong>
        </span>
        {nodeErrors.length > 0 && (
          <span className="inline-flex flex-none items-center gap-0.5 rounded-sm border border-fail/45 bg-fail/10 px-1 py-px text-9 text-fail tabular-nums" title={nodeErrors.map((diagnostic) => diagnostic.message).join('\n')}>
            <AlertCircle size={11} aria-hidden /> {nodeErrors.length}
          </span>
        )}
        {node.locked && <LockKeyhole size={12} aria-label="Locked" />}
      </header>

      {inputPorts.length > 0 && (
        <div className="grid py-1 pr-2 pl-1.5" aria-label="Inputs">
          {inputPorts.map((port) => (
            <PortRow
              key={port.id}
              port={port}
              {...(sourceByInput.has(port.index) ? { connectedLabel: sourceByInput.get(port.index) } : {})}
              connectable={!data.readOnly}
            />
          ))}
        </div>
      )}

      {(data.previewUrl || summaries.length > 0 || templateRows.length > 0) && (
        <div className={cn('grid gap-0.75 px-2 pt-1.25 pb-1.5', NODE_RULE)}>
          {data.previewUrl && (
            <img className="block max-h-18.5 w-full rounded-xs border border-border bg-panel-2 object-contain" src={data.previewUrl} alt={`${node.label} preview`} draggable={false} />
          )}
          {summaries.map((summary) => (
            <div className={SUMMARY_ROW} key={summary.label}>
              <span>{summary.label}</span>
              <span className={SUMMARY_VALUE} title={summary.value}>{shortTexturePath(summary.value)}</span>
            </div>
          ))}
          {templateRows.map((row) => (
            <div className={SUMMARY_ROW} key={row.label}>
              <span>{row.label}</span>
              <span className={SUMMARY_VALUE} title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      )}

      {selected && primaryParameters.length > 0 && (
        <div
          className={cn(FIELDS, 'border-t border-border nodrag nowheel')}
          data-slot="graph-node-fields"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          {primaryParameters.map(renderField)}
        </div>
      )}

      {selected && advancedParameters.length > 0 && (
        <div className="cursor-default border-t border-border nodrag nowheel" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="inline"
            className="min-h-6 w-full justify-start gap-1.25 rounded-none px-2 py-0 text-left text-9.5 focus-visible:-outline-offset-2"
            data-slot="graph-disclosure"
            aria-expanded={advancedOpen}
            onClick={(event) => { event.stopPropagation(); setAdvancedOpen((open) => !open); }}
          >
            {advancedOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            <span className="flex-1">Adjustments and transform</span>
            <small className="rounded-xs bg-panel-2 px-1 text-9 tabular-nums">{advancedParameters.length}</small>
          </Button>
          {advancedOpen && <div className={cn(FIELDS, NODE_RULE)} data-slot="graph-node-fields">{advancedParameters.map(renderField)}</div>}
        </div>
      )}

      {selected && nodeDiagnostics.length > 0 && (
        <ul className={cn('m-0 grid cursor-default list-none gap-0.75 px-2 py-1.5 text-9 leading-[1.4]', NODE_RULE)}>
          {nodeDiagnostics.map((diagnostic) => (
            <li
              className={cn('flex items-start gap-1', diagnostic.severity === 'warning' ? 'text-warn' : 'text-fail')}
              key={`${diagnostic.code}-${diagnostic.message}`}
              data-severity={diagnostic.severity}
            >
              {diagnostic.severity === 'warning'
                ? <AlertTriangle className="mt-px flex-none" size={10} aria-hidden />
                : <AlertCircle className="mt-px flex-none" size={10} aria-hidden />}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      )}

      {selected && node.kind === 'operation_template' && (
        <p className={NOTE}>Template references are preserved and read-only.</p>
      )}
      {selected && node.kind === 'operation_template' && templatePaints.length > 0 && (
        <div
          className={cn(NOTE, 'nodrag')}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {templatePaints.slice(0, TEMPLATE_USAGE_LIMIT).map((paint, index) => (
            <span key={paint.id}>
              {index > 0 && ', '}
              <Button variant="link" size="inline" className="p-0 font-normal" onClick={() => data.onSelectKit?.(paint.id)}>{paint.name}</Button>
            </span>
          ))}
          {templatePaints.length > TEMPLATE_USAGE_LIMIT && (
            <span>, and {templatePaints.length - TEMPLATE_USAGE_LIMIT} more</span>
          )}
        </div>
      )}
      {selected && node.kind === 'invalid' && (
        <p className={NOTE}>This stage uses an unknown operation.</p>
      )}

      {selected && canReorder && connectedEdges.length > 1 && (
        <div className={cn('grid cursor-default gap-0.75 px-2 py-1.5 nodrag', NODE_RULE)} aria-label="Input order" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <ControlLabel className="text-9">Input order</ControlLabel>
          {connectedEdges.map((edge, index) => (
            <div className="flex min-w-0 items-center justify-between gap-1.75 text-9.5 text-dim" key={edge.id}>
              <span className="truncate">{nodesById.get(edge.source)?.label ?? edge.source}</span>
              <span className="flex flex-none gap-0.5">
                <Button variant="ghost" size="icon-sm" className={REORDER_BUTTON} title="Move input up" aria-label="Move input up" disabled={index === 0} onClick={() => reorderInput(index, index - 1)}><ArrowUp size={12} /></Button>
                <Button variant="ghost" size="icon-sm" className={REORDER_BUTTON} title="Move input down" aria-label="Move input down" disabled={index === connectedEdges.length - 1} onClick={() => reorderInput(index, index + 1)}><ArrowDown size={12} /></Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={cn('flex min-h-6.5 cursor-default items-center gap-1 px-1.75 py-0.75 nodrag empty:hidden', NODE_RULE)}>
        {node.kind === 'texture_lookup' && data.onOpenTextureEditor && (
          <Button variant="ghost" size="inline" className={ACTION} onClick={(event) => { event.stopPropagation(); data.onOpenTextureEditor?.(node.id); }}>
            <SlidersHorizontal size={12} /> Transform
          </Button>
        )}
        {node.kind === 'select' && data.onOpenSelectEditor && (
          <Button variant="ghost" size="inline" className={ACTION} onClick={(event) => { event.stopPropagation(); data.onOpenSelectEditor?.(node.id); }}>
            <ExternalLink size={12} /> Groups
          </Button>
        )}
        {node.kind === 'apply_sticker' && data.onOpenStickerEditor && (
          <Button variant="ghost" size="inline" className={ACTION} onClick={(event) => { event.stopPropagation(); data.onOpenStickerEditor?.(node.id); }}>
            <ExternalLink size={12} /> Placement
          </Button>
        )}
        {data.onExportNode && data.previewUrl && (
          <details className="group/export relative ml-auto" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-sm border border-transparent px-1.5 text-9.5 text-accent focus-ring hover:border-border hover:bg-panel-2 group-open/export:border-border group-open/export:bg-panel-2 [&::-webkit-details-marker]:hidden" data-slot="graph-export" title="Download this stage's preview"><Download size={12} /> Export</summary>
            <div className="absolute right-0 bottom-[calc(100%+3px)] z-1100 grid w-43 rounded-md border border-strong bg-panel p-1 shadow-pop">
              <button type="button" className={EXPORT_ITEM} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); data.onExportNode?.(node.id, 'png'); }}>
                <ImageIcon size={13} aria-hidden />
                <span className="grid gap-px">PNG image<small className={EXPORT_DETAIL}>Easy to preview or share</small></span>
              </button>
              <button type="button" className={EXPORT_ITEM} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); data.onExportNode?.(node.id, 'vtf'); }}>
                <Package size={13} aria-hidden />
                <span className="grid gap-px">VTF texture<small className={EXPORT_DETAIL}>Ready for Source tools</small></span>
              </button>
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

export const OperationFlowNode = memo(OperationFlowNodeComponent);
