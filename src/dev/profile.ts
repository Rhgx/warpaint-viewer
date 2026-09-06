// Opt-in frame pacing probe for manual interaction recordings. This measures
// browser frame intervals and long tasks, not GPU execution or utilization.
const panel = document.createElement('details');
panel.open = true;
panel.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:10000;background:#202227;color:#eee;padding:8px;max-width:420px;font:12px monospace';
const summary = document.createElement('summary');
summary.textContent = 'Frame profile';
const name = document.createElement('input');
name.setAttribute('aria-label', 'Profile scenario');
name.value = 'idle';
const button = document.createElement('button');
button.textContent = 'Start recording';
const cycleButton = document.createElement('button');
cycleButton.textContent = 'Record weapon cycle';
const output = document.createElement('pre');
output.style.cssText = 'max-height:200px;overflow:auto;white-space:pre-wrap';
panel.append(summary, name, button, cycleButton, output);
document.body.append(panel);
let raf = 0;
let recording = false;
let previous = 0;
let started = 0;
let intervals: number[] = [];
let longTasks: number[] = [];
let cycleTimer = 0;
const supportsLongTasks = PerformanceObserver.supportedEntryTypes.includes('longtask');
const observer = new PerformanceObserver((list) => {
  longTasks.push(...list.getEntries().map((entry) => entry.duration));
});
function sample(time: number) {
  if (time - started >= 60_000) { stop(); return; }
  if (previous) intervals.push(time - previous);
  previous = time;
  raf = requestAnimationFrame(sample);
}
function stop() {
  if (!recording) return;
  recording = false;
  clearTimeout(cycleTimer);
  cycleButton.disabled = false;
  cancelAnimationFrame(raf);
  longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
  observer.disconnect();
  intervals.sort((a, b) => a - b);
  const rounded = (value: number) => Math.round(value * 10) / 10;
  const percentile = (fraction: number) => rounded(intervals[Math.max(0, Math.ceil(intervals.length * fraction) - 1)] ?? 0);
  const result = {
    scenario: name.value, seconds: rounded((performance.now() - started) / 1000),
    frames: intervals.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1),
    longTasks: supportsLongTasks ? longTasks.length : null,
    longTaskMs: supportsLongTasks ? rounded(longTasks.reduce((sum, value) => sum + value, 0)) : null,
  };
  output.textContent = JSON.stringify(result) + '\n' + output.textContent;
  button.textContent = 'Start recording';
}
function start() {
  intervals = []; longTasks = []; previous = 0;
  started = performance.now();
  if (supportsLongTasks) observer.observe({ type: 'longtask' });
  recording = true;
  button.textContent = 'Stop recording';
  raf = requestAnimationFrame(sample);
}
button.onclick = () => {
  if (recording) stop(); else start();
};
// Six forward and six backward selections at a fixed cadence, ending at the
// starting weapon. Repeat once to warm assets before comparing recordings.
cycleButton.onclick = () => {
  stop();
  let step = 0;
  start();
  cycleButton.disabled = true;
  const advance = () => {
    if (step === 12) { stop(); return; }
    const label = step < 6 ? 'Next weapon' : 'Previous weapon';
    const control = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!control || control.disabled) { stop(); return; }
    control.click();
    step += 1;
    cycleTimer = window.setTimeout(advance, 350);
  };
  cycleTimer = window.setTimeout(advance, 350);
};
const onVisibilityChange = () => { if (document.hidden) stop(); };
document.addEventListener('visibilitychange', onVisibilityChange);
import.meta.hot?.dispose(() => {
  stop();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  panel.remove();
});
