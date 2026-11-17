import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_UI_SCALE, UI_SCALE_OPTIONS, isSupportedScale, scaleBridge } from '../utils/uiScale';

// Current interface size from the desktop shell; `supported` is false in a plain browser.
export default function useUiScale() {
  const bridge = scaleBridge();
  const [info, setInfo] = useState({ scale: DEFAULT_UI_SCALE, defaultScale: DEFAULT_UI_SCALE, options: UI_SCALE_OPTIONS });

  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    bridge.get().then((i) => { if (alive && i) setInfo(i); }).catch(() => {});
    const off = typeof bridge.onChange === 'function' ? bridge.onChange((i) => { if (i) setInfo(i); }) : () => {};
    return () => { alive = false; off(); };
  }, [bridge]);

  const setScale = useCallback(async (scale) => {
    if (!bridge || !isSupportedScale(scale)) return;
    try { setInfo(await bridge.set(scale)); } catch { /* the shell refused it: keep the current size */ }
  }, [bridge]);

  return { supported: Boolean(bridge), ...info, setScale, resetScale: () => setScale(info.defaultScale ?? DEFAULT_UI_SCALE) };
}
