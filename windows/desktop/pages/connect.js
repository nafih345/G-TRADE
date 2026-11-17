'use strict';
const api = window.gtradeDesktop;
const $ = (id) => document.getElementById(id);
const say = (text, ok) => { $('message').textContent = text; $('message').className = ok ? 'ok' : 'error'; };
let probed = null;

$('check').addEventListener('click', async () => {
  say('Checking…', true);
  $('confirm').hidden = true;
  try {
    probed = await api.connection.probe($('server').value);
    $('fingerprint').textContent = probed.caFingerprint;
    $('confirm').hidden = false;
    say('Compare the fingerprint with the connection sheet, then type the pairing code.', true);
    $('code').focus();
  } catch (e) {
    say(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), false);
  }
});

$('pair').addEventListener('click', async () => {
  if (!probed) return;
  say('Connecting…', true);
  try {
    await api.connection.pair(probed.serverUrl, $('code').value);
    say('Connected.', true);
  } catch (e) {
    say(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), false);
  }
});

$('local').addEventListener('click', async () => {
  try {
    await api.connection.useMachineDefault();
  } catch (e) {
    say(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), false);
  }
});

$('server').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('check').click(); });
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pair').click(); });
