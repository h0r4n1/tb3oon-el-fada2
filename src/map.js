
import { isInsideRegion, geoJsonToLeaflet } from "./coordinates.js";

export function createMarsMap({ container, region, onSelect }) {
  const element =
    typeof container === "string"
      ? document.getElementById(container)
      : container;

  if (!element) {
    throw new Error("Mars map container was not found.");
  }

  if (!region?.bounds || !region?.base) {
    throw new Error("Valid region data is required.");
  }

  if (!window.L) {
    throw new Error("Leaflet 1.9.4 must be loaded before creating the map.");
  }

  const L = window.L;
  const { south, west, north, east } = region.bounds;

  const map = L.map(element, {
    crs: L.CRS.EPSG4326,
    minZoom: 2,
    maxZoom: 10,
    maxBounds: [
      [south, west],
      [north, east]
    ],
    maxBoundsViscosity: 1
  });

  const regionBounds = L.latLngBounds(
    [south, west],
    [north, east]
  );

  map.fitBounds(regionBounds);

  // Keep all map-owned layers in one group.
  const layers = L.layerGroup().addTo(map);

  // Region coverage boundary.
  L.rectangle(regionBounds, {
    color: "#d49b55",
    weight: 2,
    fillColor: "#d49b55",
    fillOpacity: 0.06
  }).addTo(layers);

  // Landing-site marker.
  const basePoint = [region.base.lat, region.base.lon];

  L.circleMarker(basePoint, {
    radius: 8,
    color: "#f0b45e",
    weight: 2,
    fillColor: "#f0b45e",
    fillOpacity: 1
  })
    .bindPopup(region.base.label)
    .addTo(layers);

  let selectedMarker = null;

  function handleMapClick(event) {
    const point = {
      lat: event.latlng.lat,
      lon: event.latlng.lng
    };

    if (!isInsideRegion(point, region)) {
      return;
    }

    if (selectedMarker) {
      layers.removeLayer(selectedMarker);
    }

    selectedMarker = L.circleMarker(
      [point.lat, point.lon],
      {
        radius: 7,
        color: "#ffffff",
        weight: 2,
        fillColor: "#36c9ad",
        fillOpacity: 1
      }
    ).addTo(layers);

    if (typeof onSelect === "function") {
      onSelect(point);
    }
  }

  map.on("click", handleMapClick);

  let destroyed = false;

  return {
    resize() {
      if (!destroyed) {
        map.invalidateSize();
      }
    },

    destroy() {
      if (destroyed) return;

      destroyed = true;
      map.off("click", handleMapClick);
      map.remove();
    },

    getMap() {
      return map;
    },

    getLayers() {
      return layers;
    }
  };
}

// Convert a GeoJSON FeatureCollection into Leaflet layers.
export function addGeoJsonLayer(mapInstance, geojson, options = {}) {
  if (!mapInstance || !geojson) {
    throw new Error("Map and GeoJSON data are required.");
  }

  return window.L.geoJSON(geojson, {
    ...options,
    coordsToLatLng(coords) {
      return window.L.latLng(coords[1], coords[0]);
    }
  }).addTo(mapInstance.getLayers());
}
