import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAppPrintPreview, printFrame } from '../desktopPrint.js';

const fakePopup = () => {
  const calls = [];
  let release;
  const previewClosed = new Promise((r) => { release = r; });
  return {
    calls,
    release,
    document: { open: () => calls.push('open'), write: (h) => calls.push(['write', h]), close: () => calls.push('doc-close') },
    print: () => { calls.push('print'); return previewClosed; },
    close: () => calls.push('closed'),
  };
};

test('browser (no desktop bridge): the iframe prints itself, no pop-up', async () => {
  const calls = [];
  const frame = { contentWindow: { focus: () => calls.push('focus'), print: () => calls.push('print') } };
  const opened = [];
  assert.equal(hasAppPrintPreview(null), false);
  assert.equal(await printFrame(frame, { bridge: null, openWindow: (...a) => opened.push(a) }), true);
  assert.deepEqual(calls, ['focus', 'print']);
  assert.equal(opened.length, 0);
  assert.equal(await printFrame(null, { bridge: null }), false);
});

test('desktop app: the frame document is printed from a pop-up, which closes with the preview', async () => {
  const bridge = { printPreview: () => Promise.resolve() };
  assert.equal(hasAppPrintPreview(bridge), true);
  const popup = fakePopup();
  const opened = [];
  const frameCalls = [];
  const frame = { contentWindow: { print: () => frameCalls.push('frame-print') } };
  const html = '<!doctype html><html><head><title>Eye Test Report</title></head><body>R</body></html>';
  const started = await printFrame(frame, { html, bridge, delayMs: 0, openWindow: (...a) => { opened.push(a); return popup; } });
  assert.equal(started, true);
  assert.deepEqual(opened, [['', '_blank', 'width=900,height=950']]);
  assert.deepEqual(popup.calls.slice(0, 4), ['open', ['write', html], 'doc-close', 'print']);
  assert.equal(frameCalls.length, 0, 'the iframe itself is not printed (it would reach the Windows dialog)');
  assert.ok(!popup.calls.includes('closed'), 'pop-up stays while the preview is open');
  popup.release({ outcome: 'printed' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(popup.calls.at(-1), 'closed');
});

test('desktop app: falls back to the frame\'s own markup, and reports a blocked pop-up', async () => {
  const bridge = { printPreview: () => Promise.resolve() };
  const popup = fakePopup();
  const frame = { contentDocument: { documentElement: { outerHTML: '<html><body>x</body></html>' } } };
  await printFrame(frame, { bridge, delayMs: 0, openWindow: () => popup });
  assert.deepEqual(popup.calls[1], ['write', '<!DOCTYPE html><html><body>x</body></html>']);
  assert.equal(await printFrame(frame, { bridge, delayMs: 0, openWindow: () => null }), false);
  assert.equal(await printFrame({}, { bridge, delayMs: 0, openWindow: () => popup }), false);
});
