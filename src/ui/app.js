// NEBULA Rover OS: the demo page.
//
// Flow: orbit -> callsign + region -> Jezero Surface Atlas (circular map) ->
// waypoint / science-target inspector -> route briefing (engine) -> descent ->
// third-person drive -> add a science stop (engine) -> arrival -> return to
// base (engine) -> mission summary -> new mission.
//
// The visual design is Naser's Rover OS (frontend af3c7da). The data behind it
// is the integrated route engine. HONESTY RULES this file follows:
//   - Every route number (distance, time, energy, scores, verdicts, reasons,
//     reserves) comes from the route engine via POST /api/routes. This file
//     never calculates a score or a verdict itself.
//   - ONE simulated mission state (clock, battery, position) spends the
//     engine's own minutes and kWh as time passes. Both views (drive view and
//     map) read that same state.
//   - Labels say which values are OBSERVED (NASA data), DERIVED (calculated
//     from that data by the engine or from the real coordinates), SIMULATED
//     (this playback) or EDITORIAL (the team's science rubric).
//   - No oxygen, temperature or weather values: we have no data for them.

import { mountMarsMap } from './adapters/mars-map.js';
import { createApiClient } from './api-client.js';
import { makePath, pointAt, headingAt, angleDiff, nextManeuver, distanceOfPoint, indexAt, lonLatAt } from './local-path.js';
import { drawOrbit, drawSurface, drawRadar } from './scene.js';

const $ = (id) => document.getElementById(id);
const api = createApiClient();
const L = window.L;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Small helpers (text is always inserted as text, never parsed as HTML).
// ---------------------------------------------------------------------------
function el(tagName, attributes = {}, ...children) {
  const node = document.createElement(tagName);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// OBSERVED / DERIVED / SIMULATED / EDITORIAL label.
const tag = (kind) => el('em', { class: `tag tag-${kind.toLowerCase()}` }, kind);

// Unknown (null) values are shown as "Unknown", never as 0.
const fmt = (value, digits = 1, unit = '') =>
  Number.isFinite(value) ? `${value.toFixed(digits)}${unit ? ' ' + unit : ''}` : 'Unknown';

const findReason = (candidate, prefix) => candidate?.reasons.find((r) => r.startsWith(prefix)) ?? null;
const ROLE_PREFIXES = ['Recommended', 'Fastest', 'Science-focused'];
const rolesOf = (candidate) => ROLE_PREFIXES.filter((role) => findReason(candidate, role + ':'));
const isDetour = (candidate) => candidate.id.includes('+detour-');
const problemReasons = (candidate) => candidate.reasons.filter((r) =>
  r.startsWith('Not enough') || r.includes('exceeds') || r.startsWith('No return path') || r.includes('UNVERIFIED'));

// Which target a detour candidate adds, and in which order (from the engine's
// own reason text: 'Optional science detour (stop on the way ...) to "7_1172"').
function detourInfo(candidate) {
  const reason = findReason(candidate, 'Optional science detour');
  if (!reason) return null;
  const id = /to "([^"]+)"/.exec(reason)?.[1];
  if (!id) return null;
  return { id, onTheWay: reason.includes('stop on the way'), reason };
}

// "After returning to base: 6.73 kWh above ...; 72.2 min above ..." -> numbers.
function parseReserve(candidate) {
  const text = findReason(candidate, 'Return reserve:');
  if (!text) return { text: null, minutes: null, kWh: null };
  const minutes = /([\d.]+) min (above|short)/.exec(text);
  const kWh = /([\d.]+) kWh (above|short)/.exec(text);
  return {
    text,
    minutes: minutes ? Number(minutes[1]) * (minutes[2] === 'short' ? -1 : 1) : null,
    kWh: kWh ? Number(kWh[1]) * (kWh[2] === 'short' ? -1 : 1) : null,
  };
}

const clock = (minutes) => {
  const total = Math.max(0, Math.round(minutes * 60));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

function notify(message) {
  const n = $('notice');
  n.textContent = message;
  n.style.display = 'block';
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { n.style.display = 'none'; }, 4200);
}
const announce = (message) => { $('announcer').textContent = message; };

// ---------------------------------------------------------------------------
// App state.
// ---------------------------------------------------------------------------
const state = {
  scene: 'orbit',        // orbit | setup | atlas | descent | drive
  callsign: '',
  region: null,
  config: null,
  targets: new Map(),    // id -> target properties + {lat, lon}
  elevations: null,      // "lon,lat" -> elevation (m) from the recorded traverse
  map: null,
  layers: {},
  selectedTargetId: null,
  briefing: null,        // {targetId, result, selectedId}
  mission: null,
  mapOpenDuringDrive: false,
};

const basePoint = () => ({ lat: state.region.base.lat, lon: state.region.base.lon });
const targetPoint = (id) => ({ lat: state.targets.get(id).lat, lon: state.targets.get(id).lon });
const targetName = (id) => state.targets.get(id)?.name ?? id;
const startBattery = () => (state.config.batteryCapacityKWh * state.config.startChargePercent) / 100;

// ---------------------------------------------------------------------------
// Screens.
// ---------------------------------------------------------------------------
function show(scene) {
  state.scene = scene;
  $('intro').hidden = scene !== 'orbit';
  $('setup').hidden = scene !== 'setup';
  $('atlas').hidden = !(scene === 'atlas' || (scene === 'drive' && state.mapOpenDuringDrive));
  $('descent').hidden = scene !== 'descent';
  $('hud').hidden = !(scene === 'drive' && !state.mapOpenDuringDrive);
  const orbital = scene === 'orbit' || scene === 'setup';
  $('orbitalImage').hidden = !orbital;
  $('orbitCredit').hidden = !orbital;
  $('orbitalImage').classList.toggle('distant', scene === 'setup');
  $('atlas').classList.toggle('tracking', scene === 'drive');
  $('backToDrive').hidden = scene !== 'drive';
  $('backOrbit').hidden = scene === 'drive';
  if (!$('atlas').hidden) requestAnimationFrame(() => state.map?.resize());
}

$('enter').onclick = () => { show('setup'); $('callsign').focus(); };
$('setupBack').onclick = () => show('orbit');
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    notify('Use your browser\'s full-screen option for an immersive view.');
  }
};

// ---------------------------------------------------------------------------
// 2. Crew and region.
// ---------------------------------------------------------------------------
const PREVIEW_REGIONS = [
  { name: 'Gale Crater', note: 'Preview · coming soon · no data loaded' },
  { name: 'Utopia Planitia', note: 'Preview · coming soon · no data loaded' },
];

function renderRegionCards() {
  const cards = $('regionCards');
  cards.replaceChildren();
  if (state.region) {
    cards.append(el('label', { class: 'region-card available' },
      el('input', { type: 'radio', name: 'region', value: state.region.id, checked: true }),
      el('b', {}, state.region.name),
      el('small', {}, state.region.status === 'demo' ? 'Available · real NASA Perseverance traverse' : 'Preview')));
  } else {
    cards.append(el('p', { class: 'fine' }, 'Loading region data…'));
  }
  for (const preview of PREVIEW_REGIONS) {
    cards.append(el('label', { class: 'region-card preview', 'aria-disabled': 'true' },
      el('input', { type: 'radio', name: 'region', disabled: true }),
      el('b', {}, preview.name),
      el('small', {}, preview.note)));
  }
}

$('callsign').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('enterRegion').click(); });
$('enterRegion').onclick = () => {
  const callsign = $('callsign').value.trim().slice(0, 24);
  if (!callsign) {
    $('setupError').textContent = 'Enter a crew callsign first.';
    $('callsign').focus();
    return;
  }
  if (!state.region || state.region.status !== 'demo') {
    $('setupError').textContent = 'Region data is not loaded yet. Check the connection and try again.';
    return;
  }
  $('setupError').textContent = '';
  state.callsign = callsign;
  $('crewTag').textContent = `CREW ${callsign}`; // textContent: never parsed as HTML
  $('crewTag').hidden = false;
  $('descentCall').textContent = callsign.toUpperCase();
  show('atlas');
  mountMap();
};

// ---------------------------------------------------------------------------
// Data loading.
// ---------------------------------------------------------------------------
async function loadTargets() {
  const response = await fetch('/map-data/targets.geojson');
  if (!response.ok) throw new Error('Science target catalog unavailable.');
  const catalog = await response.json();
  return new Map(catalog.features.map(({ geometry, properties }) => {
    const [lon, lat] = geometry.coordinates;
    return [properties.id, { ...properties, lat, lon }];
  }));
}

