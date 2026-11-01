import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
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
import { GraphValueField } from './OperationGraphFields';
import {
  editableParametersFor,
  nodeKindLabel,
  operationNodeClass,
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
    case 'invalid': return <AlertTriangle size={size} aria-hidden />;
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
    <div className="operation-graph-port-row" data-state={state}>
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        className={`operation-graph-handle ${portTypeClass(port.type)}`}
        isConnectable={connectable}
        title={`${port.label}: ${portTypeLabel(port.type)}${connectedLabel ? ` from ${connectedLabel}` : ''}`}
        aria-label={`${port.label}, ${portTypeLabel(port.type)}`}
      />
      <span className="operation-graph-port-label">{port.label}</span>
      {connectedLabel !== undefined ? (
        <span className="operation-graph-port-source" title={connectedLabel}>{connectedLabel}</span>
      ) : (
        <span className="operation-graph-port-state">{port.required ? 'required' : port.variadic ? 'add' : 'empty'}</span>
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
      className={`operation-graph-node ${operationNodeClass(node)}`}
      data-emphasis={data.emphasis}
      data-search-match={data.searchMatch ? 'true' : undefined}
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
          className={`operation-graph-handle operation-graph-output-handle ${portTypeClass(node.outputType)}`}
          isConnectable={!data.readOnly}
          title={`Output: ${portTypeLabel(node.outputType)}`}
          aria-label={`Output, ${portTypeLabel(node.outputType)}`}
        />
      )}
      <header className="operation-graph-node-header">
        <span className="operation-graph-node-glyph" aria-hidden><NodeKindIcon kind={node.kind} /></span>
        <span className="operation-graph-node-heading">
          <span className="operation-graph-node-kind">{nodeKindLabel(node.kind)}</span>
          <strong title={node.label}>{node.label}</strong>
        </span>
        {nodeErrors.length > 0 && (
          <span className="operation-graph-node-badge" title={nodeErrors.map((diagnostic) => diagnostic.message).join('\n')}>
            <AlertTriangle size={11} aria-hidden /> {nodeErrors.length}
          </span>
        )}
        {node.locked && <LockKeyhole size={12} aria-label="Locked" />}
      </header>

      {inputPorts.length > 0 && (
        <div className="operation-graph-inputs" aria-label="Inputs">
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
        <div className="operation-graph-node-summary">
          {data.previewUrl && (
            <img className="operation-graph-node-preview" src={data.previewUrl} alt={`${node.label} preview`} draggable={false} />
          )}
          {summaries.map((summary) => (
            <div className="operation-graph-summary-row" key={summary.label}>
              <span>{summary.label}</span>
              <span title={summary.value}>{shortTexturePath(summary.value)}</span>
            </div>
          ))}
          {templateRows.map((row) => (
            <div className="operation-graph-summary-row" key={row.label}>
              <span>{row.label}</span>
              <span title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      )}

      {selected && primaryParameters.length > 0 && (
        <div
          className="operation-graph-node-fields nodrag nowheel"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          {primaryParameters.map(renderField)}
        </div>
      )}

      {selected && advancedParameters.length > 0 && (
        <div className="operation-graph-node-advanced nodrag nowheel" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="operation-graph-disclosure"
            aria-expanded={advancedOpen}
            onClick={(event) => { event.stopPropagation(); setAdvancedOpen((open) => !open); }}
          >
            {advancedOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            <span>Adjustments and transform</span>
            <small>{advancedParameters.length}</small>
          </button>
          {advancedOpen && <div className="operation-graph-node-fields">{advancedParameters.map(renderField)}</div>}
        </div>
      )}

      {selected && nodeDiagnostics.length > 0 && (
        <ul className="operation-graph-diagnostics">
          {nodeDiagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}-${diagnostic.message}`} data-severity={diagnostic.severity}>{diagnostic.message}</li>
          ))}
        </ul>
      )}

      {selected && node.kind === 'operation_template' && (
        <p className="operation-graph-note">Template references are preserved and read-only.</p>
      )}
      {selected && node.kind === 'operation_template' && templatePaints.length > 0 && (
        <div
          className="operation-graph-note operation-graph-usage nodrag"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {templatePaints.slice(0, TEMPLATE_USAGE_LIMIT).map((paint, index) => (
            <span key={paint.id}>
              {index > 0 && ', '}
              <button type="button" className="operation-graph-usage-link" onClick={() => data.onSelectKit?.(paint.id)}>{paint.name}</button>
            </span>
          ))}
          {templatePaints.length > TEMPLATE_USAGE_LIMIT && (
            <span>, and {templatePaints.length - TEMPLATE_USAGE_LIMIT} more</span>
          )}
        </div>
      )}
      {selected && node.kind === 'invalid' && (
        <p className="operation-graph-note">This node contains an unknown operation stage.</p>
      )}

      {selected && canReorder && connectedEdges.length > 1 && (
        <div className="operation-graph-reorder-list nodrag" aria-label="Input order" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <span className="operation-graph-section-label">Input order</span>
          {connectedEdges.map((edge, index) => (
            <div className="operation-graph-reorder-row" key={edge.id}>
              <span>{nodesById.get(edge.source)?.label ?? edge.source}</span>
              <span>
                <button type="button" className="operation-graph-icon-button" title="Move input up" aria-label="Move input up" disabled={index === 0} onClick={() => reorderInput(index, index - 1)}><ArrowUp size={12} /></button>
                <button type="button" className="operation-graph-icon-button" title="Move input down" aria-label="Move input down" disabled={index === connectedEdges.length - 1} onClick={() => reorderInput(index, index + 1)}><ArrowDown size={12} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="operation-graph-node-actions nodrag">
        {node.kind === 'texture_lookup' && data.onOpenTextureEditor && (
          <button type="button" className="operation-graph-text-button" onClick={(event) => { event.stopPropagation(); data.onOpenTextureEditor?.(node.id); }}>
            <SlidersHorizontal size={12} /> Transform
          </button>
        )}
        {node.kind === 'select' && data.onOpenSelectEditor && (
          <button type="button" className="operation-graph-text-button" onClick={(event) => { event.stopPropagation(); data.onOpenSelectEditor?.(node.id); }}>
            <ExternalLink size={12} /> Groups
          </button>
        )}
        {node.kind === 'apply_sticker' && data.onOpenStickerEditor && (
          <button type="button" className="operation-graph-text-button" onClick={(event) => { event.stopPropagation(); data.onOpenStickerEditor?.(node.id); }}>
            <ExternalLink size={12} /> Placement
          </button>
        )}
        {data.onExportNode && data.previewUrl && (
          <details className="operation-graph-export" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <summary title="Download this stage's preview"><Download size={12} /> Export</summary>
            <div className="operation-graph-export-menu">
              <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); data.onExportNode?.(node.id, 'png'); }}>
                <ImageIcon size={13} aria-hidden />
                <span>PNG image<small>Easy to preview or share</small></span>
              </button>
              <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); data.onExportNode?.(node.id, 'vtf'); }}>
                <Package size={13} aria-hidden />
                <span>VTF texture<small>Ready for Source tools</small></span>
              </button>
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

export const OperationFlowNode = memo(OperationFlowNodeComponent);
