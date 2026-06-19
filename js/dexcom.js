import { storage } from './storage.js';
import { mgdlToMmol } from './calculator.js';

const ENDPOINTS = {
  us:            'https://share2.dexcom.com',
  international: 'https://shareous1.dexcom.com'
};

const APP_ID = 'd8665ade-9673-4e27-9ff6-92db4ce13d13';

const TREND_MAP = {
  1: '⇈', 2: '↑', 3: '↗', 4: '→', 5: '↘', 6: '↓', 7: '⇊'
};

let sessionId = null;

async function getSession() {
  const config = storage.get('dexcom_config', {});
  const { user, pass, region = 'us' } = config;
  if (!user || !pass) throw new Error('Dexcom credentials not configured');

  const base = ENDPOINTS[region] || ENDPOINTS.us;

  const resp = await fetch(
    `${base}/ShareWebServices/Services/General/LoginPublisherAccountByName`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountName: user, password: pass, applicationId: APP_ID })
    }
  );

  if (!resp.ok) throw new Error(`Dexcom login failed: ${resp.status}`);
  const id = await resp.json();
  if (!id || id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('Invalid Dexcom credentials');
  }
  sessionId = id;
  return id;
}

export async function fetchBG(units) {
  const config = storage.get('dexcom_config', {});
  const base = ENDPOINTS[config.region || 'us'];

  if (!sessionId) await getSession();

  const resp = await fetch(
    `${base}/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&count=1&minutes=1440`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );

  if (resp.status === 500) {
    sessionId = null;
    const sid = await getSession();
    return fetchBG(units);
  }

  if (!resp.ok) throw new Error(`Dexcom fetch failed: ${resp.status}`);
  const readings = await resp.json();

  if (!readings || readings.length === 0) throw new Error('No Dexcom reading available');

  const r = readings[0];
  const mgdl = r.Value;
  const value = units === 'mmol' ? mgdlToMmol(mgdl) : mgdl;
  const timestamp = new Date(parseInt(r.WT.replace(/\/Date\((\d+)\)\//, '$1')));

  return { value, timestamp, trend: TREND_MAP[r.Trend] || '→', raw: mgdl };
}

export async function testConnection() {
  await getSession();
  return true;
}