async function loadEverything() {
  try {
    const [config, region, targets] = await Promise.all([api.getConfig(), api.getRegion(), loadTargets()]);
    state.config = config.config;
    state.region = region;
    state.targets = targets;
  } catch (error) {
    $('setupError').textContent = `Cannot load mission data: ${error.message}`;
  }
  renderRegionCards();
}

// Elevation of each recorded traverse vertex (for the HUD only). Values above
// -100 m are the dataset's no-data marker and become null, never 0.
async function loadElevations() {
  if (state.elevations) return;
  try {
    const response = await fetch('/api/map-data/rover-path');
    if (!response.ok) return;
    const layer = await response.json();
    const lookup = new Map();
    for (const feature of layer.features) {
      const elevations = feature.properties?.elevations ?? [];
      feature.geometry.coordinates.forEach(([lon, lat], i) => {
        const e = elevations[i];
        const key = `${lon},${lat}`;
        if (!lookup.has(key)) lookup.set(key, Number.isFinite(e) && e < -100 ? e : null);
      });
    }
    state.elevations = lookup;
  } catch {
    state.elevations = null; // the HUD shows "Unknown"
  }
}

// ---------------------------------------------------------------------------
// 3. Jezero Surface Atlas.
// ---------------------------------------------------------------------------
async function mountMap() {
  if (state.map) { state.map.overview(); return; }
  try {
    state.map = await mountMarsMap({
      container: $('mars-map'),
      region: state.region,
      onSelect: (point, properties) => onWaypointSelected(point, properties),
      onStatus: (message) => { $('mapDataLabel').textContent = message + ' · OBSERVED NASA data'; },
    });
  } catch (error) {
    $('mapLoading').textContent = 'Jezero map unavailable. ' + error.message;
    return;
  }
  $('mars-map').hidden = false;
  $('mapLoading').hidden = true;
  $('mapDataLabel').hidden = false;
  $('waypointDirectory').hidden = false;
  const map = state.map.getMap();
  state.layers.route = L.layerGroup().addTo(map);
  state.layers.targets = L.layerGroup().addTo(map);

  // Base: a simulated scenario element at the real landing coordinates.
  const { base } = state.region;
  L.marker([base.lat, base.lon], {
    icon: L.divIcon({ className: 'base-icon', html: '<span>⌂</span>', iconSize: [30, 30] }),
    keyboard: false,
  }).bindTooltip(`${base.label}`).addTo(state.layers.targets);

  for (const target of state.targets.values()) {
    L.marker([target.lat, target.lon], {
      icon: L.divIcon({ className: 'target-icon', html: '<span>◆</span>', iconSize: [30, 30] }),
      title: `Science target: ${target.name}`,
    }).bindTooltip(`Science target · ${target.name}`)
      .on('click', () => state.map.selectWaypoint(target.id))
      .addTo(state.layers.targets);
  }
  renderTargetChips();
  renderWaypointOptions();
  requestAnimationFrame(() => state.map.overview());
  loadElevations();
}

function renderTargetChips() {
  $('targetChips').replaceChildren(
    el('span', { class: 'micro' }, 'SCIENCE TARGETS'),
    ...[...state.targets.values()].map((t) =>
      el('button', { class: 'chip', onclick: () => state.map.selectWaypoint(t.id) }, `◆ Sol ${t.sol}`)));
}

function renderWaypointOptions() {
  if (!state.map) return;
  const search = $('waypointSearch').value.trim().toLowerCase();
  const options = [new Option('Choose a waypoint', '')];
  for (const { properties } of state.map.waypoints) {
    const { RMC, sol } = properties;
    const label = `Sol ${sol} · ${RMC}${state.targets.has(RMC) ? ' · science target' : ''}`;
    if (!search || label.toLowerCase().includes(search)) options.push(new Option(label, RMC));
  }
  if (options.length === 1 && search) options[0].textContent = 'No matching waypoints';
  else if (search) options[0].textContent = `${options.length - 1} matching waypoints`;
  $('waypointSelect').replaceChildren(...options);
}
$('waypointSearch').oninput = renderWaypointOptions;
$('waypointSearch').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = $('waypointSelect').options[1];
  if (first) state.map.selectWaypoint(first.value);
});
$('waypointSelect').onchange = (event) => event.target.value && state.map.selectWaypoint(event.target.value);

$('atlasZoomIn').onclick = () => state.map?.zoomIn();
$('atlasZoomOut').onclick = () => state.map?.zoomOut();
$('atlasLanding').onclick = () => {
  if (state.scene === 'drive') return recenterOnRover();
  closeInspector();
  state.map?.overview();
};
$('backOrbit').onclick = () => { closeInspector(); show('orbit'); };
$('collapseSector').onclick = () => (state.scene === 'drive' ? closeTrackingMap() : closeInspector());

// replaceChildren would print null as the text "null", so drop empty parts.
const present = (children) => children.filter((child) => child !== null && child !== undefined && child !== false);

function openInspector(...children) {
  $('sectorBody').replaceChildren(...present(children));
  $('sectorPanel').classList.add('revealed');
  $('sectorPanel').scrollTop = 0;
  $('atlas').classList.add('focused');
}
function closeInspector() {
  $('sectorPanel').classList.remove('revealed', 'briefing');
  $('atlas').classList.remove('focused');
  $('atlasFocusLabel').textContent = 'SELECT A WAYPOINT';
  $('waypointSelect').value = '';
  state.selectedTargetId = null;
  state.briefing = null;
  state.layers.route?.clearLayers();
}

const formatPoint = ({ lat, lon }) =>
  `${Math.abs(lat).toFixed(6)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(6)}° ${lon < 0 ? 'W' : 'E'}`;

function fact(label, value, kind) {
  return el('div', {}, el('dt', {}, label, ' ', kind ? tag(kind) : null), el('dd', {}, value));
}

function measurement(value, unit, scale = 1, digits = 1) {
  return Number.isFinite(value) && value !== -9999 && value !== 0 ? `${(value / scale).toFixed(digits)} ${unit}` : 'Not recorded';
}

