import { addGeoJsonLayer, createMarsMap } from '../../map.js';

async function loadMapLayer(name) {
  const response = await fetch(`/map-data/${name}.geojson`);
  if (!response.ok) throw new Error(`Cannot load ${name}`);
  return response.json();
}

/** Mount Zain's map with the recorded rover traverse and Zaid's waypoint records. */
export async function mountMarsMap({ container, region, onSelect, onStatus }) {
  const instance = createMarsMap({ container, region });
  const map = instance.getMap();
  map.setMaxZoom(18);

  // The atlas accepts only selections from the recorded waypoint layer.
  map.off('click');
  instance.getLayers().clearLayers();
  map.zoomControl.remove();
  map.setMinZoom(12);
  map.options.maxBoundsViscosity = 0.85;
  const initialCenter = [region.base.lat, region.base.lon];
  const initialZoom = 13;
  map.setView(initialCenter, initialZoom);
  map.attributionControl.remove();

  // Bounds follow the Jezero CTX WMTS matrix at zoom 12. Each tile spans 180 / 4096 degrees.
  const degreesPerTile = 180 / 4096;
  const imageryBounds = [
    [90 - 1631 * degreesPerTile, -180 + 5851 * degreesPerTile],
    [90 - 1625 * degreesPerTile, -180 + 5861 * degreesPerTile]
  ];
  window.L.imageOverlay('/assets/jezero-ctx.png', imageryBounds, {
    alt: 'Mars Reconnaissance Orbiter CTX imagery of Jezero'
  }).addTo(map);

  const waypointById = new Map();
  let selectedMarker = null;
  function selectWaypoint(id) {
    const record = waypointById.get(id);
    if (!record) return;
    const { feature, marker } = record;
    if (selectedMarker) selectedMarker.setStyle({ radius: 6, weight: 1.5, color: '#f5cf97' });
    selectedMarker = marker;
    marker.setStyle({ radius: 9, weight: 3, color: '#d8fff4' });
    marker.bringToFront();
    const [lon, lat] = feature.geometry.coordinates;
    map.flyTo([lat, lon], Math.max(13, map.getZoom()), { duration: 0.7 });
    onSelect({ lat, lon }, feature.properties);
  }

  try {
    const [traverse, waypoints] = await Promise.all([
      loadMapLayer('traverse'),
      loadMapLayer('waypoints')
    ]);
    addGeoJsonLayer(instance, traverse, {
      interactive: false,
      style: { color: '#9df1dc', weight: 3, opacity: 0.9 }
    });
    addGeoJsonLayer(instance, waypoints, {
      pointToLayer(_, latlng) {
        return window.L.circleMarker(latlng, {
          radius: 6,
          color: '#f5cf97',
          weight: 1.5,
          fillColor: '#4e3528',
          fillOpacity: 0.9,
          bubblingMouseEvents: false
        });
      },
      onEachFeature(feature, marker) {
        const { RMC, sol } = feature.properties;
        const label = document.createElement('span');
        label.textContent = `Sol ${sol} · ${RMC}`;
        marker.bindTooltip(label);
        marker.on('click', () => selectWaypoint(RMC));
        waypointById.set(RMC, { feature, marker });
      }
    });
    onStatus(`${waypoints.features.length} NASA waypoints · ${traverse.features.length} recorded traverse segments`);
  } catch (error) {
    onStatus(`Rover data unavailable. ${error.message}`);
  }

  return {
    ...instance,
    waypoints: Array.from(waypointById.values(), ({ feature }) => feature),
    selectWaypoint,
    zoomIn() { map.zoomIn(); },
    zoomOut() { map.zoomOut(); },
    overview() {
      if (selectedMarker) selectedMarker.setStyle({ radius: 6, weight: 1.5, color: '#f5cf97' });
      selectedMarker = null;
      instance.resize();
      map.setView(initialCenter, initialZoom);
    }
  };
}
