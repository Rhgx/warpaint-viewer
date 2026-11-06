import type { ComposeDimensions, ComposeResult } from './compositor';
import { resolveRecipe, type ResolvedNode } from './resolve';
import type { PaintSeed, RecipeNode } from './types';

/** What the latest-compose scheduler reads and writes on the Compositor that owns it. */
export interface LatestComposeHost {
  readonly enqueue: <T>(work: () => T | Promise<T>) => Promise<T>;
  readonly composeResolvedNow: (
    resolved: ResolvedNode,
    dimensions: ComposeDimensions | undefined,
    cancelled: () => boolean,
  ) => Promise<ComposeResult | null>;
  readonly releaseResult: (result: ComposeResult) => void;
  readonly prefetchTiers: (recipe: ResolvedNode, size: number) => void;
}

interface LatestComposeRequest {
  readonly recipe: ResolvedNode;
  readonly dimensions?: ComposeDimensions;
  readonly resolve: (result: ComposeResult | null) => void;
  readonly reject: (cause: unknown) => void;
  readonly cancelled?: () => boolean;
}

interface LatestComposeChannel {
  running: boolean;
  pending: LatestComposeRequest | null;
}

/** Keeps one pending composition per channel, so a newer request replaces the one waiting. */
export class LatestComposeScheduler {
  private readonly host: LatestComposeHost;
  private latestComposeChannels = new Map<string, LatestComposeChannel>();

  constructor(host: LatestComposeHost) {
    this.host = host;
  }

  /** Keep at most one pending composition per channel; a newer request replaces it. */
  composeLatest(
    channel: string,
    recipe: RecipeNode,
    seed: PaintSeed,
    dimensions?: ComposeDimensions,
    cancelled?: () => boolean,
  ): Promise<ComposeResult | null> {
    return this.composeResolvedLatest(channel, resolveRecipe(recipe, seed), dimensions, cancelled);
  }

  composeResolvedLatest(
    channel: string,
    recipe: ResolvedNode,
    dimensions?: ComposeDimensions,
    cancelled?: () => boolean,
  ): Promise<ComposeResult | null> {
    let state = this.latestComposeChannels.get(channel);
    if (!state) {
      state = { running: false, pending: null };
      this.latestComposeChannels.set(channel, state);
    }
    // Source fetch and decode need not wait for the queue, so by its turn the
    // compose is GPU work alone.
    if (dimensions?.sourceLimit) this.host.prefetchTiers(recipe, dimensions.sourceLimit);
    return new Promise<ComposeResult | null>((resolve, reject) => {
      state!.pending?.resolve(null);
      state!.pending = { recipe, dimensions, resolve, reject, cancelled };
      if (!state!.running) void this.runLatestComposeChannel(channel, state!);
    });
  }

  private async runLatestComposeChannel(channel: string, state: LatestComposeChannel): Promise<void> {
    state.running = true;
    while (state.pending) {
      const request = state.pending;
      state.pending = null;
      try {
        const result = await this.host.enqueue(() => state.pending || request.cancelled?.()
          ? null : this.host.composeResolvedNow(request.recipe, request.dimensions, () => Boolean(state.pending) || Boolean(request.cancelled?.())));
        if (!result) {
          request.resolve(null);
        } else if (state.pending || request.cancelled?.()) {
          this.host.releaseResult(result);
          request.resolve(null);
        } else {
          request.resolve(result);
        }
      } catch (cause) {
        request.reject(cause);
      }
    }
    state.running = false;
    if (!state.pending) this.latestComposeChannels.delete(channel);
  }
}