// Marker click or Waypoint Finder: the adapter flies to the point, then calls this.
function onWaypointSelected(point, properties) {
  if (state.scene === 'drive') return; // during a drive, stops are added from the HUD
  $('waypointSelect').value = properties.RMC;
  $('atlasFocusLabel').textContent = formatPoint(point);
  if (state.targets.has(properties.RMC)) return showTarget(properties.RMC, properties);
  state.selectedTargetId = null;
  state.layers.route?.clearLayers();
  $('sectorPanel').classList.remove('briefing');
  openInspector(
    el('p', { class: 'micro' }, 'PERSEVERANCE WAYPOINT'),
    el('h3', {}, `Sol ${properties.sol} · ${properties.RMC}`),
    el('p', {}, formatPoint(point)),
    el('dl', { class: 'waypoint-facts' },
      fact('Site / drive', `${properties.site ?? '?'} / ${properties.drive ?? '?'}`, 'OBSERVED'),
      fact('Elevation (units/datum unverified)', measurement(properties.elev_geoid, 'm'), 'OBSERVED'),
      fact('Distance from previous record', measurement(properties.dist_m, 'm'), 'OBSERVED'),
      fact('Total rover distance', measurement(properties.dist_total_m, 'km', 1000, 2), 'OBSERVED')),
    el('p', { class: 'micro' }, 'NASA LOCALIZATION NOTE'),
    el('p', { class: 'note' }, properties.Note || 'NASA supplied no localization note.'),
    el('div', { class: 'waypoint-sources' },
      el('a', { href: `https://mars.nasa.gov/mars2020/multimedia/raw-images/?begin_sol=${properties.sol}&end_sol=${properties.sol}`, target: '_blank', rel: 'noopener noreferrer' }, `Browse NASA photos from Sol ${properties.sol} ↗`),
      el('a', { href: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json', target: '_blank', rel: 'noopener noreferrer' }, 'NASA waypoint dataset ↗')),
    el('p', { class: 'fine' }, 'Route planning is available for the three curated science targets (◆). Choose one with the chips or the finder.'),
  );
}

// Curated science target inspector.
function showTarget(id, properties = null) {
  const target = state.targets.get(id);
  state.selectedTargetId = id;
  state.layers.route?.clearLayers();
  $('sectorPanel').classList.remove('briefing');
  const image = target.imageUrl
    ? el('figure', { class: 'waypoint-photo' },
        el('img', { src: target.imageUrl, alt: `Perseverance Navcam image, sol ${target.sol}`, loading: 'lazy' }),
        el('figcaption', {}, `Perseverance Navcam, sol ${target.sol} · ${target.imageCredit ?? 'NASA/JPL-Caltech'} · matched by site/drive id in the file name`))
    : null;
  openInspector(
    el('p', { class: 'micro' }, 'SCIENCE TARGET'),
    el('h3', {}, target.name),
    image,
    el('dl', { class: 'waypoint-facts' },
      fact('Coordinates', formatPoint(target), 'OBSERVED'),
      fact('Waypoint (site_drive)', `${target.id} · sol ${target.sol}`, 'OBSERVED'),
      properties ? fact('Elevation (units/datum unverified)', measurement(properties.elev_geoid, 'm'), 'OBSERVED') : null,
      fact('Science value', `${target.scienceValue} / 3`, 'EDITORIAL'),
      fact('Planned dwell', `${target.stopMinutes} min`, 'EDITORIAL')),
    el('p', {}, target.summary),
    el('p', { class: 'note' }, el('b', {}, 'Why it matters: '), target.scienceRationale),
    el('p', { class: 'fine' }, 'Science value is the team\'s 1-3 editorial rubric, not a NASA measurement.'),
    el('div', { class: 'waypoint-sources' }, ...(target.sourceUrls ?? []).map((url) =>
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Source ↗'))),
    el('button', { class: 'enter', onclick: () => compareRoutes(id) }, 'COMPARE ROUTES ', el('span', {}, '→')),
  );
}

// ---------------------------------------------------------------------------
// Route layer on the atlas (outbound solid, return dashed).
// ---------------------------------------------------------------------------
function drawRoute(candidate, { preview = false, fit = false } = {}) {
  const group = state.layers.route;
  if (!group) return;
  group.clearLayers();
  const toLatLng = ([lon, lat]) => [lat, lon];
  const lines = [];
  if (candidate.geometry?.length > 1) {
    lines.push(L.polyline(candidate.geometry.map(toLatLng), { color: preview ? '#c9b8ff' : '#ffe45c', weight: 5, opacity: 0.95, dashArray: preview ? '2 7' : null }).addTo(group));
  }
  if (candidate.returnGeometry?.length > 1) {
    lines.push(L.polyline(candidate.returnGeometry.map(toLatLng), { color: '#ffffff', weight: 3, opacity: 0.85, dashArray: '6 8' }).addTo(group));
  }
  if (fit && lines.length) {
    const bounds = L.featureGroup(lines).getBounds();
    if (bounds.isValid()) state.map.getMap().flyToBounds(bounds, { padding: [40, 40], maxZoom: 16, duration: reducedMotion ? 0 : 0.6 });
  }
}

// ---------------------------------------------------------------------------
// Talking to the route engine.
// ---------------------------------------------------------------------------
// Budgets come from the simulated mission if one is running, otherwise the
// full starting budget from config.
function routeRequest({ origin, destination, stopIds = [] }) {
  const { region, config, mission } = state;
  return {
    requestId: crypto.randomUUID(),
    regionId: region.id,
    dataVersion: region.dataVersion,
    origin,
    destination,
    base: basePoint(),
    stopIds,
    remainingMinutes: mission ? Math.max(0, config.missionDurationMinutes - mission.elapsedMin) : config.missionDurationMinutes,
    currentBatteryKWh: mission ? Math.max(0, mission.batteryKWh) : startBattery(),
  };
}

// ---------------------------------------------------------------------------
// 5. Route briefing: selectable route cards (engine results).
// ---------------------------------------------------------------------------
async function compareRoutes(targetId) {
  const target = state.targets.get(targetId);
  $('sectorPanel').classList.add('briefing');
  openInspector(el('p', { class: 'micro' }, 'ROUTE BRIEFING'), el('h3', {}, `Base → ${target.name}`), el('p', {}, 'Asking the route engine…'));
  let result;
  try {
    result = await api.planRoutes(routeRequest({ origin: basePoint(), destination: targetPoint(targetId) }));
  } catch (error) {
    return openInspector(el('p', { class: 'micro' }, 'ROUTE BRIEFING'), el('h3', {}, 'Route engine error'),
      el('p', { class: 'error' }, error.message),
      el('button', { class: 'enter', onclick: () => compareRoutes(targetId) }, 'RETRY ', el('span', {}, '↻')),
      el('button', { class: 'text-button', onclick: () => showTarget(targetId) }, '← Back to target'));
  }
  if (!result || state.selectedTargetId !== targetId) return; // stale
  const firstPass = result.candidates.find((c) => c.feasibility === 'pass' && !isDetour(c));
  state.briefing = { targetId, result, selectedId: (firstPass ?? result.candidates[0])?.id ?? null };
  renderBriefing();
}

function renderBriefing() {
  const { targetId, result, selectedId } = state.briefing;
  const target = state.targets.get(targetId);
  const mains = result.candidates.filter((c) => !isDetour(c));
  const detours = result.candidates.filter(isDetour);
  const selected = result.candidates.find((c) => c.id === selectedId) ?? null;
  const passing = mains.filter((c) => c.feasibility === 'pass');
  if (selected) drawRoute(selected, { preview: selected.feasibility !== 'pass', fit: true });

  const list = el('div', { class: 'route-list', role: 'radiogroup', 'aria-label': 'Route options' });
  const allCards = [...mains, ...detours];
  for (const candidate of allCards) list.append(routeCard(candidate, candidate.id === selectedId, allCards));

  const plan = selected ? startablePlan(selected, targetId) : null;
  openInspector(
    el('button', { class: 'text-button', onclick: () => showTarget(targetId) }, '← Back to target'),
    el('p', { class: 'micro' }, 'ROUTE BRIEFING · ENGINE RESULTS ', tag('DERIVED')),
    el('h3', {}, `Base → ${target.name}`),
    el('p', { class: 'note' }, passing.length === 1
      ? 'One route passed every check, including the trip home. The current traverse data supports a single eligible route to this target; optional science detours are listed as separate choices.'
      : passing.length > 1 ? `${passing.length} routes passed every check, including the trip home. Recommended first.`
        : 'No route to this target passed every check. The engine\'s reasons are on each card.'),
    list,
    ...result.errors.map((message) => el('p', { class: 'error' }, message)),
    el('p', { class: 'fine' }, 'Scores are prototype estimates from the engine: Overall = 70% terrain safety + 30% time. Every plan includes the drive back to base.'),
    plan
      ? el('button', { class: 'enter', id: 'startMission', onclick: () => launchMission(selected, plan) }, 'START MISSION ', el('span', {}, '↗'))
      : el('p', { class: 'error' }, selected ? `This ${selected.feasibility.toUpperCase()} route is a preview only and cannot be started.` : 'No route selected.'),
  );
}

// A selected candidate can start only if it passes and we know its stop order.
function startablePlan(candidate, targetId) {
  if (candidate.feasibility !== 'pass') return null;
  if (!isDetour(candidate)) return { stopIds: [], finalId: targetId };
  const info = detourInfo(candidate);
  if (!info || !state.targets.has(info.id)) return null;
  return info.onTheWay ? { stopIds: [info.id], finalId: targetId } : { stopIds: [targetId], finalId: info.id };
}

function scoreBox(label, value, notApplicable) {
  return el('div', { class: 'score' }, el('b', {}, notApplicable ? 'N/A' : Number.isFinite(value) ? value.toFixed(0) : 'Unknown'),
    el('small', {}, label), Number.isFinite(value) && !notApplicable ? el('i', { style: `width:${Math.max(0, Math.min(100, value))}%` }) : null);
}

function routeCard(candidate, selected, allCards) {
  const roles = rolesOf(candidate);
  const info = detourInfo(candidate);
  const reserve = parseReserve(candidate);
  const zero = candidate.distanceKm === 0;
  const trip = [candidate.driveMinutes, candidate.stopMinutes, candidate.returnMinutes].every(Number.isFinite)
    ? candidate.driveMinutes + candidate.stopMinutes + candidate.returnMinutes : null;
  const title = info ? `+ ${targetName(info.id)}` : roles.length ? 'Direct route' : candidate.feasibility === 'pass' ? 'Route' : 'Alternative start';
  const card = el('div', {
    class: `route-card verdict-${candidate.feasibility}${selected ? ' selected' : ''}`,
    role: 'radio', tabindex: selected ? '0' : '-1', 'aria-checked': selected ? 'true' : 'false',
    'data-id': candidate.id,
  },
    el('div', { class: 'route-card-head' },
      el('b', {}, title),
      el('span', { class: `verdict ${candidate.feasibility}` }, candidate.feasibility === 'pass' ? 'PASS' : candidate.feasibility.toUpperCase())),
    el('div', { class: 'route-result-badges' },
      ...roles.map((r) => el('span', {}, r)),
      info ? el('span', { class: 'detour-badge' }, info.onTheWay ? 'Science detour · on the way' : 'Science detour · extension') : null),
    el('div', { class: 'scores' },
      scoreBox('Terrain safety', candidate.safetyScore, zero),
      scoreBox('Time', candidate.timeScore, false),
      scoreBox('Overall', candidate.overallScore, zero)),
    el('dl', { class: 'metrics' },
      metric('Distance out', fmt(candidate.distanceKm, 2, 'km')),
      metric('Drive out', fmt(candidate.driveMinutes, 1, 'min')),
      metric('Science stops', fmt(candidate.stopMinutes, 0, 'min')),
      metric('Drive back', fmt(candidate.returnMinutes, 1, 'min')),
      metric('Full trip', fmt(trip, 1, 'min')),
      metric('Energy (round trip)', fmt(candidate.totalEnergyKWh, 2, 'kWh')),
      metric('Science value', `${candidate.scienceValue}`),
      metric('Slope data coverage', fmt(candidate.coveragePercent, 0, '%'))),
    reserve.text ? el('p', { class: `reserve ${reserve.minutes !== null && reserve.minutes < 0 ? 'short' : ''}` }, reserve.text) : null,
    ...problemReasons(candidate).map((r) => el('p', { class: 'error' }, r)),
    el('details', {}, el('summary', {}, 'All engine reasons'),
      el('ul', { class: 'reasons' }, ...candidate.reasons.map((r) => el('li', {}, r))),
      el('p', { class: 'fine' }, `Candidate id ${candidate.id}`)),
  );
  const choose = () => { state.briefing.selectedId = candidate.id; renderBriefing(); requestAnimationFrame(() => document.querySelector(`.route-card[data-id="${CSS.escape(candidate.id)}"]`)?.focus()); };
  card.addEventListener('click', (event) => { if (!event.target.closest('details')) choose(); });
  card.addEventListener('mouseenter', () => drawRoute(candidate, { preview: candidate.feasibility !== 'pass' }));
  card.addEventListener('mouseleave', () => {
    const current = allCards.find((c) => c.id === state.briefing?.selectedId);
    if (current) drawRoute(current, { preview: current.feasibility !== 'pass' });
  });
  card.addEventListener('keydown', (event) => {
    const index = allCards.indexOf(candidate);
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); state.briefing.selectedId = allCards[(index + 1) % allCards.length].id; renderBriefing(); focusSelected(); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); state.briefing.selectedId = allCards[(index - 1 + allCards.length) % allCards.length].id; renderBriefing(); focusSelected(); }
  });
  return card;
}
const focusSelected = () => requestAnimationFrame(() => document.querySelector('.route-card.selected')?.focus());

function metric(label, value) {
  return el('div', {}, el('dt', {}, label), el('dd', {}, value));
}

// ---------------------------------------------------------------------------
// 6. Mission: ONE simulation clock and ONE active plan for both views.
// ---------------------------------------------------------------------------
// Playback 1x is a true 1:1 clock: one simulated minute takes one real minute.
// Faster steps only speed up the playback, never the engine's numbers.
const SIM_MINUTES_PER_SECOND = 1 / 60;
const PLAYBACK_SPEEDS = [1, 3, 5, 10, 15];

function launchMission(candidate, plan) {
  state.mission = {
    phase: 'standby',          // standby | navigating | dwelling | arrived | returning | complete
    elapsedMin: 0,
    batteryKWh: startBattery(),
    speed: 1,
    paused: true,
    started: false,
    visited: [],
    routeRevision: 0,
    acceptedChanges: [],
    rejectedProposals: [],
    feed: [],
    yaw: 0,
    turning: null,
    lastManeuverKey: '',
    warnedTime: false,
    warnedBattery: false,
  };
  loadOutboundLeg(candidate, plan.stopIds, plan.finalId);
  const m = state.mission;
  m.yaw = headingAt(m.path, 0, 25) ?? 0;
  m.position = candidate.geometry[0];
  m.camYaw = m.yaw;
  closeInspector();
  ensureRoverMarker();
  drawRoute(candidate);
  logEvent(`Mission loaded: ${plan.stopIds.length ? plan.stopIds.map(targetName).join(' → ') + ' → ' : ''}${targetName(plan.finalId)}`);
  // Descent animation, then the drive view.
  state.descentStart = performance.now();
  show('descent');
  setTimeout(() => {
    if (state.scene !== 'descent') return;
    show('drive');
    renderHud();
    announce('Surface link established. Press Begin drive.');
  }, reducedMotion ? 50 : 4000);
}

// Load a plan as the active OUTBOUND leg.
function loadOutboundLeg(candidate, stopIds, finalId) {
  const m = state.mission;
  m.plan = candidate;
  m.leg = 'outbound';
  m.path = makePath(candidate.geometry, basePoint());
  m.legDriveMinutes = candidate.driveMinutes;
  m.drivenMin = 0;
  m.dwellMin = 0;
  m.finalId = finalId;
  // Driving energy per driven minute on this leg (engine kWh / engine minutes).
  m.driveKWhPerMin = candidate.driveMinutes > 0 ? candidate.outboundEnergyKWh / candidate.driveMinutes : 0;
  m.stops = [...stopIds, finalId].map((id) => {
    const t = state.targets.get(id);
    const s = distanceOfPoint(m.path, [t.lon, t.lat]);
    return { id, s, fraction: m.path.length > 0 ? s / m.path.length : 1, stopMinutes: t.stopMinutes, done: false, dwelling: false };
  });
  m.routeRevision += 1;
}

function loadReturnLeg(candidate) {
  const m = state.mission;
  m.plan = candidate;
  m.leg = 'return';
  m.path = makePath(candidate.returnGeometry, basePoint());
  m.legDriveMinutes = candidate.returnMinutes;
  m.drivenMin = 0;
  m.dwellMin = 0;
  m.stops = [];
  m.driveKWhPerMin = candidate.returnMinutes > 0 ? candidate.returnEnergyKWh / candidate.returnMinutes : 0;
  m.routeRevision += 1;
}

// Distance along the leg (metres of the real path) from the clock.
const legFraction = (m) => (m.legDriveMinutes > 0 ? Math.min(1, m.drivenMin / m.legDriveMinutes) : 1);
const legS = (m) => legFraction(m) * m.path.length;

// The exact traverse vertex at the current distance: re-plans start there.
function syncExactVertex(m) {
  m.position = m.path.geometry[indexAt(m.path, legS(m))] ?? m.position;
}

// Spend `dt` simulated minutes: dwelling at a stop or driving.
function advance(dt) {
  const m = state.mission;
  const auxKWhPerMin = state.config.auxiliaryKW / 60;
  while (dt > 1e-9 && !m.paused) {
    if (m.dwellMin > 0) {
      const step = Math.min(dt, m.dwellMin);
      m.dwellMin -= step;
      m.elapsedMin += step;
      m.batteryKWh -= auxKWhPerMin * step;
      dt -= step;
      if (m.dwellMin <= 1e-9) {
        const stop = m.stops.find((s) => s.dwelling);
        stop.dwelling = false;
        stop.done = true;
        m.visited.push(stop.id);
        m.phase = 'navigating';
        logEvent(`Science complete: ${targetName(stop.id)}`);
        notify(`Science stop complete: ${targetName(stop.id)}. Continuing.`);
      }
      continue;
    }
    const next = m.stops.find((s) => !s.done);
    const stopAt = next ? next.fraction : 1;
    const minutesToGoal = Math.max(0, (stopAt - legFraction(m)) * m.legDriveMinutes);
    const step = Math.min(dt, minutesToGoal);
    m.drivenMin += step;
    m.elapsedMin += step;
    m.batteryKWh -= (m.driveKWhPerMin + auxKWhPerMin) * step;
    dt -= step;

    if (step >= minutesToGoal - 1e-9) {
      if (next && next.id !== m.finalId) {
        next.dwelling = true;
        m.dwellMin = next.stopMinutes;
        m.phase = 'dwelling';
        syncExactVertex(m);
        logEvent(`Arrived at stop: ${targetName(next.id)} · ${next.stopMinutes} min science`);
        notify(`Arrived at ${targetName(next.id)}: ${next.stopMinutes} min science stop.`);
      } else if (next && !next.dwelling && !next.arrived) {
        // Final destination: dwell there, then arrival.
        next.arrived = true;
        next.dwelling = true;
        m.dwellMin = next.stopMinutes;
        m.phase = 'dwelling';
        m.position = m.path.geometry.at(-1);
        logEvent(`Arrived at destination: ${targetName(next.id)} · ${next.stopMinutes} min science`);
        notify(`Destination reached: ${targetName(next.id)}. ${next.stopMinutes} min science stop.`);
      } else {
        m.position = m.path.geometry.at(-1);
        m.paused = true;
        if (m.leg === 'outbound') { m.phase = 'arrived'; logEvent('Destination science complete. Rover stopped.'); renderArrival(); }
        else { m.phase = 'complete'; logEvent('Base reached. Rover parked beside the lander.'); renderSummary(); }
        return;
      }
    }
    // Reserve warnings (kept visible in the feed).
    const { config } = state;
    const reserveKWh = (config.batteryCapacityKWh * config.batteryReservePercent) / 100;
    if (!m.warnedBattery && m.batteryKWh < reserveKWh + 0.5) { m.warnedBattery = true; logEvent('Warning: battery is close to the required reserve', 'warn'); }
    if (!m.warnedTime && config.missionDurationMinutes - m.elapsedMin < config.minimumTimeReserveMinutes + 5) { m.warnedTime = true; logEvent('Warning: mission time is close to the required reserve', 'warn'); }
    // Budget exhausted: pause (never a negative battery).
    if (m.batteryKWh <= 0 || m.elapsedMin >= config.missionDurationMinutes) {
      m.paused = true;
      m.batteryKWh = Math.max(0, m.batteryKWh);
      logEvent('Mission budget exhausted: simulation paused', 'warn');
      return;
    }
  }
  syncExactVertex(m);
}

// ---------------------------------------------------------------------------
// The animation loop (orbit backdrop, descent, drive view, HUD, radar).
// ---------------------------------------------------------------------------
const canvas = $('world');
const ctx = canvas.getContext('2d');
const radarCtx = $('radar').getContext('2d');
let viewW = innerWidth;
let viewH = innerHeight;
function resizeCanvas() {
  viewW = innerWidth;
  viewH = innerHeight;
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = viewW * dpr;
  canvas.height = viewH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', () => { resizeCanvas(); state.map?.resize(); });
resizeCanvas();

let lastFrame = performance.now();
let hudTimer = 0;
function frame(now) {
  const dtSeconds = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;
  const t = now / 1000;
  const m = state.mission;

  if (m && m.turning) {
    // Stationary turn toward the return heading before driving home.
    const f = Math.min(1, (now - m.turning.start) / (reducedMotion ? 1 : 2200));
    m.yaw = m.turning.from + angleDiff(m.turning.to, m.turning.from) * (f * f * (3 - 2 * f));
    if (f >= 1) { m.turning = null; m.paused = false; m.phase = 'returning'; logEvent('Return initiated: driving home along the recorded traverse'); }
  } else if (m && !m.paused && ['navigating', 'dwelling', 'returning'].includes(m.phase)) {
    advance(dtSeconds * SIM_MINUTES_PER_SECOND * m.speed);
  }

  if (m && m.path && !m.turning) {
    const target = headingAt(m.path, legS(m), 25);
    if (target !== null) m.yaw += angleDiff(target, m.yaw) * Math.min(1, dtSeconds * 3);
  }

  if (state.scene === 'orbit' || state.scene === 'setup') {
    drawOrbit(ctx, viewW, viewH, t);
  } else if ((state.scene === 'descent' || state.scene === 'drive') && m) {
    const descent = state.scene === 'descent' ? Math.min(1, (now - state.descentStart) / (reducedMotion ? 1 : 4000)) : 1;
    if (!$('world').hidden && (state.scene === 'descent' || !state.mapOpenDuringDrive)) {
      const s = legS(m);
      const moving = !m.paused && m.dwellMin <= 0 && !m.turning && ['navigating', 'returning'].includes(m.phase);
      // Chase camera: looks along the route about 60 m ahead of the rover (so
      // the path stays in front), and follows the rover itself while it turns.
      const here = pointAt(m.path, s);
      const ahead = pointAt(m.path, Math.min(m.path.length, s + 60));
      const lookYaw = !m.turning && Math.hypot(ahead.x - here.x, ahead.z - here.z) > 5 ? Math.atan2(ahead.x - here.x, ahead.z - here.z) : m.yaw;
      m.camYaw += angleDiff(lookYaw, m.camYaw) * Math.min(1, dtSeconds * (reducedMotion ? 20 : 5));
      drawSurface(ctx, viewW, viewH, {
        cam: pointAt(m.path, s), yaw: m.camYaw, lean: angleDiff(m.yaw, m.camYaw), descent, path: m.path, s,
        showRoute: m.phase !== 'arrived' && m.phase !== 'complete' && !m.turning,
        stops: stopBeacons(m), lander: { x: 0, z: 0 }, moving, t,
      });
    }
    if (state.scene === 'drive') {
      updateRoverMarker();
      hudTimer += dtSeconds;
      if (hudTimer > 0.12) { hudTimer = 0; updateHud(); }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Beacons: base is drawn as the lander; stops and destination as diamonds.
function stopBeacons(m) {
  return m.stops.map((stop) => {
    const p = pointAt(m.path, stop.s);
    return { x: p.x, z: p.z, label: targetName(stop.id).toUpperCase(), done: stop.done };
  });
}

// ---------------------------------------------------------------------------
// HUD (drive view).
// ---------------------------------------------------------------------------
function renderHud() {
  const m = state.mission;
  $('hudLeg').textContent = m.leg === 'return' ? 'JEZERO · RETURN LEG' : 'JEZERO · OUTBOUND';
  const reserve = parseReserve(m.plan);
  $('reserve').replaceChildren(reserve.minutes === null ? 'Unknown' : `${reserve.minutes >= 0 ? '+' : '−'}${Math.abs(reserve.minutes).toFixed(1)}`, el('small', {}, ' MIN'));
  $('reserveKWh').textContent = reserve.kWh === null ? 'battery margin unknown' : `${reserve.kWh >= 0 ? '+' : '−'}${Math.abs(reserve.kWh).toFixed(2)} kWh after driving home`;
  $('reserve').parentElement.title = reserve.text ?? '';
  const { config } = state;
  $('batteryReserveMark').style.left = `${config.batteryReservePercent}%`;
  $('addStop').hidden = m.leg !== 'outbound';
  updateHud();
}

function updateHud() {
  const m = state.mission;
  if (!m) return;
  const { config } = state;
  const s = legS(m);
  const pct = Math.max(0, Math.min(100, (100 * m.batteryKWh) / config.batteryCapacityKWh));
  $('battery').replaceChildren(pct.toFixed(0), el('small', {}, ' %'));
  $('batteryKWh').textContent = `${Math.max(0, m.batteryKWh).toFixed(2)} of ${config.batteryCapacityKWh} kWh`;
  $('batteryFill').style.width = `${pct}%`;
  $('batteryFill').classList.toggle('low', m.warnedBattery);

  const driving = !m.paused && m.dwellMin <= 0 && !m.turning && ['navigating', 'returning'].includes(m.phase);
  const kmh = m.legDriveMinutes > 0 ? (m.path.length / m.legDriveMinutes) * 0.06 : 0;
  $('speed').textContent = driving ? kmh.toFixed(1) : '0.0';
  $('elapsed').textContent = clock(m.elapsedMin);
  $('timeLeft').textContent = `${Math.max(0, config.missionDurationMinutes - m.elapsedMin).toFixed(1)} MIN LEFT`;
  $('mode').textContent = m.turning ? 'TURNING' : m.phase === 'complete' ? 'AT BASE' : m.phase === 'arrived' ? 'ARRIVED'
    : m.dwellMin > 0 ? 'SCIENCE STOP' : !m.started ? 'STANDBY' : m.paused ? 'PAUSED' : m.leg === 'return' ? 'RETURNING' : 'TRAVERSING';
  $('speedBtn').replaceChildren(`${m.speed}× `, el('span', {}, 'PLAYBACK'));

  // Elevation at the current recorded traverse vertex (null stays Unknown).
  const vertex = m.path.geometry[indexAt(m.path, s)];
  const elevation = vertex && state.elevations ? state.elevations.get(`${vertex[0]},${vertex[1]}`) : undefined;
  $('elevation').replaceChildren(Number.isFinite(elevation) ? elevation.toFixed(1) : 'Unknown', el('small', {}, Number.isFinite(elevation) ? ' m' : ''));

  // Next stop / destination, distance and ETA from the active leg.
  const next = m.stops.find((st) => !st.done);
  const goalS = next ? next.s : m.path.length;
  const remainingM = Math.max(0, goalS - s);
  const etaMin = m.legDriveMinutes > 0 ? (remainingM / Math.max(1, m.path.length)) * m.legDriveMinutes : 0;
  const goalName = m.leg === 'return' ? state.region.base.label.split('(')[0].trim() : next ? targetName(next.id) : targetName(m.finalId);
  $('destinationName').textContent = goalName.toUpperCase();
  $('eta').textContent = `${(remainingM / 1000).toFixed(2)} KM · ETA ${etaMin.toFixed(1)} MIN (SIMULATED)`;

  // Guidance banner.
  let arrow = '↑';
  let instruction = 'Continue';
  let distance = `${(remainingM / 1000).toFixed(2)} km`;
  let sub = `to ${goalName}`;
  if (m.turning) { arrow = '↶'; instruction = 'Turning toward base'; distance = 'Holding position'; sub = 'Aligning the return heading'; }
  else if (!m.started) { arrow = '▷'; instruction = 'Ready'; distance = goalName; sub = 'Press BEGIN DRIVE'; }
  else if (m.phase === 'complete') { arrow = '✓'; instruction = 'Base reached'; distance = 'Welcome home'; sub = 'Rover parked beside the lander'; }
  else if (m.phase === 'arrived') { arrow = '✓'; instruction = 'Destination reached'; distance = targetName(m.finalId); sub = 'Rover stopped · plan the return when ready'; }
  else if (m.dwellMin > 0) { arrow = '◆'; instruction = 'Science stop'; distance = `${m.dwellMin.toFixed(1)} min left`; sub = targetName(m.stops.find((st) => st.dwelling)?.id); }
  else {
    const man = nextManeuver(m.path, s);
    if (man.kind === 'arrive' || remainingM < 20) { arrow = '◎'; instruction = 'Arriving'; distance = `${Math.round(remainingM)} m`; }
    else if (man.kind !== 'continue' && man.distance < remainingM) {
      arrow = man.dir === 'right' ? (man.kind === 'turn' ? '↱' : '↗') : (man.kind === 'turn' ? '↰' : '↖');
      instruction = `${man.kind === 'turn' ? 'Turn' : 'Bear'} ${man.dir}`;
      distance = `in ${Math.round(man.distance)} m`;
      const key = `${man.kind}-${man.dir}`;
      if (key !== m.lastManeuverKey && man.distance < 60) { m.lastManeuverKey = key; if (man.kind === 'turn') logEvent(`${instruction} (path bends)`); }
    } else { m.lastManeuverKey = ''; }
    if (m.paused) sub = 'Paused · press RESUME';
  }
  $('arrow').textContent = arrow;
  $('instruction').textContent = instruction;
  $('turnDistance').textContent = distance;
  $('next').textContent = sub;

  // Controls.
  const done = m.phase === 'arrived' || m.phase === 'complete' || m.turning;
  $('go').disabled = done || m.phase === 'complete';
  $('go').replaceChildren(!m.started ? 'BEGIN DRIVE ' : m.paused ? 'RESUME ' : 'PAUSE ', el('span', {}, !m.started || m.paused ? '▷' : 'Ⅱ'));
  $('addStop').disabled = m.leg !== 'outbound' || m.phase === 'arrived' || !m.started;
  $('home').disabled = m.leg === 'return' || m.phase === 'complete' || !m.started;

  // Trip progress strip.
  const legPct = Math.round(legFraction(m) * 100);
  const names = m.leg === 'return' ? ['DESTINATION', 'BASE'] : ['BASE', targetName(m.finalId).toUpperCase()];
  const stopsText = m.leg === 'outbound' ? m.stops.filter((st) => st.id !== m.finalId).map((st) => `${st.done ? '◆' : '◇'} ${targetName(st.id).toUpperCase()}`).join(' · ') : '';
  $('tripProgress').textContent = m.phase === 'complete' ? 'BASE REACHED · EXPEDITION COMPLETE'
    : m.phase === 'arrived' ? 'DESTINATION REACHED · ROVER STOPPED'
      : `${names[0]} → ${stopsText ? stopsText + ' → ' : ''}${names[1]} · ${legPct}%`;

  // Radar.
  const cam = pointAt(m.path, s);
  const marks = [{ x: 0, z: 0, kind: 'base' }, ...m.stops.map((st) => ({ ...pointAt(m.path, st.s), kind: 'stop', done: st.done }))];
  drawRadar(radarCtx, 360, {
    cam, yaw: m.yaw, rangeM: 450,
    paths: [{ path: m.path, color: '#c3f4df44', fromS: 0, width: 4 }, { path: m.path, color: '#c3f4df', fromS: s, width: 5 }],
    marks,
  });
}

// One-tap controls.
$('go').onclick = () => {
  const m = state.mission;
  if (!m) return;
  if (!m.started) {
    m.started = true;
    m.paused = false;
    m.phase = 'navigating';
    logEvent(`Departed base toward ${targetName(m.stops[0]?.id ?? m.finalId)}`);
  } else {
    m.paused = !m.paused;
    logEvent(m.paused ? 'Paused' : 'Resumed');
  }
  lastFrame = performance.now();
  updateHud();
};
$('speedBtn').onclick = () => {
  const m = state.mission;
  m.speed = PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(m.speed) + 1) % PLAYBACK_SPEEDS.length];
  updateHud();
};
$('addStop').onclick = () => openProposals();
$('home').onclick = () => planReturn('Return to base requested.');
$('openMap').onclick = () => openTrackingMap();
$('radarRecenter').onclick = () => openTrackingMap();
$('backToDrive').onclick = () => closeTrackingMap();

// Rolling, timestamped activity feed (simulated mission time).
function logEvent(message, kind = 'info') {
  const m = state.mission;
  if (!m) return;
  const entry = { time: clock(m.elapsedMin), message, kind };
  m.feed.push(entry);
  const item = el('li', { class: kind }, el('time', {}, `T+${entry.time}`), ' ', message);
  $('feedList').prepend(item);
  $('feedLatest').replaceChildren(el('time', {}, `T+${entry.time}`), ' ', message);
  $('feed').classList.toggle('warn', m.feed.some((e) => e.kind === 'warn'));
  announce(message);
}

// ---------------------------------------------------------------------------
// The 2D map during the drive (same mission state, one tap away).
// ---------------------------------------------------------------------------
function ensureRoverMarker() {
  if (!state.layers.rover) {
    state.layers.rover = L.circleMarker([0, 0], { radius: 8, color: '#ffffff', weight: 3, fillColor: '#ff7a45', fillOpacity: 1 })
      .bindTooltip('Rover (SIMULATED position)')
      .addTo(state.map.getMap());
  }
  updateRoverMarker();
}
function updateRoverMarker() {
  const m = state.mission;
  if (!m || !state.layers.rover) return;
  const p = lonLatAt(m.path, legS(m));
  if (p) state.layers.rover.setLatLng([p[1], p[0]]);
}
function recenterOnRover() {
  const m = state.mission;
  const p = m && lonLatAt(m.path, legS(m));
  if (p) state.map.getMap().setView([p[1], p[0]], Math.max(state.map.getMap().getZoom(), 15));
}
function openTrackingMap() {
  state.mapOpenDuringDrive = true;
  show('drive');
  const m = state.mission;
  $('atlasTitle').textContent = 'Tracking map';
  $('atlasHint').textContent = 'Same simulated mission as the drive view. Yellow: active route. Dashed: return.';
  drawRoute(m.leg === 'return' ? { geometry: [], returnGeometry: m.plan.returnGeometry } : m.plan);
  requestAnimationFrame(() => { state.map.resize(); recenterOnRover(); });
}
function closeTrackingMap() {
  state.mapOpenDuringDrive = false;
  $('atlasTitle').textContent = 'Perseverance traverse';
  $('atlasHint').textContent = 'Drag to follow the traverse. Select a waypoint to see its record, or a science target to plan a trip.';
  $('sectorPanel').classList.remove('revealed');
  show('drive');
}

// HUD side panel (proposals, arrival, return plan).
function setHudPanel(...children) {
  const panel = $('hudPanel');
  if (!children.length) { panel.hidden = true; panel.replaceChildren(); return; }
  panel.replaceChildren(...present(children));
  panel.hidden = false;
  panel.scrollTop = 0;
  requestAnimationFrame(() => panel.querySelector('button')?.focus());
}

// ---------------------------------------------------------------------------
// 7. Add a science stop (engine re-plan from the current vertex).
// ---------------------------------------------------------------------------
const remainingStopIds = (m) => m.stops.filter((s) => !s.done && s.id !== m.finalId).map((s) => s.id);
const currentPoint = (m) => ({ lat: m.position[1], lon: m.position[0] });

function openProposals() {
  const m = state.mission;
  if (!m.paused) logEvent('Paused to review a science stop');
  m.paused = true;
  const planned = new Set([...m.visited, ...m.stops.map((s) => s.id)]);
  const options = [...state.targets.values()].filter((t) => !planned.has(t.id));
  setHudPanel(
    el('p', { class: 'micro' }, 'ADD A SCIENCE STOP · PAUSED'),
    el('h3', {}, 'Which target?'),
    el('p', { class: 'fine' }, 'The engine re-plans from the rover\'s current traverse vertex with the remaining time and battery.'),
    ...(options.length
      ? options.map((t) => el('button', { class: 'option', onclick: () => proposeStop(t.id) },
          el('b', {}, t.name), el('small', {}, `Science ${t.scienceValue}/3 (editorial) · ${t.stopMinutes} min dwell`)))
      : [el('p', {}, 'No other curated targets left.')]),
    el('button', { class: 'text-button', onclick: () => { setHudPanel(); } }, 'Cancel'),
  );
}

async function proposeStop(newId) {
  const m = state.mission;
  const revision = m.routeRevision;
  const here = currentPoint(m);
  const stops = remainingStopIds(m);
  setHudPanel(el('p', { class: 'micro' }, 'ADD A SCIENCE STOP'), el('p', {}, `Asking the route engine about ${targetName(newId)}…`));
  try {
    const current = await api.planRoutes(routeRequest({ origin: here, destination: targetPoint(m.finalId), stopIds: stops }));
    let proposal = await api.planRoutes(routeRequest({ origin: here, destination: targetPoint(newId), stopIds: [...stops, m.finalId] }));
    let order = { stopIds: [...stops, m.finalId], finalId: newId };
    if (proposal && proposal.candidates.length === 0) {
      const onTheWay = await api.planRoutes(routeRequest({ origin: here, destination: targetPoint(m.finalId), stopIds: [...stops, newId] }));
      if (onTheWay && onTheWay.candidates.length > 0) { proposal = onTheWay; order = { stopIds: [...stops, newId], finalId: m.finalId }; }
    }
    if (!current || !proposal || m.routeRevision !== revision) return; // stale
    showProposal(newId, current, proposal, order);
  } catch (error) {
    setHudPanel(el('p', { class: 'error' }, `Route engine error: ${error.message}`),
      el('button', { class: 'enter', onclick: () => proposeStop(newId) }, 'RETRY'),
      el('button', { class: 'text-button', onclick: () => setHudPanel() }, 'Keep current plan'));
  }
}

function showProposal(newId, current, proposal, order) {
  const m = state.mission;
  const target = state.targets.get(newId);
  const now = current.candidates.find((c) => !isDetour(c)) ?? null;
  const best = proposal.candidates.filter((c) => !isDetour(c))[0] ?? null;
  const accepted = best?.feasibility === 'pass';
  const before = parseReserve(now);
  const after = parseReserve(best);
  const tripOf = (c) => (c && [c.driveMinutes, c.stopMinutes, c.returnMinutes].every(Number.isFinite) ? c.driveMinutes + c.stopMinutes + c.returnMinutes : null);
  const problems = best ? problemReasons(best) : [];
  const reserveText = (r) => (r.minutes === null ? 'Unknown' : `${r.minutes >= 0 ? '+' : '−'}${Math.abs(r.minutes).toFixed(1)} min · ${r.kWh === null ? '?' : `${r.kWh >= 0 ? '+' : '−'}${Math.abs(r.kWh).toFixed(2)} kWh`}`);
  if (!accepted) {
    m.rejectedProposals.push({ id: newId, reason: problems[0] ?? proposal.errors[0] ?? 'No feasible route.' });
    logEvent(`Replan rejected: ${target.name} (${best?.feasibility ?? 'no route'})`, 'warn');
  }
  setHudPanel(
    el('p', { class: 'micro' }, 'PROPOSAL · ENGINE RESULT ', tag('DERIVED')),
    el('h3', {}, `Add ${target.name}`),
    el('p', {}, `Science value ${target.scienceValue}/3 `, tag('EDITORIAL'), ` · ${target.stopMinutes} min dwell`),
    el('table', { class: 'compare' },
      el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Current plan'), el('th', {}, 'With this stop'))),
      el('tbody', {},
        el('tr', {}, el('th', {}, 'Trip from here'), el('td', {}, fmt(tripOf(now), 1, 'min')), el('td', {}, fmt(tripOf(best), 1, 'min'))),
        el('tr', {}, el('th', {}, 'Energy from here'), el('td', {}, fmt(now?.totalEnergyKWh, 2, 'kWh')), el('td', {}, fmt(best?.totalEnergyKWh, 2, 'kWh'))),
        el('tr', {}, el('th', {}, 'Return margin'), el('td', {}, reserveText(before)), el('td', { class: after.minutes !== null && after.minutes < 0 ? 'short' : '' }, best ? reserveText(after) : 'No route')),
        el('tr', {}, el('th', {}, 'Science value'), el('td', {}, `${now?.scienceValue ?? '?'}`), el('td', {}, `${best?.scienceValue ?? '?'}`)))),
    best ? el('p', {}, el('span', { class: `verdict ${best.feasibility}` }, best.feasibility.toUpperCase()), ' ',
      accepted ? 'The engine says this stop still leaves enough time and battery to get home.' : 'The engine rejected this change:') : null,
    ...problems.map((r) => el('p', { class: 'error' }, r)),
    ...proposal.errors.map((r) => el('p', { class: 'error' }, r)),
    el('div', { class: 'panel-actions' },
      accepted ? el('button', { class: 'enter', onclick: () => acceptProposal(best, order, newId) }, 'ACCEPT NEW PLAN') : null,
      el('button', { onclick: () => { logEvent(accepted ? `Proposal cancelled: ${target.name}` : 'Kept current plan'); setHudPanel(); } }, accepted ? 'Cancel · keep plan' : 'Keep plan'),
      accepted ? null : el('button', { onclick: () => planReturn('Returning to base instead.') }, '⌂ Return to base')),
  );
}

function acceptProposal(candidate, order, newId) {
  const m = state.mission;
  m.acceptedChanges.push({ id: newId, reserve: findReason(candidate, 'Return reserve:') });
  // The new plan starts at the rover's exact current vertex (its first point).
  loadOutboundLeg(candidate, order.stopIds, order.finalId);
  m.position = candidate.geometry[0];
  m.yaw = headingAt(m.path, 0, 25) ?? m.yaw;
  m.paused = false;
  lastFrame = performance.now();
  logEvent(`Replan accepted: ${targetName(newId)} added`);
  setHudPanel();
  renderHud();
  if (state.mapOpenDuringDrive) drawRoute(candidate);
}

// ---------------------------------------------------------------------------
// 8. Arrival, return to base (engine), mission summary.
// ---------------------------------------------------------------------------
function renderArrival() {
  const m = state.mission;
  const target = state.targets.get(m.finalId);
  setHudPanel(
    el('p', { class: 'micro' }, 'DESTINATION REACHED'),
    el('h3', {}, target.name),
    target.imageUrl ? el('figure', { class: 'waypoint-photo' }, el('img', { src: target.imageUrl, alt: `Perseverance Navcam image, sol ${target.sol}` }),
      el('figcaption', {}, target.imageCredit ?? 'NASA/JPL-Caltech')) : null,
    el('dl', { class: 'waypoint-facts' },
      fact('Mission time used', `${m.elapsedMin.toFixed(1)} min`, 'SIMULATED'),
      fact('Battery left', `${m.batteryKWh.toFixed(2)} kWh`, 'SIMULATED'),
      fact('Stops completed', m.visited.map(targetName).join(', ') || 'none')),
    el('button', { class: 'enter', onclick: () => planReturn('Planning the drive home.') }, 'PLAN RETURN TO BASE ', el('span', {}, '→')),
  );
}

async function planReturn(message) {
  const m = state.mission;
  m.paused = true;
  notify(message);
  setHudPanel(el('p', { class: 'micro' }, 'RETURN TO BASE'), el('p', {}, 'Asking the route engine for the way home…'));
  try {
    const result = await api.planRoutes(routeRequest({ origin: currentPoint(m), destination: basePoint() }));
    if (!result) return;
    const home = result.candidates.find((c) => c.feasibility === 'pass') ?? result.candidates[0];
    if (!home) return setHudPanel(el('h3', {}, 'No way home found'), ...result.errors.map((e) => el('p', { class: 'error' }, e)));
    const reserve = parseReserve(home);
    setHudPanel(
      el('p', { class: 'micro' }, 'RETURN TO BASE · ENGINE PLAN ', tag('DERIVED')),
      el('h3', {}, `→ ${state.region.base.label}`),
      el('p', {}, el('span', { class: `verdict ${home.feasibility}` }, home.feasibility.toUpperCase())),
      el('dl', { class: 'waypoint-facts' },
        fact('Drive home', fmt(home.returnMinutes, 1, 'min'), 'DERIVED'),
        fact('Energy home', fmt(home.returnEnergyKWh, 2, 'kWh'), 'DERIVED'),
        fact('Margin at base', reserve.text ?? 'Unknown', 'DERIVED')),
      ...problemReasons(home).map((r) => el('p', { class: 'error' }, r)),
      el('button', { class: 'enter', onclick: () => startReturn(home) }, 'DRIVE HOME ', el('span', {}, '⌂')),
    );
  } catch (error) {
    setHudPanel(el('h3', {}, 'Route engine error'), el('p', { class: 'error' }, error.message),
      el('button', { class: 'enter', onclick: () => planReturn(message) }, 'TRY AGAIN'));
  }
}

function startReturn(home) {
  const m = state.mission;
  m.returnPlan = home;
  const from = m.yaw;
  loadReturnLeg(home);
  m.phase = 'returning';
  m.paused = true;
  const to = headingAt(m.path, 0, 25) ?? from;
  m.yaw = from;
  m.turning = { from, to, start: performance.now() };
  setHudPanel();
  renderHud();
  if (state.mapOpenDuringDrive) drawRoute({ geometry: [], returnGeometry: home.returnGeometry });
}

function renderSummary() {
  const m = state.mission;
  const { config } = state;
  const science = m.visited.reduce((sum, id) => sum + (state.targets.get(id)?.scienceValue ?? 0), 0);
  setHudPanel();
  $('summaryBody').replaceChildren(
    el('p', { class: 'micro' }, 'MISSION SUMMARY'),
    el('h2', {}, `Welcome home, ${state.callsign}`),
    el('dl', { class: 'waypoint-facts' },
      fact('Science stops', m.visited.map(targetName).join(', ') || 'none'),
      fact('Science value collected', `${science}`, 'EDITORIAL'),
      fact('Mission time used', `${m.elapsedMin.toFixed(1)} of ${config.missionDurationMinutes} min`, 'SIMULATED'),
      fact('Battery left', `${m.batteryKWh.toFixed(2)} kWh (required reserve ${(config.batteryCapacityKWh * config.batteryReservePercent) / 100} kWh)`, 'SIMULATED'),
      fact('Changes accepted', m.acceptedChanges.map((c) => targetName(c.id)).join(', ') || 'none'),
      fact('Proposals rejected by the engine', m.rejectedProposals.map((r) => `${targetName(r.id)}: ${r.reason}`).join(' · ') || 'none')),
    el('p', { class: 'fine' }, 'Simulated scenario on NASA\'s real Perseverance traverse. Not a validated navigation system.'),
    el('button', { class: 'enter', onclick: resetMission }, 'NEW MISSION ', el('span', {}, '↻')),
  );
  $('summaryDialog').showModal();
}

function resetMission() {
  $('summaryDialog').close();
  state.mission = null;
  state.mapOpenDuringDrive = false;
  state.layers.route?.clearLayers();
  if (state.layers.rover) { state.layers.rover.remove(); state.layers.rover = null; }
  $('feedList').replaceChildren();
  $('feedLatest').textContent = '—';
  $('feed').classList.remove('warn');
  setHudPanel();
  closeTrackingMap();
  show('atlas');
  closeInspector();
  state.map?.overview();
}

// ---------------------------------------------------------------------------
// Sources, assumptions and limitations.
// ---------------------------------------------------------------------------
function renderSources() {
  const c = state.config ?? {};
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  $('sourcesBody').replaceChildren(
    el('h2', {}, 'Sources, assumptions & limits'),
    el('h3', {}, 'What the labels mean'),
    el('ul', {},
      el('li', {}, tag('OBSERVED'), ' NASA mission data: traverse, waypoints, coordinates, elevations, images.'),
      el('li', {}, tag('DERIVED'), ' Calculated from that data: route time, energy, scores, verdicts and reserves by our route engine; guidance, distance and current elevation from the real route coordinates.'),
      el('li', {}, tag('SIMULATED'), ' The scenario: base, crew, rover position, elapsed time, battery, speed and ETA.'),
      el('li', {}, tag('EDITORIAL'), ' The team\'s 1-3 science rubric and dwell times.')),
    el('h3', {}, 'Data and images'),
    el('ul', {},
      el('li', {}, 'Perseverance traverse and waypoints: NASA Mars 2020 mission map layers ', link('https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json', 'traverse ↗'), ' ', link('https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json', 'waypoints ↗'), ' (retrieved 13 Nov 2026).'),
      el('li', {}, 'Jezero imagery: ', link('https://trek.nasa.gov/mars/', 'NASA Mars Trek ↗'), ' Jezero CTX mosaic (NASA/JPL-Caltech/MSSS).'),
      el('li', {}, 'Target images: ', link('https://mars.nasa.gov/mars2020/multimedia/raw-images/', 'Perseverance raw images ↗'), ' (NASA/JPL-Caltech) and the links on each target.'),
      el('li', {}, 'Mars globe: ', link('https://science.nasa.gov/resource/mars-planet-globe/', 'NASA ↗'), '. Map library: Leaflet 1.9.4 (BSD-2-Clause). Fonts: Barlow Condensed and Space Grotesk (Google Fonts, OFL).'),
      el('li', {}, 'Challenge: ', link('https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/?tab=details', 'Interplanetary Survival Guide: Martian Map ↗'))),
    el('h3', {}, 'Prototype assumptions (not rover limits)'),
    el('ul', {},
      el('li', {}, `Flat speed ${c.flatSpeedKmh} km/h; slope limit ${c.maxSlopeDegrees}°; mission ${c.missionDurationMinutes} min with a ${c.minimumTimeReserveMinutes} min reserve.`),
      el('li', {}, `Battery ${c.batteryCapacityKWh} kWh with a ${c.batteryReservePercent}% reserve; driving ${c.baselineKWhPerKm} kWh/km; auxiliary ${c.auxiliaryKW} kW (also spent during science stops).`),
      el('li', {}, `Overall score = ${c.terrainWeight} × terrain safety + ${c.timeWeight} × time. Speed slows and energy rises with slope (team brief formulas).`),
      el('li', {}, 'Playback speed (1×/3×/5×/10×/15×; 1× is real time) only changes how fast the simulation runs, never a route cost.')),
    el('h3', {}, 'Limitations'),
    el('ul', {},
      el('li', {}, 'Routes follow where the robotic rover actually drove. That is not a computed crewed-rover route and not proof the ground is safe.'),
      el('li', {}, 'Slopes are along-route rise/run over ~50 m. Cross-slope, rocks and sand traps are not captured.'),
      el('li', {}, 'Elevation units and vertical datum are UNVERIFIED. Missing elevations are shown as Unknown.'),
      el('li', {}, 'Unknown terrain makes a route UNVERIFIED (preview only). It is never scored as safe.'),
      el('li', {}, 'The terrain behind the rover is ILLUSTRATIVE artwork. Only the route ribbon, stop beacons and lander position come from real coordinates.'),
      el('li', {}, 'There is no oxygen, temperature or weather data in this prototype, so none is shown.'),
      el('li', {}, 'The base, crew, rover and its position are a simulated scenario. NASA does not operate this vehicle; nothing here is live telemetry.'),
      el('li', {}, 'No elevation grid was available, so there are no computed alternative routes; one eligible route per target is expected.')),
    el('h3', {}, 'Credits and AI assistance'),
    el('p', {}, 'Rover OS interface design by Naser (team). Parts of the code, tests and documentation were written with AI coding assistants (Claude Code by Anthropic, Codex) under the team\'s direction and review. No images or data were AI-generated.'),
  );
}

$('openSources').onclick = () => { renderSources(); $('sourcesDialog').showModal(); };
$('closeSources').onclick = () => $('sourcesDialog').close();

addEventListener('pagehide', () => state.map?.destroy?.());
renderRegionCards();
loadEverything();
