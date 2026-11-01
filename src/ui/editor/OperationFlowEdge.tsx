import { memo, useState } from 'react';
import { EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { EDGE_CORNER_RADIUS, EDGE_INTERACTION_WIDTH, type FlowEdge } from './operationGraphTypes';

/** A typed connection that can be removed where it is, without going to the toolbar. */
function OperationFlowEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<FlowEdge>): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: EDGE_CORNER_RADIUS,
  });
  const active = Boolean(selected) || hovered;
  const removable = active && data !== undefined && !data.readOnly;
  return (
    <>
      <path id={id} className="react-flow__edge-path" d={path} markerEnd={markerEnd} />
      {data?.traced && (
        // Animated dashes show the flow direction without finding the arrowhead.
        <path className="operation-graph-edge-flow" d={path} fill="none" />
      )}
      <path
        className="operation-graph-edge-hit"
        d={path}
        fill="none"
        strokeWidth={EDGE_INTERACTION_WIDTH}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      />
      {removable && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="operation-graph-edge-remove nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={`Disconnect ${data.sourceLabel} from ${data.targetLabel}`}
            aria-label={`Disconnect ${data.sourceLabel} from ${data.targetLabel}`}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onClick={(event) => { event.stopPropagation(); data.onDisconnect(id); }}
          >
            <X size={11} aria-hidden />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const OperationFlowEdge = memo(OperationFlowEdgeComponent);
