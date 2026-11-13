
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

  const { south, west, north, east } = region.bounds;

  if (
    ![south, west, north, east].every(Number.isFinite) ||
    south >= north ||
    west >= east ||
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east >= 180
  ) {
    throw new Error("Invalid region boundaries.");
  }

  const base = {
    lat: region.base.lat,
    lon: region.base.lon
  };

  if (!isInsideRegion(base, region)) {
    throw new Error("Landing site is outside the region boundaries.");
  }

  if (!window.L) {
    throw new Error("Leaflet 1.9.4 must be loaded before creating the map.");
  }

  const L = window.L;

  const regionBounds = L.latLngBounds(
    [south, west],
    [north, east]
  );

  const map = L.map(element, {
    crs: L.CRS.EPSG4326,
    minZoom: 2,
    maxZoom: 10,
    maxBounds: regionBounds,
    maxBoundsViscosity: 1
  });

  map.fitBounds(regionBounds);

  // All map-owned layers are kept in one group.
  const layers = L.layerGroup().addTo(map);

  // This is the region boundary, not verified imagery coverage.
  L.rectangle(regionBounds, {
    color: "#d49b55",
    weight: 2,
    fillColor: "#d49b55",
    fillOpacity: 0.06
  })
    .bindPopup("Jezero region boundary")
    .addTo(layers);

  // Landing-site marker.
  L.circleMarker([base.lat, base.lon], {
    radius: 8,
    color: "#f0b45e",
    weight: 2,
    fillColor: "#f0b45e",
    fillOpacity: 1
  })
    .bindPopup(region.base.label || "Landing site")
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
    ).bindPopup(
      `Selected location<br>Lat: ${point.lat.toFixed(6)}<br>Lon: ${point.lon.toFixed(6)}`
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

// Add a GeoJSON dataset, such as rover paths or waypoints.
export function addGeoJsonLayer(mapInstance, geojson, options = {}) {
  if (!mapInstance || !geojson) {
    throw new Error("Map and GeoJSON data are required.");
  }

  if (typeof mapInstance.getLayers !== "function") {
    throw new Error("Invalid Mars map instance.");
  }

  const L = window.L;

  if (!L) {
    throw new Error("Leaflet must be loaded before adding GeoJSON.");
  }

  return L.geoJSON(geojson, {
    ...options,
    coordsToLatLng(coords) {
      const [lat, lon] = geoJsonToLeaflet(coords);
      return L.latLng(lat, lon);
    }
  }).addTo(mapInstance.getLayers());
}
