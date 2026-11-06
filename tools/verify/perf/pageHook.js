// Runs before the app on every load. Times what the app does to WebGL, the network and the main thread
// without any help from the app beyond the wpv: User Timing marks a VITE_PERF_MARKS build adds.
(() => {
  if (window.top !== window || window.__perf) return;

  const now = () => performance.now();
  performance.setResourceTimingBufferSize(50000);

  let stepStart = 0;
  let counters = {};
  let marks = {};
  let onScreen = {};
  let awaitingScreen = new Set();
  let decodes = [];
  let modelParseMs = 0;
  let modelParses = 0;
  let linking = new Map();
  let linkSpans = [];
  let inflight = 0;
  let lastActivity = now();
  const frames = [];
  const longTasks = [];

  const bump = (name, ms) => {
    const counter = (counters[name] ??= { ms: 0, n: 0, max: 0 });
    counter.ms += ms;
    counter.n += 1;
    counter.max = Math.max(counter.max, ms);
  };

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, ms: entry.duration });
  }).observe({ type: 'longtask', buffered: true });

  let bootSeen = false;
  let bootGone;
  const pump = () => {
    frames.push(now());
    if (bootGone === undefined && frames.length % 3 === 0) {
      const booting = Boolean(document.querySelector('[data-slot="boot-loader"]'));
      if (bootSeen && !booting) bootGone = now();
      bootSeen ||= booting;
    }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);

  const realMark = performance.mark.bind(performance);
  performance.mark = (name, options) => {
    if (typeof name === 'string' && name.startsWith('wpv:')) {
      const key = name.slice(4);
      (marks[key] ??= []).push(now());
      if (!(key in onScreen)) awaitingScreen.add(key);
    }
    return realMark(name, options);
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    inflight += 1;
    lastActivity = now();
    return realFetch(...args).finally(() => {
      inflight -= 1;
      lastActivity = now();
    });
  };

  const realDecode = window.createImageBitmap.bind(window);
  window.createImageBitmap = (...args) => {
    const start = now();
    return realDecode(...args).then((bitmap) => {
      decodes.push({ start, end: now(), small: Boolean(args[1]?.resizeWidth) });
      return bitmap;
    });
  };

  const realArrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = function arrayBuffer() {
    return realArrayBuffer.call(this).then((buffer) => {
      // GLTFLoader parses in promise continuations of this result, so the next task marks the end of the parse.
      if (buffer.byteLength >= 4 && new Uint32Array(buffer, 0, 1)[0] === 0x46546c67) {
        const start = now();
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          modelParseMs += now() - start;
          modelParses += 1;
        };
        channel.port2.postMessage(0);
      }
      return buffer;
    });
  };

  const proto = WebGL2RenderingContext.prototype;
  const glState = (gl) => (gl.__perfState ??= { draw: null, read: null });
  const timed = (name, categorize) => {
    const real = proto[name];
    proto[name] = function wrapped(...args) {
      const start = now();
      const result = real.apply(this, args);
      bump(categorize.call(this, args), now() - start);
      return result;
    };
  };

  for (const name of ['compileShader', 'linkProgram']) timed(name, () => 'compile');
  // Reading a link or compile result blocks until it finishes, unless it asks for the parallel-compile status.
  const COMPLETION_STATUS = 0x91b1;
  for (const name of ['getProgramParameter', 'getShaderParameter']) {
    const real = proto[name];
    proto[name] = function wrapped(object, pname) {
      if (pname === COMPLETION_STATUS) return real.call(this, object, pname);
      const start = now();
      const result = real.call(this, object, pname);
      bump('compile', now() - start);
      return result;
    };
  }
  const realLink = proto.linkProgram;
  proto.linkProgram = function linkProgram(program) {
    linking.set(program, now());
    return realLink.call(this, program);
  };

  const uploadKind = (args) => {
    const source = args[args.length - 1];
    if (source instanceof HTMLImageElement) return 'uploadImage';
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'uploadBitmap';
    if (source instanceof HTMLCanvasElement) return 'uploadCanvas';
    return 'uploadData';
  };
  for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D']) timed(name, uploadKind);
  timed('texStorage2D', () => 'uploadStorage');
  timed('generateMipmap', () => 'mips');
  for (const name of ['bufferData', 'bufferSubData']) timed(name, () => 'geometry');
  timed('readPixels', () => 'readback');

  const realBind = proto.bindFramebuffer;
  proto.bindFramebuffer = function bindFramebuffer(target, framebuffer) {
    const state = glState(this);
    if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) state.draw = framebuffer;
    if (target === this.FRAMEBUFFER || target === this.READ_FRAMEBUFFER) state.read = framebuffer;
    return realBind.call(this, target, framebuffer);
  };
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const real = proto[name];
    proto[name] = function wrapped(...args) {
      const state = glState(this);
      const start = now();
      const result = real.apply(this, args);
      const end = now();
      bump(state.draw ? 'drawTarget' : 'drawScreen', end - start);
      if (!state.draw) {
        for (const key of awaitingScreen) onScreen[key] = end;
        awaitingScreen.clear();
      }
      return result;
    };
  }

  // A program is done once the parallel-compile status says so, or once its link result is read.
  const realPoll = proto.getProgramParameter;
  proto.getProgramParameter = function getProgramParameter(program, pname) {
    const result = realPoll.call(this, program, pname);
    if (linking.has(program) && (pname !== COMPLETION_STATUS || result)) {
      linkSpans.push({ start: linking.get(program), end: now() });
      linking.delete(program);
    }
    return result;
  };

  const classify = (url) => {
    const { pathname } = new URL(url);
    if (pathname.startsWith('/textures/')) return 'textures';
    const data = pathname.split('/data/')[1];
    if (data !== undefined) {
      const head = data.split('/')[0];
      if (head === 'manifest.json' || head === 'grades.json') return 'boot';
      if (head === 'recipes') return 'recipes';
      if (head === 'models') return 'models';
      if (head === 'env') return 'env';
      if (head === 'icons' || head === 'thumbnails') return 'icons';
      if (head === 'effects') return 'effects';
      if (head === 'viewmodels') return 'viewmodels';
      if (head.startsWith('protodefs') || head === 'item-defs.json' || head === 'operation-templates.json' || head === 'texture-directory.json') return 'protodefs';
      return 'dataOther';
    }
    if (pathname.endsWith('.js') || pathname.endsWith('.css')) return 'shell';
    return 'other';
  };

  const unionMs = (spans) => {
    let total = 0;
    let end = -Infinity;
    for (const span of [...spans].sort((a, b) => a.start - b.start)) {
      if (span.end <= end) continue;
      total += span.end - Math.max(span.start, end);
      end = span.end;
    }
    return total;
  };

  const round = (value) => (value === undefined ? undefined : Math.round(value * 10) / 10);
  const relative = (value) => (value === undefined ? undefined : round(value - stepStart));

  window.__perf = {
    begin() {
      stepStart = now();
      counters = {};
      marks = {};
      onScreen = {};
      awaitingScreen = new Set();
      decodes = [];
      modelParseMs = 0;
      modelParses = 0;
      linking = new Map();
      linkSpans = [];
      delete window.__perfPaint;
      lastActivity = now();
    },

    status() {
      return {
        marks: Object.keys(marks),
        onScreen: Object.keys(onScreen),
        booting: Boolean(document.querySelector('[data-slot="boot-loader"]')),
        composing: Boolean(document.querySelector('[data-slot="composing-badge"]')),
        complete: document.readyState === 'complete',
        inflight,
        resources: performance.getEntriesByType('resource').length,
        quietMs: now() - lastActivity,
        sinceStart: now() - stepStart,
      };
    },

    read(endMark) {
      const final = onScreen['paint-final'] ?? onScreen['paint-cached'] ?? marks[endMark]?.at(-1) ?? (stepStart === 0 ? bootGone : undefined);
      const end = final ?? now();
      const resources = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= stepStart);
      const classes = {};
      for (const entry of resources) {
        const name = classify(entry.name);
        const group = (classes[name] ??= { requests: 0, bytes: 0, start: Infinity, end: 0 });
        group.requests += 1;
        group.bytes += entry.transferSize;
        group.start = Math.min(group.start, entry.startTime);
        group.end = Math.max(group.end, entry.responseEnd);
      }
      const shellEnd = marks['env-ready']?.[0];
      const shellEntries = resources.filter((entry) => classify(entry.name) === 'shell' && (shellEnd === undefined || entry.startTime < shellEnd));
      const network = {};
      for (const [name, group] of Object.entries(classes)) {
        network[name] = { requests: group.requests, bytes: group.bytes, startMs: relative(group.start), endMs: relative(group.end) };
      }

      const gaps = [];
      let previous = null;
      for (const frame of frames) {
        if (frame < stepStart) continue;
        if (previous !== null && frame <= end) gaps.push(frame - previous);
        previous = frame;
      }
      const tasksIn = (from, to) => longTasks.filter((task) => task.start + task.ms > from && task.start < to);
      const blocking = (tasks) => tasks.reduce((sum, task) => sum + Math.max(0, task.ms - 50), 0);
      const during = tasksIn(stepStart, end);
      const after = tasksIn(end, Infinity);

      const counter = (name) => ({ ms: round(counters[name]?.ms ?? 0), n: counters[name]?.n ?? 0, maxMs: round(counters[name]?.max ?? 0) });
      const navigation = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const firstMark = (name) => relative(marks[name]?.[0]);
      const lastMark = (name) => relative(marks[name]?.at(-1));
      return {
        finalMs: round(final === undefined ? undefined : final - stepStart),
        bootGoneMs: stepStart === 0 ? round(bootGone) : undefined,
        weaponMs: relative(onScreen['weapon-shown']),
        previewMs: relative(onScreen['paint-preview']),
        previewCount: marks['paint-preview']?.length ?? 0,
        documentMs: stepStart === 0 ? round(navigation?.responseEnd) : undefined,
        connectMs: stepStart === 0 ? round(navigation?.connectEnd) : undefined,
        shellEndMs: shellEntries.length ? relative(Math.max(...shellEntries.map((entry) => entry.responseEnd))) : undefined,
        domReadyMs: stepStart === 0 ? round(navigation?.domContentLoadedEventEnd) : undefined,
        fcpMs: stepStart === 0 ? round(fcp?.startTime) : undefined,
        envReadyMs: firstMark('env-ready'),
        assetsReadyMs: firstMark('assets-ready'),
        composeStartMs: firstMark('compose-start'),
        sourcesReadyMs: lastMark('sources-ready'),
        composeEndMs: lastMark('compose-end'),
        modelParseMs: round(modelParseMs),
        modelParses,
        decode: {
          n: decodes.length,
          wallMs: round(unionMs(decodes)),
          firstStartMs: decodes.length ? relative(Math.min(...decodes.map((d) => d.start))) : undefined,
          lastEndMs: decodes.length ? relative(Math.max(...decodes.map((d) => d.end))) : undefined,
        },
        upload: {
          bitmap: counter('uploadBitmap'),
          image: counter('uploadImage'),
          canvas: counter('uploadCanvas'),
          data: counter('uploadData'),
          storage: counter('uploadStorage'),
          mips: counter('mips'),
        },
        geometry: counter('geometry'),
        compile: counter('compile'),
        compileWaitMs: round(unionMs(linkSpans)),
        programs: linkSpans.length,
        drawTarget: counter('drawTarget'),
        drawScreen: counter('drawScreen'),
        network,
        requests: resources.length,
        bytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
        worstFrameMs: round(gaps.length ? Math.max(...gaps) : 0),
        framesOver50: gaps.filter((gap) => gap > 50).length,
        longTasks: during.length,
        longestTaskMs: round(during.length ? Math.max(...during.map((task) => task.ms)) : 0),
        blockingMs: round(blocking(during)),
        blockingAfterMs: round(blocking(after)),
      };
    },

    resources() {
      return performance.getEntriesByType('resource').filter((entry) => entry.startTime >= stepStart).map((entry) => ({
        url: new URL(entry.name).pathname,
        bytes: entry.transferSize,
        decoded: entry.decodedBodySize,
        startMs: round(entry.startTime - stepStart),
        endMs: round(entry.responseEnd - stepStart),
      }));
    },

    /** A digest of the exact pixels of the composite the app just put on the weapon, read from its own render target. */
    compositeHash() {
      if (!window.__perfPaint) return null;
      const { renderer, target } = window.__perfPaint;
      const { width, height } = target;
      const pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      let hash = 0x811c9dc5;
      const words = new Uint32Array(pixels.buffer);
      for (let i = 0; i < words.length; i += 1) hash = Math.imul(hash ^ words[i], 0x01000193);
      return `${width}x${height}:${(hash >>> 0).toString(16)}`;
    },

    gpu() {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown', cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory };
    },
  };
})();
