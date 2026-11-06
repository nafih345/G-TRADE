import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { PRICING_LIVE_OFFERS_API, indexOffers } from '../utils/pricingRules';

// Settings → Pricing Rules & Offers on the sales screens: the running offers (with how many offer
// units are left) for the "On Offer" badges and offer-barcode scans. Reloads when the window
// regains focus, when stock moves anywhere (`optical_stock_updated`) and on refresh() — e.g.
// after each completed sale, since that is what uses offer units up. Never blocks the screen:
// a failed load just shows no offers (the server still checks every save).
export default function useLiveOffers() {
  const [state, setState] = useState({ enabled: false, offers: [] });
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { data } = await axios.get(PRICING_LIVE_OFFERS_API);
      if (mine === seq.current) setState({ enabled: !!data?.offers_enabled, offers: data?.offers || [] });
    } catch { /* keep the last list */ }
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('optical_stock_updated', refresh);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('optical_stock_updated', refresh);
    };
  }, [refresh]);

  const index = useMemo(() => indexOffers(state.offers), [state.offers]);
  return { enabled: state.enabled, offers: state.offers, index, refresh };
}
