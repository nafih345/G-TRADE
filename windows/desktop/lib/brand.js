'use strict';
// Customer-facing product name of the Windows edition. Display text only.
//
// Internal identifiers deliberately keep their G-TRADE names for install/upgrade compatibility and
// must NOT follow this constant: appId com.gtrade.erp, executable G-TRADE.exe, install folder
// C:\Program Files\G-TRADE, NSIS guid, data folder C:\ProgramData\G-TRADE, gtrade_ctl/gtrade_server,
// the gtrade database/user and the GTRADE_* environment variables.

const PRODUCT_NAME = 'G OPTICALS';

// Electron derives userData (%APPDATA%\<productName>) from productName. It holds the user's chosen
// server connection (pinned CA) and window state, so it stays in the folder used before the rename.
const LEGACY_USER_DATA_DIRNAME = 'G-TRADE ERP';

module.exports = { PRODUCT_NAME, LEGACY_USER_DATA_DIRNAME };
