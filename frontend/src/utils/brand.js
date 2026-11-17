// Product branding shown on the login screen, sidebar/dashboard and browser tab.
// The Windows local edition (VITE_EDITION=local) is the "G OPTICALS" product; the hosted cloud build
// keeps its existing Greensol branding. The emblem (eye mark in GreensolLogo / the favicon) is the
// same official mark in both - only the wordmark text differs. The browser-tab <title> for the local
// build is rewritten in vite.config.js (LOCAL_PRODUCT_NAME there must match PRODUCT_NAME here).
import { IS_LOCAL_EDITION } from './edition';

const LOCAL = {
  productName: 'G OPTICALS',
  wordmark: 'G OPTICALS',
  wordmarkCaps: 'G OPTICALS',
  tagline: 'Optical ERP',
  copyrightHolder: 'G OPTICALS',
};

const CLOUD = {
  productName: 'Greensol Optical ERP',
  wordmark: 'Greensol',
  wordmarkCaps: 'GREENSOL',
  tagline: 'Optical ERP',
  copyrightHolder: 'Greensol',
};

export const BRAND = IS_LOCAL_EDITION ? LOCAL : CLOUD;
export const LOCAL_BRAND = LOCAL;
export const CLOUD_BRAND = CLOUD;
export default BRAND;
